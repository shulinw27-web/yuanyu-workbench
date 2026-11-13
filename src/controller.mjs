import { createWorkspace } from './core/workspace.mjs';
import { createBrowserDriver } from './browser/driver.mjs';
import { buildMonthlyReport } from './runtime/report.mjs';
import { planTask } from './planner.mjs';
import {modelStatus,ensureModelConfig,proposeModelPlan} from './model/gateway.mjs';
import {createSiteRegistry} from './sites/registry.mjs';
import {createAgentStore} from './agent/store.mjs';
import {createAgentRuntime} from './agent/runtime.mjs';
import {createMemoryStore} from './memory/store.mjs';
import {createDemonstration} from './agent/demonstration.mjs';
import {createBrowserModelRequester,probeModelProfile} from './model/gateway.mjs';
import {createModelProfiles,PROVIDERS} from './model/profiles.mjs';
import {accountIdentity} from './product/client.mjs';
import {sponsoredPlan} from './product/planner.mjs';
import {createDemoWrite} from './runtime/demo-write.mjs';
import { mkdir, realpath, lstat, unlink,readFile,writeFile,rename } from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import { join, resolve, relative, isAbsolute } from 'node:path';

const identities = {
  alice:{companyId:'mock-acme',userId:'alice',displayName:'林悦 · 采购运营',provider:'mock'},
  bob:{companyId:'mock-acme',userId:'bob',displayName:'陈宁 · 同公司同事',provider:'mock'},
  outsider:{companyId:'mock-other',userId:'outsider',displayName:'其他公司 · 测试成员',provider:'mock'}
};
const messages = {
  MEMORY_INPUT_INVALID:'记忆格式或范围无效，请检查内容，不要填写凭据。',MEMORY_CONSENT_REQUIRED:'请逐条选择并确认本次发送给模型的记忆。',MEMORY_SELECTION_CHANGED:'所选记忆已变化、过期或不适用于当前站点，请重新选择。',MEMORY_CRYPTO_UNAVAILABLE:'系统加密不可用，记忆未保存。',MEMORY_VERSION_CONFLICT:'记忆已更新，请刷新后重新操作。',MEMORY_NOT_FOUND:'没有找到这条记忆，请刷新后重试。',MEMORY_DECRYPT_FAILED:'本机记忆无法解密，未展示历史版本。',MEMORY_BINDING_MISMATCH:'记忆与本人身份不匹配，已拒绝展示。',
  AGENT_BUDGET_EXHAUSTED:'本任务预算已用完，请核对结果后创建新任务。',AGENT_BUDGET_LEGACY:'旧任务没有可核对的累计预算，请创建新任务。',AGENT_REVIEW_REQUIRED:'结果需要你核对后才能保存为工作流。',AGENT_CORRECTION_NO_CHANGE:'修正后没有产生可核对的变化，任务已停止；请检查当前页面。',
  DEMONSTRATION_INPUT_INVALID:'示范参数无效，请填写目标并选择一至三个授权站点。',DEMONSTRATION_ACTIVE:'请先完成或取消当前示范。',DEMONSTRATION_NOT_ACTIVE:'这次示范已结束或中断，请从新任务重新开始。',DEMONSTRATION_RESUME_REQUIRED:'请通过示范面板继续；重启后请直接重新示范，原记录保留。',DEMONSTRATION_NOT_PAUSED:'示范当前不在登录接管状态，请重新观察页面。',DEMONSTRATION_CONFIRMATION_REQUIRED:'请先核对当前页面结果，再明确确认完成示范。',DEMONSTRATION_RESULT_UNVERIFIED:'请至少执行一次可记录操作并读取当前结果后，再确认完成。',DEMONSTRATION_RESULT_CHANGED:'当前页面结果已变化，请查看新页面内容并重新核对后完成。',DEMONSTRATION_PAGE_INVALID:'当前页面结构无法安全记录，请重新观察或取消示范。',DEMONSTRATION_TIMEOUT:'示范操作超时，已停止当前记录；请检查站点后重新开始。',STALE_REFERENCE:'页面或控件已变化，请重新观察后再操作。',
  WRITE_INPUT_INVALID:'请选择合成月份并填写不含凭据的核对备注（最多300字）。',WRITE_CONFIRMATION_INVALID:'预览已过期或确认内容不匹配，请重新预览。',WRITE_CONTEXT_CHANGED:'身份或来源已变化，写入已停止。',WRITE_RECEIPT_RECONCILE_REQUIRED:'上次回执尚未确认，请先核对回执，不要重复提交。',CONTACT_UNAVAILABLE:'开发者联系方式尚未配置。',CLIPBOARD_UNAVAILABLE:'无法自动复制，请选中微信号手动复制。',
  AUTH_FAILED:'邮箱或密码不正确。',ACCOUNT_UNAVAILABLE:'此邮箱暂不能注册，请登录或联系开发者。',VERIFICATION_REQUIRED:'请先完成账号验证，真实服务可联系开发者核实开通。',VERIFICATION_INVALID:'验证码无效或已过期。',RATE_LIMITED:'请求过于频繁，请稍后再试。',MONTHLY_QUOTA_EXCEEDED:'本月免费Token额度不足，可等待下月或选择自己的API。',DAILY_REQUEST_LIMIT:'今日模型请求次数已用完，请明天再试或使用自己的API。',PROMOTION_NOT_AVAILABLE:'推广额度尚未开放，请联系开发者或选择自己的API。',PROMOTION_BUDGET_EXCEEDED:'开发者本月推广总额度已用完，请选择自己的API或联系开发者。',REQUEST_CONTEXT_EXPIRED:'原模型请求上下文已过期，未自动重新调用；请核对已用额度后再决定是否发起新任务。',PROVIDER_UNAVAILABLE:'推广模型未返回可核对结果，预留额度保留，请联系开发者。',PROVIDER_TIMEOUT:'推广模型超时，用量待核实，预留额度保留。',
  AUTH_REQUIRED:'请先注册或登录个人账号。',ACCOUNT_NOT_VERIFIED:'请先完成账号验证，再使用推广额度。',ENTERPRISE_REQUIRED:'公司工作流在个人版中仅供查看；使用请联系开发者开通企业版。',MOCK_IDENTITY_DISABLED:'注册账号模式不允许切换演示身份。',SERVICE_UNAVAILABLE:'账号与额度服务暂不可用，请检查服务配置。',SERVICE_TIMEOUT:'账号服务请求超时，请稍后手动重试。',SERVICE_CONFIG_INVALID:'账号服务配置无效，请检查仓库外的 product.local.json。',QUOTA_EXCEEDED:'免费额度已用完，可等待额度更新或选择自己的模型。',PROMOTION_DISABLED:'推广额度尚未开放，请联系开发者或选择自己的模型。',EMAIL_NOT_VERIFIED:'请先完成账号验证。',AUTH_INVALID:'邮箱或密码不正确。',MODEL_NOT_AVAILABLE:'所选推广模型当前不可用，请重新选择。',
  MONTH_INVALID:'月份格式应为 YYYY-MM。',MONTH_AMBIGUOUS:'本轮一次处理一个月份，请明确选择。',MONTH_CONFLICT:'文字中的月份与参数不同，请统一后重试。',TASK_INPUT_INVALID:'请输入有效的采购月报任务。',
  BUSY:'当前任务正在执行，请先取消或等待完成。',PLAN_REQUIRED:'请先查看并确认当前计划。',UNSUPPORTED:'此任务超出当前预设 Mock 范围。',
  CREDENTIAL_NOT_FOUND:'当前成员尚未保存该系统的账号，请到系统与账号中添加。',VAULT_UNAVAILABLE:'系统加密不可用，凭据未保存。',
  CREDENTIAL_REQUIRED:'当前成员尚未保存该系统账号，请到系统与账号中添加。',CRYPTO_UNAVAILABLE:'系统加密不可用，凭据未保存。',CRYPTO_FAILED:'本机凭据无法加密或解密，请重新配置。',BROWSER_READ_FAILED:'Mock网页登录、筛选或读取未通过，请检查账号和当前执行月份。',
  CREDENTIAL_ORIGIN_MISMATCH:'系统来源已变化，请重新保存对应账号后再运行。',
  PLAN_STALE:'工作流版本或启用状态已变化，请重新生成计划。',WORKFLOW_DISABLED:'工作流已停用，请先启用并重新验证。',VERSION_CONFLICT:'工作流已被修改，请刷新后再保存。',
  MODEL_NOT_CONFIGURED:'请先在设置中配置本机模型服务。',MODEL_DISABLED:'本机模型尚未启用，请检查配置。',MODEL_CONFIG_INVALID:'模型配置无效，请检查地址、模型名称和本机密钥文件路径。',MODEL_CONSENT_REQUIRED:'请先确认仅发送本条任务文本至配置的模型。',MODEL_PAYMENT_REQUIRED:'提供方拒绝了请求：当前无可用额度或套餐；本次不会自动重试。',MODEL_AUTH_REJECTED:'模型身份验证失败，请检查本机密钥文件。',MODEL_PLAN_INVALID:'模型返回的计划未通过受控配方校验，没有执行任何操作。',MODEL_UNAVAILABLE:'模型服务暂不可用，请检查连接后手动重试。',MODEL_TIMEOUT:'模型请求超时，没有执行任务。',SENSITIVE_TASK_TEXT:'任务描述疑似包含凭据，请移到系统账号表单中输入。',
  SITE_HTTPS_REQUIRED:'站点需要有效的HTTPS来源，不接受地址内嵌账号密码。',SITE_PATH_INVALID:'请填写允许访问的精确站内路径，每行一个。',WRITE_CONFIRM_REQUIRED:'此操作可能提交或修改业务数据，需要独立预览与确认。',
  SITE_VERSION_CONFLICT:'站点配置已变化，请刷新后再修改。',
  AGENT_SKILL_VERSION_CHANGED:'浏览器工作流已修订，请重新查看参数并创建任务。',AGENT_PARAMETER_INVALID:'工作流参数无效，请使用已声明的查询参数，不要填写凭据。',
  AGENT_MOCK_SCOPE:'合成演示仅支持读取交互式本机站点的2026-09或2026-10记录；请在任务中注明“合成”。它不代表真实模型理解能力。',AGENT_SITE_SCOPE:'请选择当前模式允许的站点；合成演示仅使用本机内建站点。',AGENT_CONFIG_INVALID:'浏览器任务需要1至3个授权站点和有效执行模式。',AGENT_TASK_ACTIVE:'请先继续或取消当前等待中的浏览器任务。',AGENT_BINDINGS_CHANGED:'此任务或工作流绑定的站点来源或版本已变化，请重新确认并建立流程。',AGENT_TASK_NOT_FOUND:'当前身份没有此浏览器任务或工作流。',AGENT_SKILL_NOT_FOUND:'原工作流已删除，无法继续该次运行。',AGENT_TASK_NOT_RESUMABLE:'此任务不能继续，请新建任务。',AGENT_TIMEOUT:'本轮操作超时，未标记为完成。请检查页面后手动继续。',AGENT_RESULT_UNVERIFIED:'未读取到可以核对的页面结果，任务没有标为完成。',AGENT_CONTEXT_CHANGED:'当前身份或站点配置已变化，任务已停止。',AGENT_SENSITIVE_DATA:'任务或模板疑似包含凭据或原始网页，未保存；请通过独立登录窗口操作。',PAGE_STRUCTURE_CHANGED:'页面结构已变化，无法唯一定位原有步骤，请人工检查。',PAGE_CONTENT_CONSENT_REQUIRED:'请分别确认发送本条任务文本和所选页面内容。',MODEL_PAGE_SCOPE_REQUIRED:'本机模型配置需要明确设置dataScope为selected_pages后，才能启用页面理解。',MODEL_CONFIG_CHANGED:'模型配置已变化，本轮已停止；请重新确认调用范围。',
  CANCELLED:'任务已取消，未继续生成结果。',ARTIFACT_NOT_FOUND:'文件不存在或不属于当前用户已完成的运行。'
};
export function safeError(error) {
  const raw = typeof error?.code === 'string' ? error.code : error?.message;
  const code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{1,70}$/.test(raw) ? raw : 'OPERATION_FAILED';
  return {code,message:messages[code] || '操作未完成，请核对当前身份、系统账号及执行状态后重试。'};
}

