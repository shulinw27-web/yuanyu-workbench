import {runBrowserToolLoop} from '../model/tool-loop.mjs';
import {createBrowserModelRequester} from '../model/gateway.mjs';
import {validateAgentTrace,resolveSkillParameters,instantiateSkillRecipe} from './store.mjs';

const fail=code=>Object.assign(new Error(code),{code});
const role=element=>({input:'textbox',textarea:'textbox',select:'combobox',a:'link',button:'button'}[element.tag] || element.role);
const call=(name,input)=>({tool_calls:[{id:'mock-browser-step',type:'function',function:{name,arguments:JSON.stringify(input)}}]});

// A deterministic synthetic driver, explicitly separate from real model understanding.
export function createMockRequester({task,siteIds}) {
  const months=[...new Set(task.match(/\d{4}-\d{2}/g)||[])];
  if(months.length>1 || months.length===1&&!['2026-09','2026-10'].includes(months[0]))throw fail('AGENT_MOCK_SCOPE');
  const month=months[0] || '2026-10';
  if(siteIds.length!==1 || siteIds[0]!=='interactive-mock' || !/合成|演示|mock/i.test(task))throw fail('AGENT_MOCK_SCOPE');
  let phase='open';
  return async({messages})=>{
    const siteId=siteIds[0],last=[...messages].reverse().find(m=>m.role==='tool');
    const page=last?JSON.parse(last.content):null;
    if(phase==='open'){phase='observe';return call('browser_open',{siteId});}
    if(phase==='observe'){phase='inspect';return call('browser_observe',{siteId});}
    if(phase==='inspect'){
      if(page?.elements?.some(e=>e.credential))return call('browser_handoff',{siteId});
      const select=page?.elements?.find(e=>role(e)==='combobox');
      if(!select)throw fail('PAGE_STRUCTURE_CHANGED');
      phase='after-select';return call('browser_act',{siteId,action:{type:'select',ref:select.ref,value:month}});
    }
    if(phase==='after-select'){phase='filter';return call('browser_observe',{siteId});}
    if(phase==='filter'){
      const button=page?.elements?.find(e=>e.label==='筛选合成记录');if(!button)throw fail('PAGE_STRUCTURE_CHANGED');
      phase='after-filter';return call('browser_act',{siteId,action:{type:'click',ref:button.ref}});
    }
    if(phase==='after-filter'){phase='result';return call('browser_observe',{siteId});}
    const record=month==='2026-09'?'SYN-091':'SYN-101',cents=month==='2026-09'?9087:12345;
    if(!page?.text?.includes(record)||!page.text.includes(String(cents)))throw fail('AGENT_RESULT_UNVERIFIED');
    return {content:`本机合成演示：已从实际网页读取 ${month}，单号 ${record}，金额 ${cents} 分。仅覆盖此合成站点，没有提交业务修改。`};
  };
}

