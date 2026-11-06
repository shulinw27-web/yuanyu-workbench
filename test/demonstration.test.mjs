import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentStore} from '../src/agent/store.mjs';
import {createDemonstration} from '../src/agent/demonstration.mjs';

const identity={companyId:'mock-acme',userId:'alice',displayName:'合成成员',provider:'mock'};
const site={id:'interactive-mock',origin:'http://127.0.0.1:15333',revision:1,builtin:true};
const goal={goal:'示范筛选合成记录',siteIds:[site.id],mode:'mock_browser'};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function limit(promise,ms=1500){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('TEST_OPERATION_DID_NOT_SETTLE')),ms);})]);}finally{clearTimeout(timer);}}
async function fixture(t,options={}){
  const dir=await mkdtemp(join(tmpdir(),'yuanyu-demonstration-'));
  const store=createAgentStore({dataDir:dir,identity});let revision=0,logged=true,allowed=true,acts=0,closed=0,month='2026-10';
  const page=()=>({title:'合成查询',text:logged?`synthetic-page-only-${month}`:'synthetic-login-only',elements:logged?[
    {ref:`temporary-${++revision}`,tag:'select',role:'combobox',label:'月份',readOnly:false,options:[{label:'2026-09'},{label:'2026-10'}]},
    {ref:`readonly-${revision}`,tag:'input',role:'textbox',type:'text',label:'固定条件',readOnly:true},
    {ref:`search-${revision}`,tag:'input',role:'textbox',type:'search',label:'查询条件',readOnly:false},
    {ref:`filter-${revision}`,tag:'button',role:'button',label:'筛选合成记录',action:'filter'},
    {ref:`write-${revision}`,tag:'button',role:'button',label:'提交业务',action:'confirmation-required'},
    {ref:`first-${revision}`,tag:'input',role:'textbox',type:'text',label:'重名查询'},
    {ref:`second-${revision}`,tag:'input',role:'textbox',type:'text',label:'重名查询'}
  ]:[{ref:`password-${++revision}`,tag:'input',role:'textbox',type:'password',label:'合成密码',credential:true}]});
  const browser={open:async()=>({mode:'automatic'}),observe:async()=>page(),act:async(_id,action)=>{acts++;if(action.type==='select')month=action.value;},handoff:async()=>({mode:'manual'}),resume:async()=>page(),cancel:async()=>{closed++;}};
  const params={store,getSites:async()=>[site],getBrowser:async()=>browser,isCurrent:()=>true,authorize:async()=>allowed,...options};
  const demo=createDemonstration(params);
  t.after(async()=>{await demo.cancel({});await rm(dir,{recursive:true,force:true});});
  return {dir,store,demo,browser,page,params,logout:()=>{logged=false;},login:()=>{logged=true;},revoke:()=>{allowed=false;},counts:()=>({acts,closed})};
}

test('示范只公开安全唯一控件，凭据接管不进入模板，值预校验在动作前拒绝',async t=>{
  const f=await fixture(t);f.logout();let view=await f.demo.start(goal),id=view.taskId;
  assert.equal(view.page.loginRequired,true);assert.deepEqual(view.page.elements,[]);assert.equal(view.canFinish,false);
  await f.demo.handoff({id,siteId:site.id});f.login();view=await f.demo.resume({id});
  assert.deepEqual(view.page.elements.map(e=>e.name),['月份','查询条件','筛选合成记录']);
  const query=view.page.elements.find(e=>e.name==='查询条件');
  for(const value of ['password=synthetic-secret','x'.repeat(201)])await assert.rejects(f.demo.act({id,siteId:site.id,action:{type:'fill',ref:query.ref,value}}),error=>['AGENT_SENSITIVE_DATA','AGENT_INPUT_INVALID'].includes(error.code));
  assert.equal(f.counts().acts,0);
  const month=view.page.elements.find(e=>e.role==='combobox');view=await f.demo.act({id,siteId:site.id,action:{type:'select',ref:month.ref,value:'2026-09'}});
  assert.match(view.page.text,/2026-09/);await assert.rejects(f.demo.finish({id,confirmed:false}),/DEMONSTRATION_CONFIRMATION_REQUIRED/);
  await f.demo.finish({id,confirmed:true});
  const skill=await f.store.saveSkill({taskId:id,name:'示范月份筛选'}),stepIndex=skill.template.recipe.findIndex(entry=>entry.tool==='select');
  const updated=await f.store.editSkill({id:skill.id,expectedVersion:1,parameters:[{name:'month',label:'月份',stepIndex}]});assert.equal(updated.version,2);
  const disk=await readFile(join(f.dir,'agents','mock-acme','alice','state.json'),'utf8');
  for(const raw of ['temporary-','synthetic-page-only','synthetic-login-only','synthetic-secret','credential'])assert.ok(!disk.includes(raw));
});

test('未授权来源、重复站点和额外执行数据在创建示范前拒绝，初始读取失败不留下running',async t=>{
  const f=await fixture(t);
  for(const input of [{...goal,siteIds:['foreign']},{...goal,siteIds:[site.id,site.id]},{...goal,recipe:[]},{...goal,mode:'arbitrary'}])await assert.rejects(async()=>f.demo.start(input),/AGENT_SITE_SCOPE|DEMONSTRATION_INPUT_INVALID/);
  assert.deepEqual(await f.store.listTasks(),[]);
  f.browser.observe=async()=>{throw Object.assign(new Error('synthetic-raw-page-do-not-store'),{code:'BROWSER_OPERATION_FAILED'});};
  await assert.rejects(f.demo.start(goal),/synthetic-raw-page/);
  const task=(await f.store.listTasks())[0];assert.equal(task.status,'failed');assert.equal(task.error.code,'BROWSER_OPERATION_FAILED');assert.ok(!JSON.stringify(task).includes('synthetic-raw-page'));assert.equal(f.demo.snapshot(),null);assert.ok(f.counts().closed>0);
});

