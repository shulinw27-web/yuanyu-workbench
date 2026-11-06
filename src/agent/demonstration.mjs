import {validateAgentTrace} from './store.mjs';
import {sanitizeBrowserText} from '../browser/interactive-policy.mjs';

const fail=code=>Object.assign(new Error(code),{code});
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const closed=(input,names)=>{if(!plain(input)||Object.keys(input).some(key=>!names.includes(key)))throw fail('DEMONSTRATION_INPUT_INVALID');};
const role=element=>({input:'textbox',textarea:'textbox',select:'combobox',a:'link',button:'button'}[element.tag]||element.role);
const clone=value=>structuredClone(value);

function candidates(page,siteId,siteBindings){
  if(page.elements.some(element=>element.credential))return [];
  return page.elements.flatMap(element=>{
    if(element.credential||element.readOnly||typeof element.ref!=='string')return [];
    const kind=role(element),name=element.label;
    let action;
    if(['button','link'].includes(kind)&&['read','search','filter'].includes(element.action))action='click';
    if(kind==='combobox'&&element.tag==='select')action='select';
    if(kind==='textbox'&&(element.tag==='textarea'||element.tag==='input'&&['text','search','url','tel','number','date','month','time','datetime-local'].includes(element.type)))action='fill';
    if(!action)return [];
    try{validateAgentTrace([{tool:action,siteId,locator:{role:kind,name,readOnly:true},...(action==='click'?{}:{value:''})}],siteBindings);}catch{return [];}
    // A replay must be able to resolve this accessible locator uniquely.
    if(page.elements.filter(other=>!other.credential&&role(other)===kind&&other.label===name).length!==1)return [];
    return [{ref:element.ref,role:kind,name,actionKinds:[action],...(action==='select'?{options:(element.options??[]).filter(option=>typeof option?.label==='string').slice(0,100).map(option=>({label:sanitizeBrowserText(option.label,[],120)}))}:{})}];
  });
}