/** One owner's trusted runtime. IPC supplies goals and site IDs, never recipes or page selectors. */
export function createAgentRuntime({store,getSites,getBrowser,isCurrent,authorize=async()=>true,onUpdate=async()=>{},modelFile,safeError,requesterFactory=createBrowserModelRequester}) {
  let active=null,startup=null,lastSession=null;
  const checkedSites=async(ids,mode)=>{
    if(!['mock_browser','compatible_browser'].includes(mode)||!Array.isArray(ids)||!ids.length||ids.length>3||new Set(ids).size!==ids.length)throw fail('AGENT_CONFIG_INVALID');
    const available=await getSites();
    return ids.map(id=>{const site=available.find(s=>s.id===id);if(!site || (mode==='mock_browser'?!site.builtin:site.builtin))throw fail('AGENT_SITE_SCOPE');return {id:site.id,origin:site.origin,revision:site.revision};});
  };
  const checkBindings=async(bindings,mode)=>JSON.stringify(await checkedSites(bindings.map(s=>s.id),mode))===JSON.stringify(bindings);
  const lookup=async(id,list)=>{const item=(await list()).find(t=>t.id===id);if(!item)throw fail('AGENT_TASK_NOT_FOUND');return item;};
  const consentFor=(mode,consent)=>{if(mode==='compatible_browser'&&(consent?.taskText!==true||consent?.pageContent!==true))throw fail('PAGE_CONTENT_CONSENT_REQUIRED');return {taskText:true,pageContent:true};};
  async function launch({goal,siteIds,mode,consent,skill,previous,values}) {
    if(active||startup)throw fail('BUSY');
    let settled;const pending={cancelled:false,settled:new Promise(resolve=>{settled=resolve;})};startup=pending;
    try {
      const accepted=consentFor(mode,consent),siteBindings=await checkedSites(siteIds,mode);
      if((skill&&JSON.stringify(siteBindings)!==JSON.stringify(skill.template.siteBindings)) || (previous&&JSON.stringify(siteBindings)!==JSON.stringify(previous.siteBindings)))throw fail('AGENT_BINDINGS_CHANGED');
      if(previous?.skillId&&(previous.skillVersion??1)!==skill?.version)throw fail('AGENT_SKILL_VERSION_CHANGED');
      const parameterValues=skill?resolveSkillParameters(skill,previous?previous.parameterValues:values):undefined;
      const recipe=skill?instantiateSkillRecipe(skill,parameterValues):null;
      // Configuration/consent validation happens before creating an executable task.
      const requestModel=skill?null:mode==='mock_browser'?createMockRequester({task:goal,siteIds}):await requesterFactory({file:modelFile,consent:accepted});
      if(!isCurrent())throw fail('CANCELLED');
      const task=previous?await store.resumeTask(previous.id):await store.createTask({goal,siteBindings,mode,...(skill?{skillId:skill.id,skillVersion:skill.version,values:parameterValues}:{})});
      if(pending.cancelled){await store.updateTask(task.id,{status:'cancelled',expectedAttempt:task.attempt});await onUpdate();return {taskId:task.id};}
      const token={id:task.id,abort:new AbortController(),promise:null,session:null,timedOut:false};active=token;
      token.promise=(async()=>{
        // An explicit resume replays read-only steps from fresh observations, not an old DOM cursor.
        const trace=[],steps=[],observations=new Map();let session;
        const timer=setTimeout(()=>{token.timedOut=true;token.abort.abort();token.session?.cancel().catch(()=>{});},45000);
        const bounded=promise=>new Promise((resolve,reject)=>{
          const stop=()=>{token.abort.signal.removeEventListener('abort',stop);reject(fail(token.timedOut?'AGENT_TIMEOUT':'CANCELLED'));};
          if(token.abort.signal.aborted){stop();return;}
          token.abort.signal.addEventListener('abort',stop,{once:true});
          Promise.resolve(promise).then(value=>{token.abort.signal.removeEventListener('abort',stop);token.abort.signal.aborted?stop():resolve(value);},error=>{token.abort.signal.removeEventListener('abort',stop);reject(error);});
        });
        const context=async()=>{
          if(active!==token||token.abort.signal.aborted||!isCurrent())return false;
          const valid=await checkBindings(siteBindings,mode);
          const currentSkill=skill?(await store.listSkills()).find(entry=>entry.id===skill.id):null;
          if(skill&&currentSkill?.version!==skill.version)return false;
          const authorized=valid&&await authorize();
          return authorized&&active===token&&!token.abort.signal.aborted&&isCurrent();
        };
        const check=async()=>{if(!await context())throw fail('AGENT_CONTEXT_CHANGED');};
        const update=async patch=>{await check();await store.updateTask(task.id,{...patch,expectedAttempt:task.attempt});await onUpdate();await check();};
        const append=async entry=>{
          if(trace.length>=100)throw fail('AGENT_TRACE_LIMIT');trace.push(entry);
          if(skill)steps.push({id:`replay-${trace.length}`,label:{open:'打开授权站点',observe:'重新观察页面',select:'选择筛选条件',fill:'填写查询条件',click:'执行只读步骤'}[entry.tool],status:'completed',tool:entry.tool,siteId:entry.siteId});
          await update({status:'running',steps:[...steps],trace:[...trace]});
        };
        const wrapped={
          open:async id=>{await check();const result=await bounded(session.open(id));await check();await append({tool:'open',siteId:id});return result;},
          observe:async id=>{await check();const result=await bounded(session.observe(id));await check();observations.set(id,result);await append({tool:'observe',siteId:id});return result;},
          handoff:async id=>{await check();return bounded(session.handoff(id));},
          act:async(id,action)=>{
            await check();const element=observations.get(id)?.elements.find(e=>e.ref===action.ref);
            if(!element||element.credential)throw fail('STALE_REFERENCE');
            const locator={role:role(element),name:element.label,readOnly:true};
            const entry={tool:action.type,siteId:id,locator,...(action.value!==undefined?{value:action.value}:{})};
            validateAgentTrace([...trace,entry],siteBindings);
            const result=await bounded(session.act(id,action));await check();observations.delete(id);
            await append(entry);return result;
          }
        };
        try {
          await update({status:'running',steps,trace});session=await getBrowser();token.session=session;lastSession=session;if(token.abort.signal.aborted){await session.cancel();throw fail('CANCELLED');}await check();
          if(previous){
            // New sessions reopen selected sites; old DOM refs/cookies are never persisted.
            for(const id of siteIds){await check();await bounded(session.open(id));await check();await bounded(session.resume(id));await check();}
          }
          let result;
          if(skill){
            result=await replayRecipe({recipe,browser:wrapped,check,signal:token.abort.signal});
          }else result=await runBrowserToolLoop({task:goal,allowedSiteIds:siteIds,consent:accepted,browser:wrapped,requestModel,checkContext:context,signal:token.abort.signal,maxSteps:12,onCheckpoint:async cp=>{
            const id=`step-${cp.step}`,index=steps.findIndex(s=>s.id===id);
            const label=cp.tool?({browser_open:'打开授权站点',browser_observe:'读取当前页面',browser_act:'执行只读页面操作',browser_handoff:'等待用户登录或验证'}[cp.tool]):'整理下一步';
            const status=({planning:'pending',executing:'running',step_completed:'completed'}[cp.status]||cp.status);
            const entry={id,label,status,...(cp.tool?{tool:cp.tool,siteId:cp.siteId}:{})};if(index<0)steps.push(entry);else steps[index]=entry;
            await update({status:'running',steps:[...steps],trace:[...trace]});
          }});
          await check();
          const status=result.status==='step_limit'?'interrupted':result.status;
          await update({status,steps,trace,message:result.message.slice(0,2000),...(status==='awaiting_user'?{awaitingSiteId:result.siteId}:{})});
        }catch(error){
          const status=token.timedOut?'failed':token.abort.signal.aborted?'cancelled':!isCurrent()?'interrupted':'failed';
          await store.updateTask(task.id,{status,expectedAttempt:task.attempt,error:safeError(token.timedOut?fail('AGENT_TIMEOUT'):error)}).catch(()=>{});
        }finally{clearTimeout(timer);if(active===token)active=null;await onUpdate();}
      })();
      await onUpdate();return {taskId:task.id};
    }finally{if(startup===pending)startup=null;settled();}
  }
  return {
    get busy(){return !!active||!!startup;},
    start:input=>launch(input),
    async resume({id,consent}){
      const previous=await lookup(id,store.listTasks);
      const skill=previous.skillId?(await store.listSkills()).find(s=>s.id===previous.skillId):null;
      if(previous.skillId&&!skill)throw fail('AGENT_SKILL_NOT_FOUND');
      return launch({goal:previous.goal,siteIds:previous.siteBindings.map(s=>s.id),mode:previous.mode,consent,skill,previous});
    },
    async runSkill({id,mode,consent,values,expectedVersion}){const skill=await lookup(id,store.listSkills);if(expectedVersion!==undefined&&expectedVersion!==skill.version)throw fail('AGENT_SKILL_VERSION_CHANGED');return launch({goal:skill.template.goalTemplate,siteIds:skill.template.siteBindings.map(s=>s.id),mode,consent,skill,values});},
    async saveSkill(input){const task=await lookup(input.taskId,store.listTasks);if(!await checkBindings(task.siteBindings,task.mode))throw fail('AGENT_BINDINGS_CHANGED');return store.saveSkill(input);},
    async cancel(id){
      const pending=startup;if(pending){pending.cancelled=true;await pending.settled;}
      const token=active;
      if(token){if(id&&id!==token.id)throw fail('AGENT_TASK_NOT_FOUND');token.abort.abort();await store.updateTask(token.id,{status:'cancelled'}).catch(()=>{});await token.session?.cancel();await token.promise;}
      else if(id){const task=await lookup(id,store.listTasks);if(!['awaiting_user','interrupted'].includes(task.status))throw fail('AGENT_TASK_NOT_CANCELLABLE');if(task.status==='awaiting_user')await store.updateTask(id,{status:'cancelled'});else {const resumed=await store.resumeTask(id);await store.updateTask(id,{status:'cancelled',expectedAttempt:resumed.attempt});}for(const site of task.siteBindings)await lastSession?.cancel(site.id);}
      await onUpdate();return {cancelled:!!token||!!id||!!pending};
    },
    async waitForIdle(){await startup?.settled;await active?.promise;}
  };
}