export async function createController({dataDir,cryptoAdapter,systems,BrowserWindow,builtinSites=[],onUpdate=()=>{},browserShow=true,openPath=async()=>{},planningGateway=proposeModelPlan,agentRequesterFactory,interactiveFactory,productClient,modelProbe=probeModelProfile,copyText=async()=>{throw new Error('CLIPBOARD_UNAVAILABLE');}}) {
  let identity=identities.alice, workspace, active=null, starting=false, startPending=null, switching=false, pending=null,planning=null;
  let siteRegistry,customSites=[],currentSystems=systems,interactive=null,agentStore,agentRuntime,demonstration,configurationPending=null,profiles,demoWrite,memoryStore,modelPreference={source:productClient?'sponsored':'byok',modelId:null};
  const trustedSites=builtinSites.map(site=>({...site,builtin:true,revision:1}));
  const agentSites=async()=>[...trustedSites,...await siteRegistry.list()];
  const modelFile=()=>join(dataDir,'models',identity.companyId,identity.userId,'model.local.json');
  const systemDictionary=sites=>({...systems,...Object.fromEntries(sites.map(site=>[site.id,{id:site.id,label:site.label,origin:site.origin,url:site.origin+site.entryPath}]))});
  const preferencesFile=()=>join(dataDir,'product-preferences',identity.companyId,identity.userId,'state.json');
  const initialize = async () => {
    siteRegistry=createSiteRegistry({dataDir,identity});customSites=await siteRegistry.list();currentSystems=systemDictionary(customSites);workspace = await createWorkspace({dataDir,cryptoAdapter,identity,systems:currentSystems});profiles=createModelProfiles({dataDir,identity,cryptoAdapter});
    modelPreference={source:productClient?'sponsored':'byok',modelId:null};
    try{const value=JSON.parse(await readFile(preferencesFile(),'utf8'));if(!['sponsored','byok'].includes(value.source)||value.modelId!==null&&typeof value.modelId!=='string')throw new Error('MODEL_CONFIG_INVALID');modelPreference=value;}catch(error){if(error.code!=='ENOENT')throw error;}
    memoryStore=createMemoryStore({dataDir,identity,cryptoAdapter});initializeAgent();
    const owner=identity;demoWrite=createDemoWrite({dataDir,identity:owner,checkContext:async()=>identity===owner&&!switching&&await authorized(owner)});
  };
  async function authorized(owner=identity){
    if(!productClient)return true;
    const value=await productClient.me();return identity===owner&&owner.userId===`user-${value.account.id}`&&!switching;
  }
  async function browserRequester(input){
    const owner=identity;
    if(!await authorized(owner))throw new Error('AUTH_REQUIRED');
    if(agentRequesterFactory)return agentRequesterFactory(input);
    if(productClient&&modelPreference.source==='sponsored')return productClient.requester({modelId:modelPreference.modelId||((await productClient.status()).models[0]?.id),consent:input.consent});
    const selection=await profileSelection(profiles);return createBrowserModelRequester({...input,...selection});
  }
  async function profileSelection(store){const list=await store.list();if(list.activeId)return {profiles:store};if(list.revision>1)throw new Error('MODEL_NOT_CONFIGURED');return {};}
  let offerLesson=async()=>{},offerEpisode=async()=>{};
  function initializeAgent(){
    const owner=identity,memories=memoryStore;agentStore=createAgentStore({dataDir,identity});
    // Best-effort, user-confirmed candidates: never block completion or auto-enable long-term memory.
    offerEpisode=async task=>{
      try{
        if(identity!==owner||switching||memories!==memoryStore||!await authorized(owner))return;
        if(!task||task.status!=='completed')return;
        const view=await memories.snapshot();if(!view.available||!view.settings?.rememberEpisodes)return;
        if(view.entries.some(entry=>entry.kind==='episode'&&entry.source?.id===task.id))return;
        await memories.save({kind:'episode',title:'本次任务摘要（待确认）',content:`任务已完成；执行模式：${task.mode}；步骤数：${task.steps?.length||0}。业务数据需重新查询。`,siteBindings:task.siteBindings,source:{type:'verified_run',id:task.id},confirmed:false});
        await notify();
      }catch{return;}
    };
    // Best-effort lesson candidate: never blocks completion, never auto-enables or edits a Skill.
    offerLesson=async task=>{
      try{
        if(identity!==owner||switching||memories!==memoryStore||!await authorized(owner))return;
        if(!task||task.status!=='completed'||!Array.isArray(task.reflections)||!task.reflections.length)return;
        const view=await memories.snapshot();if(!view.available||!view.settings?.rememberLessons)return;
        const record=task.reflections.find(entry=>['verified','needs_review'].includes(entry.checkResult));if(!record)return;
        if(view.entries.some(entry=>entry.kind==='lesson'&&entry.source?.id===task.id))return;
        await memories.save({kind:'lesson',title:'一次修正经验（待确认）',content:`遇到 ${record.problemCode} 时按限定路径重新观察并复验；复验结果 ${record.checkResult}。这只是一次本机运行的候选，不是通用规则，需你核实后才会启用。`,siteBindings:task.siteBindings,source:{type:'verified_run',id:task.id},confirmed:false});
        await notify();
      }catch{return;}
    };
    agentRuntime=createAgentRuntime({store:agentStore,getSites:agentSites,getBrowser:()=>getBrowser(owner),isCurrent:()=>identity===owner&&!switching,authorize:()=>authorized(owner),onUpdate:notify,modelFile:modelFile(),safeError,requesterFactory:browserRequester,
      contextProvider:async({goal,siteBindings,consent})=>{
        const ids=consent?.memoryIds||[];
        if(!Array.isArray(ids)||ids.length>5||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string')||ids.length&&consent?.memory!==true)throw new Error('MEMORY_CONSENT_REQUIRED');
        if(!ids.length)return {text:'',revision:0};
        const selected=await memories.retrieve({query:goal,siteBindings,ids,includeEpisodes:true});
        if(selected.entries.length!==ids.length)throw new Error('MEMORY_SELECTION_CHANGED');
        const selection=JSON.stringify([modelPreference,(await profiles.list()).revision]);
        return {text:JSON.stringify(selected.entries.map(({id,kind,title,content})=>({id,kind,title,content}))),revision:selected.revision,
          check:async()=>identity===owner&&!switching&&memories===memoryStore&&await memories.getRevision()===selected.revision&&selection===JSON.stringify([modelPreference,(await profiles.list()).revision])};
      },
      onTaskMemory:async info=>{
        if(identity!==owner||switching||memories!==memoryStore||!await authorized(owner))return;
        await offerEpisode(info.task);await offerLesson(info.task);
      }
    });
    demonstration=createDemonstration({store:agentStore,getSites:agentSites,getBrowser:()=>getBrowser(owner),isCurrent:()=>identity===owner&&!switching,authorize:()=>authorized(owner),onUpdate:notify,safeError});
  }
  if(productClient){const initial=await productClient.status();if(initial.authenticated)identity=accountIdentity(initial.account);}
  await initialize();
  async function snapshot(){
    const owner=identity,target=workspace,registry=siteRegistry,store=agentStore,runtime=agentRuntime,demo=demonstration,sites=customSites,visibleSystems=Object.values(currentSystems),file=modelFile(),profileStore=profiles,writeSource=demoWrite,memories=memoryStore;
    const [core,registered,tasks,skills,legacyModel,profileList,profileStatus,product]=await Promise.all([target.snapshot(),registry.list(),store.listTasks(),store.listSkills(),modelStatus(file),profileStore.list(),profileStore.status(),productClient?.status()]);
    if(owner!==identity||target!==workspace||store!==agentStore||runtime!==agentRuntime)return snapshot();
    let model=profileList.activeId||profileList.revision>1?profileStatus:legacyModel;
    if(productClient&&modelPreference.source==='sponsored'){const selected=product.models.find(m=>m.id===(modelPreference.modelId||product.models[0]?.id));model=selected&&product.account?.verified?{status:'ready',connection:'not_verified',mode:'sponsored',dataScope:'selected_pages',model:selected.label,host:'推广额度服务'}:{status:'not_configured',mode:'sponsored',dataScope:'selected_pages'};}
    const productView=product?{...product,authenticated:!switching&&product.authenticated&&identity.userId===`user-${product.account.id}`,modelSource:modelPreference.source,sponsoredModelId:modelPreference.modelId||product.models[0]?.id}:null;
    const base={...core,systems:visibleSystems,sites,agentSites:[...trustedSites,...registered].map(({id,label,origin,revision,builtin})=>({id,label,origin,revision,builtin:!!builtin})),agentTasks:tasks,agentSkills:skills,model,modelProfiles:{...profileList,providers:Object.entries(PROVIDERS).map(([id,p])=>({id,label:p.label,baseUrl:p.defaultBaseUrl,docUrl:p.docUrl}))},...(productView?{product:productView}:{}),mode:'preset_mock',busy:!!active||starting||!!planning||runtime.busy||!!configurationPending};
    if(productView){base.shared=[{id:'sample-purchase-monthly',name:'采购与入库月报资料',version:1,description:'企业流程公开示例：跨采购、仓储核对并交付资料。个人版仅查看。',publisher:{displayName:'企业版公开示例'},publicSample:true}];if(!productView.authenticated){base.identity=null;base.systems=Object.values(systems);base.model={status:'not_configured'};for(const key of ['credentials','workflows','runs','agentTasks','agentSkills','sites','agentSites'])base[key]=[];base.modelProfiles={providers:base.modelProfiles.providers,profiles:[],activeId:null};}}
    if(!productView||productView.authenticated){try{base.writeDemo=await writeSource.snapshot();}catch{base.writeDemo={records:[],approvals:[],unavailable:true};}}
    if(owner!==identity||writeSource!==demoWrite)return snapshot();
    base.demonstration=!productView||productView.authenticated?demo.snapshot():null;
    base.memory=!productView||productView.authenticated?await memories.snapshot():{revision:0,available:false,entries:[],settings:{rememberEpisodes:false,rememberLessons:false}};
    base.busy=base.busy||demo.active||demo.busy;
    if(demo!==demonstration||memories!==memoryStore)return snapshot();
    if(productView?.authenticated&&!await authorized(owner).catch(()=>false))return snapshot();
    return base;
  }
  async function notify(){ onUpdate(await snapshot()); }
  const requireIdle=()=>{if(active || starting || switching || planning || agentRuntime.busy || demonstration.active || demonstration.busy || configurationPending)throw new Error('BUSY');};
  const closeBrowser=async()=>{const old=interactive;interactive=null;await old?.close();};
  async function getBrowser(owner){
    if(owner!==identity||switching)throw new Error('CANCELLED');
    const sites=[...trustedSites,...customSites.map(site=>({...site,manual:true,manualPostPaths:site.paths}))];
    if(!interactive){const {createInteractiveBrowser}=await import('./browser/interactive.mjs');if(owner!==identity||switching)throw new Error('CANCELLED');interactive=(interactiveFactory||createInteractiveBrowser)({BrowserWindow,show:browserShow,sites,onEvent:()=>{notify().catch(()=>{});}});}
    return interactive;
  }
  async function browserOperation(method,payload){
    requireIdle();const owner=identity,target=workspace,session=await getBrowser(owner);let result;
    if(owner!==identity||switching)throw new Error('CANCELLED');
    if(!await authorized(owner))throw new Error('AUTH_REQUIRED');
    if(method==='observe'||method==='open'||method==='handoff'||method==='resume')result=await session[method](payload.siteId);
    else if(method==='fillCredential')result=await target.withCredential(payload.siteId,credential=>{if(owner!==identity||session!==interactive)throw new Error('CANCELLED');return session.fillCredential(payload.siteId,credential);});
    else throw new Error('ACTION_INVALID');
    if(owner!==identity || session!==interactive)throw new Error('CANCELLED');if(!await authorized(owner))throw new Error('AUTH_REQUIRED');return result;
  }
  async function launchAgent(operation,cancelStarted=id=>agentRuntime.cancel(id)){
    requireIdle();starting=true;let settled;
    const startup={cancelled:false,settled:new Promise(resolve=>{settled=resolve;})};startPending=startup;
    try{const result=await operation();if(startup.cancelled)await cancelStarted(result.taskId);return result;}
    finally{starting=false;if(startPending===startup)startPending=null;settled();await notify();}
  }
  async function changeSites(operation){
    requireIdle();let settled;const owner=identity;
    const pendingChange={settled:new Promise(resolve=>{settled=resolve;})};configurationPending=pendingChange;
    try{const result=await operation(siteRegistry,workspace);if(owner!==identity||switching)throw new Error('CANCELLED');await closeBrowser();await initialize();pending=null;return result;}
    finally{if(configurationPending===pendingChange)configurationPending=null;settled();await notify();}
  }
  async function savePreference(value){
    const file=preferencesFile();await mkdir(join(dataDir,'product-preferences',identity.companyId,identity.userId),{recursive:true});
    const tmp=file+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(value),{flag:'wx',mode:0o600});await rename(tmp,file);modelPreference=value;
  }
  async function accountAction(action,payload){
    if(!productClient)throw new Error('ACTION_INVALID');
    if(action==='auth.verify'){const result=await productClient.verify({code:payload.code});await notify();return result;}
    // Explicit authentication may end an old guided demonstration, including one whose account was revoked.
    if(action!=='auth.logout'){
      if(active||starting||switching||planning||agentRuntime.busy||configurationPending)throw new Error('BUSY');
    }else await configurationPending?.settled;
    switching=true;
    try{
      await cancel();await closeBrowser();pending=null;
      let result;
      if(action==='auth.logout'){try{result=await productClient.logout();}catch{result={loggedOut:true,localOnly:true};}identity=identities.alice;}
      else {result=await productClient[action==='auth.register'?'register':'login'](payload);identity=accountIdentity(result.account);}
      await initialize();return result;
    }finally{switching=false;await notify();}
  }
  async function execute(payload) {
    requireIdle();
    if (!pending || Date.now()-pending.createdAt>300000 || pending.month!==payload.month || (pending.workflowId||null)!==(payload.workflowId||null)) throw new Error('PLAN_REQUIRED');
    const acceptedPlan=pending;pending=null;starting=true;
    let resolveStarting;
    const startup={cancelled:false,settled:new Promise(resolve=>{resolveStarting=resolve;})};startPending=startup;
    const owner=identity, target=workspace;
    try {
      if(payload.workflowId){const selected=(await target.snapshot()).workflows.find(w=>w.id===payload.workflowId);if(!selected||!selected.enabled||selected.version!==acceptedPlan.workflowVersion)throw new Error('PLAN_STALE');}
      const run = await target.beginRun(payload);
      if(startup.cancelled){await target.updateRun(run.id,{status:'cancelled',error:{code:'CANCELLED',message:messages.CANCELLED}});await notify();return {runId:run.id};}
      const driver=createBrowserDriver({BrowserWindow,systems,show:browserShow});
      const token={id:run.id,owner,target,driver,cancelled:false,promise:null};active=token;starting=false;
      token.promise=(async()=>{
        const steps=[];let producedArtifact;
        const checkpoint=async()=>{if(token.cancelled || active!==token || identity!==owner)throw new Error('CANCELLED');if(!await authorized(owner))throw new Error('AUTH_REQUIRED');if(token.cancelled || active!==token || identity!==owner)throw new Error('CANCELLED');};
        const step=async(id,label,status,detail)=>{
          await checkpoint();const next={id,label,status,...(detail?{detail}: {})};
          const index=steps.findIndex(s=>s.id===id);if(index>=0)steps[index]=next;else steps.push(next);
          await target.updateRun(run.id,{steps:[...steps]});await notify();await checkpoint();
        };
        try {
          const readings={};
          for(const [systemId,label] of [['procurement','读取采购订单'],['warehouse','读取仓储入库']]) {
            await step(systemId,label,'running');
            readings[systemId]=await target.withCredential(systemId, async credential=>{
              await checkpoint();const result=await driver.readSystem(systemId,{month:payload.month,credential});await checkpoint();return result;
            });
            await step(systemId,label,'completed','已通过实际 Mock 网页读取与月份核对');
          }
          await step('report','核对并生成资料草稿','running');
          const outputDir=join(dataDir,'outputs',owner.companyId,owner.userId);
          await mkdir(outputDir,{recursive:true});await checkpoint();
          const report=await buildMonthlyReport({...readings,month:payload.month,outputDir});producedArtifact=report.artifact;await checkpoint();
          await step('report','核对并生成资料草稿','completed');
          await target.updateRun(run.id,{status:'completed',artifact:report.artifact,summary:report.summary,steps});
        } catch(error) {
          if(producedArtifact) {
            const base=await realpath(join(dataDir,'outputs',owner.companyId,owner.userId));
            for(const file of [producedArtifact.path,producedArtifact.sourcePath].filter(Boolean)) {
              try {const actual=await realpath(file);const offset=relative(base,actual);if(offset && !offset.startsWith('..') && !isAbsolute(offset) && !(await lstat(file)).isSymbolicLink())await unlink(actual);} catch { /* a failed run never exposes an unverified artifact */ }
            }
          }
          if(!token.cancelled) {
            const failure=safeError(error);
            const last=steps.at(-1);if(last?.status==='running')last.status='failed';
            await target.updateRun(run.id,{status:'failed',steps,error:failure}).catch(()=>{});
          }
        } finally {
          await driver.close();if(active===token)active=null;await notify();
        }
      })();
      await notify();return {runId:run.id};
    } finally {starting=false;if(startPending===startup)startPending=null;resolveStarting();}
  }
  async function cancel() {
    const cancelledPlanning=!!planning;planning?.abort();
    // Mark startup and in-flight runs before awaiting other subsystems, so a late failure is never stored as 'failed'.
    const startup=startPending;if(startup)startup.cancelled=true;
    const token=active;if(token)token.cancelled=true;
    const cancelledDemo=await demonstration.cancel({});
    const cancelledAgent=await agentRuntime.cancel();
    if(startup)await startup.settled;
    if(!token)return {cancelled:!!startup || cancelledPlanning || cancelledAgent.cancelled || cancelledDemo.cancelled};
    // The run may already have stopped and cleared `active` while we awaited. Persist its terminal state anyway,
    // otherwise a cancellation that wins the race leaves the run stuck at `running`.
    await token.target.updateRun(token.id,{status:'cancelled',error:{code:'CANCELLED',message:messages.CANCELLED}}).catch(()=>{});
    await token.driver.close();await token.promise;if(active===token)active=null;await notify();return {cancelled:true};
  }
  async function invoke(action,payload={}) {
    if(!payload || typeof payload!=='object' || Array.isArray(payload))throw new Error('INPUT_INVALID');
    if(switching && action!=='snapshot')throw new Error('BUSY');
    if(productClient&&!['snapshot','auth.register','auth.login','auth.verify','auth.logout','developer.contact.copy'].includes(action)){
      const owner=identity;if(!await authorized(owner))throw new Error('AUTH_REQUIRED');
      if(owner!==identity||switching)throw new Error('CANCELLED');
      if(action==='identity.switch')throw new Error('MOCK_IDENTITY_DISABLED');
      if(['workflow.import','workflow.publish','workflow.revoke'].includes(action))throw new Error('ENTERPRISE_REQUIRED');
      if(['workflow.run','task.run','task.plan'].includes(action)&&payload.workflowId){const selected=(await workspace.snapshot()).workflows.find(w=>w.id===payload.workflowId);if(selected?.source?.kind==='company-template')throw new Error('ENTERPRISE_REQUIRED');}
    }
    let result;
    switch(action) {
      case 'snapshot':return snapshot();
      case 'memory.save':return changeSites(async()=>{
        if(Object.keys(payload).some(key=>!['id','kind','title','content','siteIds','expiresAt','expectedRevision'].includes(key)))throw new Error('MEMORY_INPUT_INVALID');
        const ids=payload.siteIds||[];if(!Array.isArray(ids)||ids.length>3||new Set(ids).size!==ids.length)throw new Error('MEMORY_INPUT_INVALID');
        const sites=await agentSites(),siteBindings=ids.map(id=>{const s=sites.find(s=>s.id===id);if(!s)throw new Error('AGENT_SITE_SCOPE');return {id:s.id,origin:s.origin,revision:s.revision};});
        return memoryStore.save({...(payload.id?{id:payload.id,expectedRevision:payload.expectedRevision}:{}),kind:payload.kind,title:payload.title,content:payload.content,siteBindings,...(payload.expiresAt?{expiresAt:payload.expiresAt}:{}),source:{type:'user_message'},confirmed:true});
      });
      case 'memory.enabled':return changeSites(()=>memoryStore.setEnabled(payload));
      case 'memory.confirm':return changeSites(()=>memoryStore.confirm(payload));
      case 'memory.settings':return changeSites(()=>memoryStore.updateSettings(payload));
      case 'memory.forget':await cancel();return changeSites(()=>memoryStore.forget(payload));
      case 'memory.diff':{
        requireIdle();const owner=identity,memories=memoryStore;
        if(Object.keys(payload).some(key=>!['id','expectedRevision'].includes(key))||typeof payload.id!=='string'||payload.id.length>100||payload.expectedRevision!==undefined&&!Number.isInteger(payload.expectedRevision))throw new Error('MEMORY_INPUT_INVALID');
        const result=await memories.diff({id:payload.id,expectedRevision:payload.expectedRevision});
        if(owner!==identity||memories!==memoryStore||!await authorized(owner))throw new Error('CANCELLED');return result;
      }
      case 'memory.preview':{
        requireIdle();const owner=identity,memories=memoryStore,sites=await agentSites();
        if(typeof payload.query!=='string'||payload.query.length>2000||!Array.isArray(payload.siteIds)||payload.siteIds.length>3)throw new Error('MEMORY_INPUT_INVALID');
        const siteBindings=payload.siteIds.map(id=>{const s=sites.find(s=>s.id===id);if(!s)throw new Error('AGENT_SITE_SCOPE');return {id:s.id,origin:s.origin,revision:s.revision};});
        const result=await memories.retrieve({query:payload.query,siteBindings,includeEpisodes:payload.includeEpisodes===true});
        const skills=await agentStore.listSkills(),available=new Set(siteBindings.map(s=>JSON.stringify(s)));
        result.recommendedSkills=skills.filter(s=>s.template.siteBindings.every(binding=>available.has(JSON.stringify(binding)))&&[s.name,s.goal].some(t=>t&&payload.query.includes(t.slice(0,6)))).slice(0,3).map(s=>({id:s.id,name:s.name,version:s.version}));
        if(owner!==identity||memories!==memoryStore||!await authorized(owner))throw new Error('CANCELLED');return result;
      }
      case 'demo.start':return launchAgent(()=>demonstration.start({goal:payload.goal,siteIds:payload.siteIds,mode:payload.mode}),id=>demonstration.cancel({id}));
      case 'demo.observe':case 'demo.act':case 'demo.handoff':case 'demo.resume':case 'demo.finish':{
        if(active||starting||switching||planning||agentRuntime.busy||configurationPending)throw new Error('BUSY');
        const method=action.slice(5);return demonstration[method](payload);
      }
      case 'demo.cancel':return demonstration.cancel({id:payload.id});
      case 'developer.contact.copy':{const info=await productClient?.status();const text=info?.developer?.contact;if(!text||typeof text!=='string'||text.length>320)throw new Error('CONTACT_UNAVAILABLE');await copyText(text);return {copied:true};}
      case 'write.demo.preview':return changeSites(()=>demoWrite.preview(payload));
      case 'write.demo.confirm':return changeSites(()=>demoWrite.confirm({id:payload.id,fingerprint:payload.fingerprint}));
      case 'write.demo.inspect':return changeSites(()=>demoWrite.inspect(payload.id));
      case 'auth.register':case 'auth.login':case 'auth.verify':case 'auth.logout':return accountAction(action,payload);
      case 'model.profile.save':return changeSites(async()=>{const result=await profiles.save(payload);if(productClient)await savePreference({...modelPreference,source:'byok'});return result;});
      case 'model.profile.select':return changeSites(async()=>{const result=await profiles.select(payload.id);if(productClient)await savePreference({...modelPreference,source:'byok'});return result;});
      case 'model.profile.delete':return changeSites(()=>profiles.remove(payload.id));
      case 'model.source':return changeSites(async()=>{
        if(!['sponsored','byok'].includes(payload.source)||!productClient&&payload.source==='sponsored')throw new Error('MODEL_CONFIG_INVALID');
        if(payload.source==='sponsored'){const info=await productClient.status();if(!info.models.some(model=>model.id===payload.modelId))throw new Error('MODEL_NOT_AVAILABLE');}
        await savePreference({source:payload.source,modelId:payload.modelId??null});return {source:payload.source};
      });
      case 'model.test':{
        requireIdle();if(payload.consent!==true)throw new Error('MODEL_CONSENT_REQUIRED');const owner=identity,request=new AbortController();planning=request;
        try{
          let result;
          if(productClient&&modelPreference.source==='sponsored'){const requester=await productClient.requester({modelId:modelPreference.modelId||((await productClient.status()).models[0]?.id),consent:{taskText:true,pageContent:false}});await requester({signal:request.signal,messages:[{role:'system',content:'Connection probe. Reply OK only.'},{role:'user',content:'OK'}],tools:[]});result={connected:true,source:'sponsored'};}
          else result=await modelProbe({profiles,consent:true,signal:request.signal});
          if(owner!==identity||request.signal.aborted)throw new Error('CANCELLED');return result;
        }finally{if(planning===request)planning=null;await notify();}
      }
      case 'agent.start':return launchAgent(()=>agentRuntime.start({goal:payload.goal,siteIds:payload.siteIds,mode:payload.mode,consent:payload.consent,budgetOptions:payload.budgetOptions,enableReflection:payload.enableReflection}));
      case 'agent.confirmResult':{requireIdle();const result=await agentRuntime.confirmResult(payload);const task=(await agentStore.listTasks()).find(task=>task.id===payload.id);await offerEpisode(task);await offerLesson(task);return result;}
      case 'agent.history.clear':requireIdle();result=await agentRuntime.cleanupHistory(payload);break;
      case 'agent.resume':return launchAgent(async()=>{const task=(await agentStore.listTasks()).find(task=>task.id===payload.id);if(task?.execution==='demonstration')throw new Error('DEMONSTRATION_RESUME_REQUIRED');return agentRuntime.resume({id:payload.id,consent:payload.consent});});
      case 'agent.cancel':{const task=(await agentStore.listTasks()).find(task=>task.id===payload.id);return task?.execution==='demonstration'?demonstration.cancel({id:payload.id}):agentRuntime.cancel(payload.id);}
      case 'agent.skill.save':requireIdle();result=await agentRuntime.saveSkill({taskId:payload.taskId,name:payload.name,pinned:payload.pinned});break;
      case 'agent.skill.run':return launchAgent(()=>agentRuntime.runSkill({id:payload.id,mode:payload.mode,consent:payload.consent,values:payload.values,expectedVersion:payload.expectedVersion}));
      case 'agent.skill.edit':requireIdle();result=await agentStore.editSkill(payload);break;
      case 'agent.skill.pin':requireIdle();result=await agentStore.setSkillPinned(payload.id,payload.pinned);break;
      case 'agent.skill.delete':requireIdle();result=await agentStore.deleteSkill(payload.id);break;
      case 'model.status':return (await snapshot()).model;
      case 'model.configure':{requireIdle();const file=await ensureModelConfig(modelFile());await openPath(file);return {opened:true};}
      case 'task.modelPlan':{
        requireIdle();if(payload.workflowId)throw new Error('MODEL_INPUT_INVALID');if(payload.consent!==true)throw new Error('MODEL_CONSENT_REQUIRED');
        const owner=identity,file=modelFile(),selectedProfiles=profiles,request=new AbortController();planning=request;pending=null;
        try {await notify();if(owner!==identity||request.signal.aborted)throw new Error('CANCELLED');
          const plan=productClient&&modelPreference.source==='sponsored'?await sponsoredPlan({client:productClient,modelId:modelPreference.modelId||((await productClient.status()).models[0]?.id),text:payload.text,month:payload.month,consent:payload.consent,signal:request.signal}):await planningGateway({file,...await profileSelection(selectedProfiles),text:payload.text,month:payload.month,consent:payload.consent,signal:request.signal});
          if(identity!==owner || planning!==request || request.signal.aborted)throw new Error('CANCELLED');
          pending=plan.supported?{...plan,workflowId:null,createdAt:Date.now()}:null;return plan;
        }finally{if(planning===request)planning=null;await notify();}
      }
      case 'site.list':return customSites;
      case 'site.register':return changeSites(registry=>registry.register(payload));
      case 'site.update':return changeSites(registry=>registry.update(payload));
      case 'site.delete':return changeSites(async(registry,target)=>{const site=(await registry.list()).find(s=>s.id===payload.id);if(!site||site.revision!==payload.expectedRevision)throw new Error('SITE_VERSION_CONFLICT');const credential=(await target.snapshot()).credentials.find(c=>c.systemId===payload.id);if(credential)await target.deleteCredential(credential.id);return registry.remove(payload);});
      case 'browser.open':return browserOperation('open',payload);
      case 'browser.observe':return browserOperation('observe',payload);
      case 'browser.handoff':return browserOperation('handoff',payload);
      case 'browser.resume':return browserOperation('resume',payload);
      case 'browser.fillCredential':return browserOperation('fillCredential',payload);
      case 'browser.close':requireIdle();await closeBrowser();return {closed:true};
      case 'task.plan': {
        requireIdle();const plan=planTask(payload);
        if(payload.workflowId){const selected=(await workspace.snapshot()).workflows.find(w=>w.id===payload.workflowId);if(!selected)throw new Error('WORKFLOW_NOT_FOUND');if(!selected.enabled)throw new Error('WORKFLOW_DISABLED');plan.workflowVersion=selected.version;}
        pending=plan.supported?{...plan,createdAt:Date.now()}:null;return plan;
      }
      case 'task.run':case 'workflow.run':return execute(payload);
      case 'run.cancel':return cancel();
      case 'credential.save':requireIdle();result=await workspace.saveCredential(payload);break;
      case 'credential.delete':requireIdle();result=await workspace.deleteCredential(payload.id);break;
      case 'workflow.save':result=await workspace.saveWorkflowFromRun(payload);break;
      case 'workflow.edit':requireIdle();result=await workspace.editWorkflow(payload);pending=null;break;
      case 'workflow.versions':return workspace.workflowVersions(payload.id);
      case 'workflow.restore':requireIdle();result=await workspace.restoreWorkflow(payload);pending=null;break;
      case 'workflow.enabled':requireIdle();result=await workspace.setWorkflowEnabled(payload);pending=null;break;
      case 'workflow.catalog':return workspace.recipeCatalog();
      case 'workflow.pin':result=await workspace.setPinned(payload.id,payload.pinned);break;
      case 'workflow.delete':requireIdle();result=await workspace.deleteWorkflow(payload.id);pending=null;break;
      case 'workflow.publish':result=await workspace.publishWorkflow(payload.id);break;
      case 'workflow.import':result=await workspace.importWorkflow(payload.publicationId);break;
      case 'workflow.revoke':result=await workspace.revokePublication(payload.id);break;
      case 'identity.switch': {
        if(typeof payload.userId!=='string' || !Object.hasOwn(identities,payload.userId))throw new Error('IDENTITY_INVALID');
        if(starting||configurationPending)throw new Error('BUSY');switching=true;
        try {
          const nextIdentity=identities[payload.userId];
          const nextRegistry=createSiteRegistry({dataDir,identity:nextIdentity}),nextSites=await nextRegistry.list(),nextSystems=systemDictionary(nextSites);
          const nextWorkspace=await createWorkspace({dataDir,cryptoAdapter,identity:nextIdentity,systems:nextSystems});
          await nextWorkspace.snapshot();await cancel();await closeBrowser();pending=null;identity=nextIdentity;workspace=nextWorkspace;siteRegistry=nextRegistry;customSites=nextSites;currentSystems=nextSystems;await initialize();result=await snapshot();
        }finally{switching=false;}break;
      }
      case 'artifact.open': {
        const run=(await workspace.snapshot()).runs.find(r=>r.id===payload.runId && r.status==='completed');
        const file=payload.source?run?.artifact?.sourcePath:run?.artifact?.path;
        if(typeof file!=='string')throw new Error('ARTIFACT_NOT_FOUND');
        const base=await realpath(join(dataDir,'outputs',identity.companyId,identity.userId));
        const actual=await realpath(file);const offset=relative(base,actual);
        if(!offset || offset.startsWith('..') || isAbsolute(offset) || (await lstat(file)).isSymbolicLink())throw new Error('ARTIFACT_NOT_FOUND');
        await openPath(resolve(actual));return {opened:true};
      }
      default:throw new Error('ACTION_INVALID');
    }
    await notify();return result??{};
  }
  return {invoke,snapshot,waitForIdle:async()=>{await configurationPending?.settled;await startPending?.settled;await active?.promise;await agentRuntime.waitForIdle();await demonstration.waitForIdle();},close:async()=>{await configurationPending?.settled;await cancel();await closeBrowser();}};
}