/** Guided read-only demonstrations. Pages/refs live only here, never in the persistent task or skill. */
export function createDemonstration({store,getSites,getBrowser,authorize=async()=>true,isCurrent,onUpdate=async()=>{},safeError=error=>({code:error.code??'DEMONSTRATION_FAILED',message:'示范未完成，请检查当前页面。'}),timeoutMs=20000}){
  if(!store||typeof getSites!=='function'||typeof getBrowser!=='function'||typeof isCurrent!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>60000)throw fail('DEMONSTRATION_CONFIG_INVALID');
  let current=null,pending=null;
  const snapshot=()=>{
    const token=current;if(!token||token.cancelled||!isCurrent())return null;
    const page=token.pages.get(token.currentSiteId);
    return {taskId:token.task.id,mode:token.task.mode,status:token.task.status==='awaiting_user'?'awaiting_user':'recording',siteIds:token.bindings.map(site=>site.id),currentSiteId:token.currentSiteId,page:page?clone(page):null,canFinish:token.task.status==='running'&&token.actions>0&&token.dirty.size===0&&!!page&&!page.loginRequired,operationPending:!!pending};
  };
  const early=(token,operation)=>{
    if(operation?.cancelled||operation?.abort.signal.aborted||token?.cancelled)throw fail(operation?.timedOut?'DEMONSTRATION_TIMEOUT':'CANCELLED');
    if(!isCurrent()||token&&current!==token)throw fail('AGENT_CONTEXT_CHANGED');
  };
  const context=async(token,operation)=>{
    early(token,operation);
    try{
      const allowed=await bounded(authorize(),operation);early(token,operation);if(allowed!==true)throw fail('AUTH_REQUIRED');
      const sites=await bounded(getSites(),operation);early(token,operation);
      if(!Array.isArray(sites)||token&&!token.bindings.every(binding=>sites.some(site=>site.id===binding.id&&site.origin===binding.origin&&site.revision===binding.revision&&(token.task.mode==='mock_browser'?site.builtin:!site.builtin))))throw fail('AGENT_BINDINGS_CHANGED');
      const stillAllowed=await bounded(authorize(),operation);early(token,operation);if(stillAllowed!==true)throw fail('AUTH_REQUIRED');
      return sites;
    }catch(cause){const error=fail(typeof cause?.code==='string'?cause.code:'AGENT_CONTEXT_CHANGED');error.contextLost=true;throw error;}
  };
  const bounded=(promise,operation)=>new Promise((resolve,reject)=>{
    const stop=()=>{operation.abort.signal.removeEventListener('abort',stop);reject(fail(operation.timedOut?'DEMONSTRATION_TIMEOUT':'CANCELLED'));};
    if(operation.abort.signal.aborted){stop();return;}
    operation.abort.signal.addEventListener('abort',stop,{once:true});
    Promise.resolve(promise).then(value=>{operation.abort.signal.removeEventListener('abort',stop);operation.abort.signal.aborted?stop():resolve(value);},error=>{operation.abort.signal.removeEventListener('abort',stop);reject(error);});
  });
  async function persist(token,patch,operation){
    await context(token,operation);
    const updated=await bounded(store.updateTask(token.task.id,{...patch,expectedAttempt:token.task.attempt}),operation);
    early(token,operation);token.task=updated;await context(token,operation);
  }
  async function append(token,entry,operation){
    const trace=validateAgentTrace([...token.task.trace,entry],token.bindings);
    const labels={open:'打开示范站点',observe:'观察当前页面',click:'示范只读点击',fill:'示范填写查询条件',select:'示范选择筛选条件'};
    const steps=[...token.task.steps,{id:`demo-${trace.length}`,label:labels[entry.tool],status:'completed',tool:entry.tool,siteId:entry.siteId}];
    await persist(token,{status:'running',steps,trace},operation);
  }
  async function closeSites(token){
    // Cleanup cannot retain the workspace lock forever if an adapter stops responding.
    for(const siteId of token.opened){let timer;try{await Promise.race([Promise.resolve().then(()=>token.browser?.cancel(siteId)).catch(()=>{}),new Promise(resolve=>{timer=setTimeout(resolve,Math.min(timeoutMs,1000));})]);}finally{clearTimeout(timer);}}
  }
  async function notifyQuietly(){let timer;try{await Promise.race([Promise.resolve().then(onUpdate).catch(()=>{}),new Promise(resolve=>{timer=setTimeout(resolve,Math.min(timeoutMs,1000));})]);}finally{clearTimeout(timer);}}
  async function stop(token,status,error){
    if(!token)return;
    token.cancelled=true;token.pages.clear();
    try{await store.invalidateDemonstration(token.task.id,{status,expectedAttempt:token.task.attempt,...(error?{error:safeError(error)}:{})});}
    catch(cause){if(cause.code!=='AGENT_TASK_NOT_FOUND')throw cause;}
    finally{await closeSites(token);if(current===token)current=null;}
  }
  function run(id,callback,{starting=false}={}){
    if(pending)throw fail('BUSY');
    if(starting?!!current:!current||current.task.id!==id)throw fail(starting?'DEMONSTRATION_ACTIVE':'DEMONSTRATION_NOT_ACTIVE');
    const operation={cancelled:false,timedOut:false,abort:new AbortController(),promise:null};pending=operation;
    const timer=setTimeout(()=>{operation.timedOut=true;operation.abort.abort();if(current)void closeSites(current);},timeoutMs);
    operation.promise=(async()=>{
      try{
        await bounded(onUpdate(),operation);await context(starting?null:current,operation);
        return await callback(operation);
      }catch(error){
        if(current&&(starting||error.contextLost||operation.abort.signal.aborted||operation.cancelled||['AUTH_REQUIRED','AGENT_CONTEXT_CHANGED','AGENT_BINDINGS_CHANGED'].includes(error.code)))await stop(current,operation.cancelled?'cancelled':operation.timedOut||starting&&!error.contextLost?'failed':'interrupted',error);
        throw error;
      }finally{clearTimeout(timer);if(pending===operation)pending=null;await notifyQuietly();}
    })();
    return operation.promise;
  }
  function requireRecording(token){if(token.task.status!=='running')throw fail('DEMONSTRATION_RESUME_REQUIRED');}
  async function ensureOpen(token,siteId,operation){
    if(!token.bindings.some(site=>site.id===siteId))throw fail('AGENT_SITE_SCOPE');
    token.currentSiteId=siteId;
    if(token.opened.has(siteId))return true;
    await context(token,operation);
    token.opened.add(siteId);token.dirty.add(siteId);
    const state=await bounded(token.browser.open(siteId),operation);early(token,operation);await context(token,operation);
    await append(token,{tool:'open',siteId},operation);
    if(state.mode==='manual'){await persist(token,{status:'awaiting_user',awaitingSiteId:siteId},operation);return false;}
    return true;
  }
  async function readPage(token,siteId,operation){
    await context(token,operation);token.pages.delete(siteId);token.dirty.add(siteId);
    const page=await bounded(token.browser.observe(siteId),operation);await context(token,operation);
    if(!page||typeof page.text!=='string'||!Array.isArray(page.elements)||page.elements.length>100)throw fail('DEMONSTRATION_PAGE_INVALID');
    const loginRequired=page.elements.some(element=>element.credential);
    const view={siteId,title:sanitizeBrowserText(page.title??'',[],200),text:loginRequired?'请在独立浏览器完成登录或验证，返回工作台继续。':sanitizeBrowserText(page.text,[],12000),elements:candidates(page,siteId,token.bindings),loginRequired};
    await append(token,{tool:'observe',siteId},operation);
    token.pages.set(siteId,view);if(!loginRequired)token.dirty.delete(siteId);
    return view;
  }
  const comparable=page=>JSON.stringify({title:page?.title,text:page?.text,loginRequired:page?.loginRequired,elements:page?.elements.map(({ref,...element})=>element)});
  return {
    get active(){return !!current||!!pending;},get busy(){return !!pending;},snapshot,
    start(input){
      closed(input,['goal','siteIds','mode']);
      return run(null,async operation=>{
        if(!['mock_browser','compatible_browser'].includes(input.mode)||!Array.isArray(input.siteIds)||input.siteIds.length<1||input.siteIds.length>3||new Set(input.siteIds).size!==input.siteIds.length)throw fail('DEMONSTRATION_INPUT_INVALID');
        const sites=await context(null,operation);
        const bindings=input.siteIds.map(id=>{const site=sites.find(site=>site.id===id);if(!site||(input.mode==='mock_browser'?!site.builtin:site.builtin))throw fail('AGENT_SITE_SCOPE');return {id:site.id,origin:site.origin,revision:site.revision};});
        const creation=store.createTask({goal:input.goal,siteBindings:bindings,mode:input.mode,execution:'demonstration'});
        void creation.then(task=>{if(operation.abort.signal.aborted)return store.invalidateDemonstration(task.id,{expectedAttempt:task.attempt,status:operation.timedOut?'failed':'cancelled'});}).catch(()=>{});
        const task=await bounded(creation,operation);
        const token={task,bindings,currentSiteId:bindings[0].id,browser:null,opened:new Set(),pages:new Map(),dirty:new Set(),actions:0,cancelled:false};current=token;
        await context(token,operation);token.browser=await bounded(getBrowser(),operation);await context(token,operation);
        if(await ensureOpen(token,token.currentSiteId,operation))await readPage(token,token.currentSiteId,operation);
        return snapshot();
      },{starting:true});
    },
    observe(input){closed(input,['id','siteId']);return run(input.id,async operation=>{const token=current;requireRecording(token);if(await ensureOpen(token,input.siteId,operation))await readPage(token,input.siteId,operation);return snapshot();});},
    act(input){
      closed(input,['id','siteId','action']);closed(input.action,['type','ref','value']);
      return run(input.id,async operation=>{
        const token=current;requireRecording(token);
        const page=token.pages.get(input.siteId),element=page?.elements.find(element=>element.ref===input.action.ref);
        if(!element||page.loginRequired||input.siteId!==token.currentSiteId||!element.actionKinds.includes(input.action.type))throw fail('STALE_REFERENCE');
        const entry={tool:input.action.type,siteId:input.siteId,locator:{role:element.role,name:element.name,readOnly:true},...(input.action.value!==undefined?{value:input.action.value}:{})};
        validateAgentTrace([...token.task.trace,entry],token.bindings);
        await context(token,operation);token.pages.delete(input.siteId);token.dirty.add(input.siteId);
        await bounded(token.browser.act(input.siteId,clone(input.action)),operation);await context(token,operation);
        await append(token,entry,operation);token.actions++;
        await readPage(token,input.siteId,operation);return snapshot();
      });
    },
    handoff(input){closed(input,['id','siteId']);return run(input.id,async operation=>{
      const token=current;requireRecording(token);if(!token.opened.has(input.siteId))throw fail('AGENT_SITE_SCOPE');
      token.currentSiteId=input.siteId;token.pages.clear();for(const id of token.opened)token.dirty.add(id);
      await context(token,operation);await bounded(token.browser.handoff(input.siteId),operation);await context(token,operation);
      await persist(token,{status:'awaiting_user',awaitingSiteId:input.siteId},operation);return snapshot();
    });},
    resume(input){closed(input,['id']);return run(input.id,async operation=>{
      const token=current;if(token.task.status!=='awaiting_user')throw fail('DEMONSTRATION_NOT_PAUSED');
      await context(token,operation);token.task=await store.resumeTask(token.task.id,{execution:'demonstration'});await context(token,operation);
      await bounded(token.browser.resume(token.currentSiteId),operation);await context(token,operation);
      await readPage(token,token.currentSiteId,operation);return snapshot();
    });},
    finish(input){closed(input,['id','confirmed']);return run(input.id,async operation=>{
      const token=current;requireRecording(token);if(input.confirmed!==true)throw fail('DEMONSTRATION_CONFIRMATION_REQUIRED');
      if(!snapshot().canFinish)throw fail('DEMONSTRATION_RESULT_UNVERIFIED');
      let changed=false;
      for(const siteId of token.opened){const previous=comparable(token.pages.get(siteId));const fresh=await readPage(token,siteId,operation);if(previous!==comparable(fresh))changed=true;}
      if(!snapshot().canFinish)throw fail('DEMONSTRATION_RESULT_UNVERIFIED');
      if(changed)throw fail('DEMONSTRATION_RESULT_CHANGED');
      await persist(token,{status:'completed',message:'已由本人核对完成受控只读示范，可保存为个人浏览器工作流；未录制登录操作或网页原文。'},operation);
      const taskId=token.task.id;token.pages.clear();await closeSites(token);if(current===token)current=null;
      return {taskId,status:'completed'};
    });},
    async cancel(input={}){
      closed(input,['id']);
      if(input.id&&pending&&!current)throw fail('DEMONSTRATION_NOT_ACTIVE');
      if(current&&input.id&&input.id!==current.task.id)throw fail('DEMONSTRATION_NOT_ACTIVE');
      const operation=pending,token=current;if(operation){operation.cancelled=true;operation.abort.abort();}if(token){token.cancelled=true;await closeSites(token);}
      await operation?.promise.catch(()=>{});if(current===token&&token)await stop(token,'cancelled');
      if(!token&&input.id){const task=(await store.listTasks()).find(task=>task.id===input.id&&task.execution==='demonstration');if(!task)throw fail('DEMONSTRATION_NOT_ACTIVE');if(!['cancelled','completed'].includes(task.status))await store.invalidateDemonstration(task.id,{status:'cancelled',expectedAttempt:task.attempt});}
      await notifyQuietly();return {cancelled:!!token||!!operation||!!input.id};
    },
    async waitForIdle(){await pending?.promise.catch(()=>{});}
  };
}