// Replay resolves a fresh unique accessible locator, never a stale ref or arbitrary selector.
export async function replayRecipe({recipe,browser,check,signal}) {
  let reads=0;const observed=new Map();
  for(const entry of recipe){
    if(signal?.aborted)throw fail('CANCELLED');await check();
    if(entry.tool==='open'){await browser.open(entry.siteId);observed.delete(entry.siteId);continue;}
    const page=entry.tool==='observe'||!observed.has(entry.siteId)?await browser.observe(entry.siteId):observed.get(entry.siteId);
    if(page.elements.some(e=>e.credential)){await browser.handoff(entry.siteId);return {status:'awaiting_user',siteId:entry.siteId,message:'请完成该站点登录或验证，再继续只读工作流。'};}
    reads++;
    if(entry.tool==='observe'){observed.set(entry.siteId,page);continue;}
    const matches=page.elements.filter(e=>!e.credential&&role(e)===entry.locator.role&&e.label===entry.locator.name);
    if(matches.length!==1)throw fail('PAGE_STRUCTURE_CHANGED');
    await browser.act(entry.siteId,{type:entry.tool,ref:matches[0].ref,...(entry.value!==undefined?{value:entry.value}:{})});
    observed.delete(entry.siteId);
  }
  if(!reads)throw fail('AGENT_RESULT_UNVERIFIED');
  return {status:'completed',message:'已在当前授权站点重新观察并执行个人工作流的只读步骤；页面数据可能已变化，请核对当前结果。'};
}