test('取消挂起的浏览器open或observe及时收尾，迟到结果不会重启任务或显示页面',async t=>{
  for(const method of ['open','observe'])await t.test(method,async sub=>{
    const f=await fixture(sub),held=deferred(),entered=deferred();f.browser[method]=async()=>{entered.resolve();return held.promise;};
    const starting=f.demo.start(goal),rejected=assert.rejects(starting,/CANCELLED/);await entered.promise;
    await limit(f.demo.cancel({}));await rejected;
    assert.equal(f.demo.snapshot(),null);assert.equal((await f.store.listTasks())[0].status,'cancelled');assert.ok(f.counts().closed>0);
    held.resolve(method==='open'?{mode:'automatic'}:f.page());await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.demo.active,false);assert.equal((await f.store.listTasks())[0].status,'cancelled');
  });
});

test('目录、账号和浏览器工厂等待均受操作时间预算约束',async t=>{
  for(const method of ['getSites','authorize','getBrowser'])await t.test(method,async sub=>{
    const never=new Promise(()=>{}),f=await fixture(sub,{timeoutMs:40,[method]:async()=>never});
    await assert.rejects(limit(f.demo.start(goal)),/DEMONSTRATION_TIMEOUT/);assert.equal(f.demo.active,false);assert.equal(f.demo.snapshot(),null);
    const tasks=await f.store.listTasks();if(method==='getBrowser')assert.equal(tasks[0].status,'failed');else assert.equal(tasks.length,0);
  });
});

test('授权接口异常也会中断旧示范并清页面，不把网络故障当成继续授权',async t=>{
  let unavailable=false;const f=await fixture(t,{authorize:async()=>{if(unavailable)throw Object.assign(new Error('synthetic-provider-sensitive-body'),{code:'SERVICE_UNAVAILABLE'});return true;}});
  const {taskId}=await f.demo.start(goal);unavailable=true;
  await assert.rejects(f.demo.observe({id:taskId,siteId:site.id}),/SERVICE_UNAVAILABLE/);
  const task=(await f.store.listTasks())[0];assert.equal(task.status,'interrupted');assert.equal(task.error.code,'SERVICE_UNAVAILABLE');assert.ok(!JSON.stringify(task).includes('sensitive-body'));assert.equal(f.demo.snapshot(),null);assert.ok(f.counts().closed>0);
});

test('完成落盘期间撤权能撤销未确认成功，已保存Skill的来源及其他终态不能被旧结果改写',async t=>{
  const f=await fixture(t);let view=await f.demo.start(goal),id=view.taskId;
  await f.demo.act({id,siteId:site.id,action:{type:'select',ref:view.page.elements[0].ref,value:'2026-09'}});
  // A trusted store wrapper simulates revocation after the completion rename, before its final check.
  let allowed=true;const second=await fixture(t,{authorize:async()=>allowed});
  const secondStore={...second.store,updateTask:async(taskId,patch)=>{const result=await second.store.updateTask(taskId,patch);if(patch.status==='completed')allowed=false;return result;}};
  const demo=createDemonstration({...second.params,store:secondStore});t.after(()=>demo.cancel({}));
  view=await demo.start(goal);id=view.taskId;await demo.act({id,siteId:site.id,action:{type:'select',ref:view.page.elements[0].ref,value:'2026-09'}});
  await assert.rejects(demo.finish({id,confirmed:true}),/AUTH_REQUIRED/);const task=(await second.store.listTasks())[0];assert.equal(task.status,'interrupted');assert.equal(demo.snapshot(),null);
  await assert.rejects(second.store.saveSkill({taskId:id,name:'不得保存未授权示范'}),/只有本人已完成/);
  await second.store.invalidateDemonstration(id,{status:'failed',expectedAttempt:task.attempt});assert.equal((await second.store.listTasks())[0].status,'interrupted');
  await f.demo.finish({id:(await f.store.listTasks())[0].id,confirmed:true});const completed=(await f.store.listTasks())[0],skill=await f.store.saveSkill({taskId:completed.id,name:'完成的示范'});
  await assert.rejects(f.store.invalidateDemonstration(completed.id,{status:'interrupted',expectedAttempt:completed.attempt}),error=>error.code==='AGENT_TASK_TERMINAL');assert.equal((await f.store.listSkills())[0].id,skill.id);
});

test('重启后的登录接管示范变为中断，不能交给普通模型恢复，仍能开始新的示范',async t=>{
  const f=await fixture(t);f.logout();const started=await f.demo.start(goal);await f.demo.handoff({id:started.taskId,siteId:site.id});
  const file=join(f.dir,'agents','mock-acme','alice','state.json'),state=JSON.parse(await readFile(file,'utf8'));state.tasks[0].sessionId='previous-process-session';await writeFile(file,JSON.stringify(state));
  const task=(await f.store.listTasks())[0];assert.equal(task.status,'interrupted');assert.equal(task.execution,'demonstration');
  await assert.rejects(f.store.resumeTask(task.id),error=>error.code==='DEMONSTRATION_RESUME_REQUIRED');
  await assert.rejects(f.store.resumeTask(task.id,{execution:'demonstration'}),error=>error.code==='DEMONSTRATION_RESUME_REQUIRED');
  const next=createDemonstration(f.params);t.after(()=>next.cancel({}));
  await assert.rejects(async()=>next.resume({id:task.id}),/DEMONSTRATION_NOT_ACTIVE/);
  const restarted=await next.start(goal);assert.notEqual(restarted.taskId,task.id);await next.cancel({});
});
