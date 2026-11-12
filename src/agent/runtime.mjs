import {runBrowserToolLoop} from '../model/tool-loop.mjs';
import {createBrowserModelRequester} from '../model/gateway.mjs';
import {validateAgentTrace,resolveSkillParameters,instantiateSkillRecipe} from './store.mjs';
import {createTaskBudget} from './budget.mjs';
import {createWorkingContext} from './context.mjs';
import {verifyTaskResult} from './verifier.mjs';
import {classifyRecovery} from './recovery-policy.mjs';

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
export function createAgentRuntime({store,getSites,getBrowser,isCurrent,authorize=async()=>true,onUpdate=async()=>{},modelFile,safeError,requesterFactory=createBrowserModelRequester,contextProvider=async()=>({text:''}),onTaskMemory=async()=>{}}) {
  let active=null,startup=null,lastSession=null;
  const checkedSites=async(ids,mode)=>{
    if(!['mock_browser','compatible_browser'].includes(mode)||!Array.isArray(ids)||!ids.length||ids.length>3||new Set(ids).size!==ids.length)throw fail('AGENT_CONFIG_INVALID');
    const available=await getSites();
    return ids.map(id=>{const site=available.find(s=>s.id===id);if(!site || (mode==='mock_browser'?!site.builtin:site.builtin))throw fail('AGENT_SITE_SCOPE');return {id:site.id,origin:site.origin,revision:site.revision};});
  };
  const checkBindings=async(bindings,mode)=>JSON.stringify(await checkedSites(bindings.map(s=>s.id),mode))===JSON.stringify(bindings);
  const lookup=async(id,list)=>{const item=(await list()).find(t=>t.id===id);if(!item)throw fail('AGENT_TASK_NOT_FOUND');return item;};
  const consentFor=(mode,consent)=>{if(mode==='compatible_browser'&&(consent?.taskText!==true||consent?.pageContent!==true))throw fail('PAGE_CONTENT_CONSENT_REQUIRED');return {taskText:true,pageContent:true};};
  async function launch({goal,siteIds,mode,consent,skill,previous,values,budgetOptions={},enableReflection=false}) {
    if(active||startup)throw fail('BUSY');
    let settled;const pending={cancelled:false,settled:new Promise(resolve=>{settled=resolve;})};startup=pending;
    try {
      const accepted=skill?{taskText:false,pageContent:false}:consentFor(mode,consent),siteBindings=await checkedSites(siteIds,mode);
      if((skill&&JSON.stringify(siteBindings)!==JSON.stringify(skill.template.siteBindings)) || (previous&&JSON.stringify(siteBindings)!==JSON.stringify(previous.siteBindings)))throw fail('AGENT_BINDINGS_CHANGED');
      if(previous?.skillId&&(previous.skillVersion??1)!==skill?.version)throw fail('AGENT_SKILL_VERSION_CHANGED');
      const parameterValues=skill?resolveSkillParameters(skill,previous?previous.parameterValues:values):undefined;
      const recipe=skill?instantiateSkillRecipe(skill,parameterValues):null;
      if(typeof enableReflection!=='boolean'||!budgetOptions||typeof budgetOptions!=='object'||Array.isArray(budgetOptions)||Object.keys(budgetOptions).some(key=>key!=='maxModelRequests'))throw fail('AGENT_CONFIG_INVALID');
      if(previous&&!previous.budget)throw fail('AGENT_BUDGET_LEGACY');
      const memory=skill?{text:''}:await contextProvider({goal,siteBindings,consent});
      const recipeMonths=[...new Set((recipe??[]).map(step=>step.value).filter(value=>typeof value==='string'&&/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)))];
      const workingContext=createWorkingContext({goal,siteBindings,memoryText:memory.text??'',memoryRevision:memory.revision??null,parameters:recipeMonths.length===1?{month:recipeMonths[0]}:{}});
      // Configuration/consent validation happens before creating an executable task.
      const requestModel=skill?null:mode==='mock_browser'?createMockRequester({task:goal,siteIds}):await requesterFactory({file:modelFile,consent:accepted});
      if(!isCurrent())throw fail('CANCELLED');
      const task=previous?await store.resumeTask(previous.id):await store.createTask({goal,siteBindings,mode,budget:createTaskBudget({...budgetOptions,skill:!!skill}),contextSummary:workingContext.checkpoint(),...(skill?{skillId:skill.id,skillVersion:skill.version,values:parameterValues}:{})});
      if(pending.cancelled){await store.updateTask(task.id,{status:'cancelled',expectedAttempt:task.attempt});await onUpdate();return {taskId:task.id};}
      const token={id:task.id,abort:new AbortController(),promise:null,session:null,timedOut:false};active=token;
      token.promise=(async()=>{
        // An explicit resume replays read-only steps from fresh observations, not an old DOM cursor.
        const trace=[],steps=[],reflections=[],observations=new Map(),dirty=new Set();let session,timer,lease,startedAt;
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
          const memoryCurrent=typeof memory.check==='function'?await memory.check():true;
          const authorized=valid&&memoryCurrent&&await authorize();
          return authorized&&active===token&&!token.abort.signal.aborted&&isCurrent();
        };
        const check=async()=>{if(!await context())throw fail('AGENT_CONTEXT_CHANGED');};
        const onBudget=async input=>{await check();let claimed;if(input.kind!=='model'||mode!=='mock_browser')claimed=await store.claimBudget(task.id,{...input,expectedAttempt:task.attempt});await check();return claimed;};
        const update=async patch=>{await check();await store.updateTask(task.id,{...patch,expectedAttempt:task.attempt});await onUpdate();await check();};
        const usedCorrections=async()=>{const current=await lookup(task.id,store.listTasks);return current.budget?.used?.corrections??0;};
        const emitReflection=async record=>{
          const index=reflections.findIndex(entry=>entry.id===record.id);if(index<0)reflections.push(record);else reflections[index]=record;
          await update({status:'running',steps:[...steps],trace:[...trace],reflections:[...reflections]});
        };
        const finalizeReflections=async verification=>{
          const pending=reflections.filter(entry=>entry.checkResult==='pending');if(!pending.length)return;
          const checkResult=verification?.status==='verified'?'verified':verification?.status==='needs_review'?'needs_review':'rejected';
          const nextAction=verification?.status==='verified'?'deliver':verification?.status==='needs_review'?'await_user_review':'stop';
          for(const entry of pending){const index=reflections.indexOf(entry);reflections[index]={...entry,checkResult,nextAction};}
          await update({status:'running',steps:[...steps],trace:[...trace],reflections:[...reflections]});
        };
        const append=async entry=>{
          if(trace.length>=100)throw fail('AGENT_TRACE_LIMIT');trace.push(entry);
          if(skill)steps.push({id:`replay-${trace.length}`,label:{open:'打开授权站点',observe:'重新观察页面',select:'选择筛选条件',fill:'填写查询条件',click:'执行只读步骤'}[entry.tool],status:'completed',tool:entry.tool,siteId:entry.siteId});
          await update({status:'running',steps:[...steps],trace:[...trace]});
        };
        const wrapped={
          open:async id=>{await check();if(skill)await onBudget({kind:'tool'});const result=await bounded(session.open(id));await check();dirty.add(id);observations.delete(id);await append({tool:'open',siteId:id});return result;},
          observe:async id=>{await check();if(skill)await onBudget({kind:'tool'});const result=await bounded(session.observe(id));await check();observations.set(id,result);if(result?.text?.trim()&&!result.elements?.some(element=>element.credential))dirty.delete(id);await append({tool:'observe',siteId:id});return result;},
          handoff:async id=>{await check();return bounded(session.handoff(id));},
          act:async(id,action)=>{
            await check();const element=observations.get(id)?.elements.find(e=>e.ref===action.ref);
            if(!element||element.credential)throw Object.assign(fail('STALE_REFERENCE'),{effectState:'not_started'});
            const locator={role:role(element),name:element.label,readOnly:true};
            const entry={tool:action.type,siteId:id,locator,...(action.value!==undefined?{value:action.value}:{})};
            validateAgentTrace([...trace,entry],siteBindings);
            if(skill)await onBudget({kind:'tool'});
            const result=await bounded(session.act(id,action));await check();observations.delete(id);
            dirty.add(id);
            await append(entry);return result;
          }
        };
        try {
          lease=await store.beginBudget(task.id,{expectedAttempt:task.attempt});startedAt=performance.now();
          timer=setTimeout(()=>{token.timedOut=true;token.abort.abort();token.session?.cancel().catch(()=>{});},lease.lease.reservedMs);
          await update({status:'running',steps,trace});session=await getBrowser();token.session=session;lastSession=session;if(token.abort.signal.aborted){await session.cancel();throw fail('CANCELLED');}await check();
          if(previous){
            // New sessions reopen selected sites; old DOM refs/cookies are never persisted.
            for(const id of siteIds){await check();await onBudget({kind:'tool'});await bounded(session.open(id));await check();await onBudget({kind:'tool'});await bounded(session.resume(id));await check();}
          }
          let result;
          if(skill){
            result=await replayRecipe({recipe,browser:wrapped,check,signal:token.abort.signal,getCorrectionsUsed:usedCorrections,onRepair:()=>onBudget({kind:'correction'}),
              onProgress:async replay=>{await update({status:'running',steps:[...steps],trace:[...trace],replay});},
              onRecovery:async replay=>{
                const id=`recovery-${replay.stepIndex}-1`,index=steps.findIndex(step=>step.id===id);
                const status=({recovering:'running',completed:'completed',failed:'failed',awaiting_user:'awaiting_user'}[replay.state]);
                const label=replay.state==='completed'?'页面引用变化，已重新观察并恢复当前步骤':replay.state==='failed'?'当前步骤无法在一次引用恢复后继续':replay.state==='awaiting_user'?'引用恢复遇到登录，请人工接管':'页面引用变化，正在重新观察当前步骤';
                const entry={id,label,status,detail:`第 ${replay.stepIndex+1}/${replay.total} 步；最多恢复 1 次`,tool:replay.tool,siteId:replay.siteId};
                if(index<0)steps.push(entry);else steps[index]=entry;
                const problemCode=replay.reason??'STALE_REFERENCE',handoff=problemCode==='LOGIN_REQUIRED';
                await emitReflection({id:`recovery-reflection-${replay.stepIndex}`,problemCode,evidenceIds:[],
                  proposedCorrection:handoff?'NONE':'REOBSERVE_CURRENT_SITE',
                  checkResult:replay.state==='failed'||handoff?'rejected':'pending',
                  nextAction:replay.state==='failed'||handoff?'stop':'reobserve'});
              }
            });
          }else result=await runBrowserToolLoop({task:goal,allowedSiteIds:siteIds,requiredSiteIds:workingContext.requiredSiteIds,workingContext:workingContext.text,enableReflection,onBudget,onReflection:emitReflection,verifyResult:({evidence=[]})=>verifyTaskResult({mode,context:workingContext,observations,dirtySiteIds:[...dirty],evidence}),consent:accepted,browser:wrapped,requestModel,checkContext:context,signal:token.abort.signal,maxSteps:12,onCheckpoint:async cp=>{
            const id=`step-${cp.step}`,index=steps.findIndex(s=>s.id===id);
            const label=cp.tool?({browser_open:'打开授权站点',browser_observe:'读取当前页面',browser_act:'执行只读页面操作',browser_handoff:'等待用户登录或验证'}[cp.tool]):'整理下一步';
            const status=({planning:'pending',executing:'running',step_completed:'completed',awaiting_review:'completed'}[cp.status]||cp.status);
            const entry={id,label,status,...(cp.tool?{tool:cp.tool,siteId:cp.siteId}:{})};if(index<0)steps.push(entry);else steps[index]=entry;
            await update({status:'running',steps:[...steps],trace:[...trace]});
          }});
          await check();
          let status=result.status==='step_limit'?'interrupted':result.status;
          let verification=result.verification;
          if(skill&&status==='completed'){verification=verifyTaskResult({mode,context:workingContext,observations,dirtySiteIds:[...dirty]});if(verification.status==='rejected')throw fail(verification.code);if(verification.status==='needs_review')status='awaiting_review';}
          if(verification?.status==='rejected')throw fail(verification.code);
          await finalizeReflections(verification);
          const verificationPatch=verification?{status:verification.status,code:verification.code??(verification.status==='verified'?'RESULT_VERIFIED':'USER_RESULT_REVIEW_REQUIRED'),evidenceIds:verification.evidenceIds??[]}:undefined;
          await update({status,steps,trace,reflections:[...reflections],message:result.message.slice(0,2000),...(verificationPatch?{verification:verificationPatch}:{}),...(status==='awaiting_user'?{awaitingSiteId:result.siteId}:{})});
          if(['completed','awaiting_review'].includes(status)&&await context())await onTaskMemory({task:await lookup(task.id,store.listTasks),result:{status,code:verificationPatch?.code,stepCount:steps.length},...(result.reflection?{reflection:structuredClone(result.reflection)}:{})});
        }catch(error){
          await finalizeReflections(null).catch(()=>{});
          const status=token.timedOut?'failed':token.abort.signal.aborted?'cancelled':!isCurrent()?'interrupted':'failed';
          await store.updateTask(task.id,{status,expectedAttempt:task.attempt,error:safeError(token.timedOut?fail('AGENT_TIMEOUT'):error)}).catch(()=>{});
        }finally{clearTimeout(timer);if(lease?.lease)await store.finishBudget(task.id,{expectedAttempt:task.attempt,leaseId:lease.lease.id,elapsedMs:Math.max(0,Math.ceil(performance.now()-startedAt))}).catch(()=>{});if(active===token)active=null;await onUpdate();}
      })();
      await onUpdate();return {taskId:task.id};
    }finally{if(startup===pending)startup=null;settled();}
  }
  return {
    get busy(){return !!active||!!startup;},
    start:input=>launch(input),
    async resume({id,consent,enableReflection=false}){
      const previous=await lookup(id,store.listTasks);
      const skill=previous.skillId?(await store.listSkills()).find(s=>s.id===previous.skillId):null;
      if(previous.skillId&&!skill)throw fail('AGENT_SKILL_NOT_FOUND');
      return launch({goal:previous.goal,siteIds:previous.siteBindings.map(s=>s.id),mode:previous.mode,consent,skill,previous,enableReflection});
    },
    async runSkill({id,mode,consent,values,expectedVersion}){const skill=await lookup(id,store.listSkills);if(expectedVersion!==undefined&&expectedVersion!==skill.version)throw fail('AGENT_SKILL_VERSION_CHANGED');return launch({goal:skill.template.goalTemplate,siteIds:skill.template.siteBindings.map(s=>s.id),mode,consent,skill,values});},
    async saveSkill(input){const task=await lookup(input.taskId,store.listTasks);if(!await checkBindings(task.siteBindings,task.mode))throw fail('AGENT_BINDINGS_CHANGED');return store.saveSkill(input);},
    async confirmResult({id,confirmed,expectedAttempt}){if(active||startup)throw fail('BUSY');const task=await lookup(id,store.listTasks);if(!isCurrent()||!await authorize()||!await checkBindings(task.siteBindings,task.mode)||!isCurrent())throw fail('AGENT_CONTEXT_CHANGED');const result=await store.confirmResult(id,{confirmed,expectedAttempt});await onUpdate();return result;},
    async cleanupHistory(input){if(active||startup)throw fail('BUSY');if(!isCurrent()||!await authorize()||!isCurrent())throw fail('AGENT_CONTEXT_CHANGED');const result=await store.cleanupTasks(input);await onUpdate();return result;},
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
export async function replayRecipe({recipe,browser,check,signal,onProgress=async()=>{},onRecovery=async()=>{},onRepair=async()=>{},getCorrectionsUsed=async()=>0}) {
  if(!Array.isArray(recipe)||!recipe.length)throw fail('AGENT_RESULT_UNVERIFIED');
  let reads=0;const observed=new Map(),dirty=new Set(),total=recipe.length;
  const guard=async()=>{if(signal?.aborted)throw fail('CANCELLED');await check();if(signal?.aborted)throw fail('CANCELLED');};
  const progress=async(state,entry,stepIndex,retries=0,reason)=>{
    const value={stepIndex,total,tool:entry.tool,siteId:entry.siteId,retries,state,...(reason?{reason}:{})};
    await guard();await onProgress(value);await guard();return value;
  };
  const recovery=async(state,entry,index,reason='STALE_REFERENCE')=>{
    const value=await progress(state,entry,index,1,reason);
    await onRecovery(value);await guard();
  };
  const read=async siteId=>{
    await guard();const page=await browser.observe(siteId);await guard();
    if(!page||!Array.isArray(page.elements))throw fail('PAGE_STRUCTURE_CHANGED');
    observed.set(siteId,page);
    if(!page.elements.some(element=>element.credential)){dirty.delete(siteId);reads++;}
    return page;
  };
  const handoff=async(entry,index,retries)=>{
    await progress('awaiting_user',entry,index,retries,'LOGIN_REQUIRED');
    if(retries)await onRecovery({stepIndex:index,total,tool:entry.tool,siteId:entry.siteId,retries,state:'awaiting_user',reason:'LOGIN_REQUIRED'});
    await guard();await browser.handoff(entry.siteId);await guard();
    return {status:'awaiting_user',siteId:entry.siteId,message:'请完成该站点登录或验证，再继续只读工作流。继续时会从新观察安全重放，不使用旧页面引用。'};
  };
  for(let index=0;index<recipe.length;index++){
    const entry=recipe[index];await progress('executing',entry,index);
    if(entry.tool==='open'){
      await guard();await browser.open(entry.siteId);await guard();observed.delete(entry.siteId);dirty.add(entry.siteId);
      await progress('completed',entry,index);continue;
    }
    let page=entry.tool==='observe'||!observed.has(entry.siteId)?await read(entry.siteId):observed.get(entry.siteId);
    if(page.elements.some(element=>element.credential))return handoff(entry,index,0);
    if(entry.tool==='observe'){await progress('completed',entry,index);continue;}
    let retries=0;
    while(true){
      await guard();
      const matches=page.elements.filter(element=>!element.credential&&role(element)===entry.locator.role&&element.label===entry.locator.name);
      if(matches.length!==1){
        if(retries)await recovery('failed',entry,index,'PAGE_STRUCTURE_CHANGED');else await progress('failed',entry,index,0,'PAGE_STRUCTURE_CHANGED');
        throw fail('PAGE_STRUCTURE_CHANGED');
      }
      try{
        await browser.act(entry.siteId,{type:entry.tool,ref:matches[0].ref,...(entry.value!==undefined?{value:entry.value}:{})});
      }catch(error){
        await guard();
        // STALE_REFERENCE is proven before the browser acts; every other failure may have taken effect.
        const effectState=error.effectState??(error.code==='STALE_REFERENCE'?'not_started':'may_have_occurred');
        const decision=classifyRecovery({code:error.code,effectState,correctionsUsed:await getCorrectionsUsed()});
        if(decision.action==='handoff')return handoff(entry,index,retries);
        if(decision.action!=='repair_once'||retries===1){
          if(retries)await recovery('failed',entry,index);else await progress('failed',entry,index);
          throw error;
        }
        await onRepair();await guard();retries=1;observed.delete(entry.siteId);await recovery('recovering',entry,index);
        try{page=await read(entry.siteId);}catch(readError){await recovery('failed',entry,index);throw readError;}
        if(page.elements.some(element=>element.credential))return handoff(entry,index,retries);
        continue;
      }
      await guard();observed.delete(entry.siteId);dirty.add(entry.siteId);
      if(retries)await recovery('completed',entry,index);else await progress('completed',entry,index);
      break;
    }
  }
  // Every controlled navigation/action must have a later non-login observation, including the final action.
  for(const siteId of dirty){
    const index=total-1,entry={tool:'observe',siteId};await progress('executing',entry,index);
    const page=await read(siteId);
    if(page.elements.some(element=>element.credential))return handoff(entry,index,0);
    await progress('completed',entry,index);
  }
  await guard();if(!reads)throw fail('AGENT_RESULT_UNVERIFIED');
  return {status:'completed',message:'已在当前授权站点重新观察并执行个人工作流的只读步骤，并读取最新结果；请核对当前页面。'};
}
