import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createAgentStore} from '../src/agent/store.mjs';
import {createAgentRuntime,replayRecipe} from '../src/agent/runtime.mjs';
import {safeError} from '../src/controller.mjs';

const modelCall=(name,input)=>({tool_calls:[{id:'synthetic-step',type:'function',function:{name,arguments:JSON.stringify(input)}}]});
async function fixture(t,options={}){
  const dir=await mkdtemp(join(tmpdir(),'yuanyu-agent-runtime-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=createAgentStore({dataDir:dir,identity:{companyId:'mock-acme',userId:'alice',displayName:'合成测试成员',provider:'mock'}});
  let logged=false,selected='2026-10',filtered='2026-10',cancelled=0,acts=0,current=true;
  let sites=[{id:'interactive-mock',origin:'http://127.0.0.1:15333',revision:1,builtin:true},{id:'test-site',origin:'https://fixture.example.invalid',revision:1,builtin:false}];
  const ref=()=>`r-${randomUUID()}-1`;
  const browser={open:async()=>({status:'opened'}),resume:async()=>browser.observe(),handoff:async()=>({status:'awaiting-user'}),cancel:async()=>{cancelled++;},observe:async()=>({text:logged?`结果 ${filtered==='2026-09'?'SYN-091 9087':'SYN-101 12345'}`:'请登录',elements:logged?[{ref:ref(),tag:'select',label:'月份',credential:false},{ref:ref(),tag:'button',label:'筛选合成记录',credential:false}]:[{ref:ref(),tag:'input',label:'合成账号',credential:true}]}),act:async(_id,action)=>{acts++;if(action.type==='select')selected=action.value;if(action.type==='click')filtered=selected;return {status:'acted'};}};
  const runtime=createAgentRuntime({store,getSites:async()=>sites,getBrowser:async()=>browser,isCurrent:()=>current,onUpdate:async()=>{},modelFile:join(dir,'model.local.json'),safeError,...options});
  t.after(()=>runtime.cancel());
  return {store,runtime,browser,login:()=>{logged=true;},logout:()=>{logged=false;},invalidate:()=>{sites=sites.map(s=>({...s,revision:2}));},revoke:()=>{current=false;},counts:()=>({cancelled,acts})};
}
test('通用任务真正等用户接管再读取，保存独立技能并用新引用只读复跑',async t=>{
  const f=await fixture(t);
  const {taskId}=await f.runtime.start({goal:'读取2026-09合成记录',siteIds:['interactive-mock'],mode:'mock_browser'});await f.runtime.waitForIdle();
  assert.equal((await f.store.listTasks())[0].status,'awaiting_user');
  f.login();await f.runtime.resume({id:taskId});await f.runtime.waitForIdle();
  const task=(await f.store.listTasks())[0];assert.equal(task.status,'completed',JSON.stringify(task.error));assert.match(task.message,/SYN-091.*9087/);
  const skill=await f.runtime.saveSkill({taskId,name:'合成记录',pinned:true});assert.equal(skill.template.recipe.filter(s=>s.tool==='select').length,1);assert.equal(skill.template.recipe.filter(s=>s.tool==='open').length,1);
  assert.ok(!JSON.stringify(skill).includes('r-'));assert.ok(!JSON.stringify(skill).includes('purchase-monthly'));
  const repeat=await f.runtime.runSkill({id:skill.id,mode:'mock_browser'});await f.runtime.waitForIdle();
  const rerun=(await f.store.listTasks()).find(t=>t.id===repeat.taskId);assert.equal(rerun.status,'completed',JSON.stringify(rerun.error));assert.ok(rerun.steps.length>0);assert.equal(f.counts().acts,4);
});
test('合成不能借入真实站点，页面双同意缺失在模型工厂前拒绝',async t=>{
  let factories=0;const f=await fixture(t,{requesterFactory:async()=>{factories++;throw Error('unexpected');}});
  await assert.rejects(f.runtime.start({goal:'合成任务',siteIds:['test-site'],mode:'mock_browser'}),/AGENT_SITE_SCOPE/);
  await assert.rejects(f.runtime.start({goal:'业务任务',siteIds:['test-site'],mode:'compatible_browser',consent:{taskText:true,pageContent:false}}),/PAGE_CONTENT_CONSENT_REQUIRED/);
  assert.equal(factories,0);assert.equal((await f.store.listTasks()).length,0);
});
test('站点revision变化阻止恢复与保存，未授权模型不执行其他来源',async t=>{
  const f=await fixture(t);const {taskId}=await f.runtime.start({goal:'合成记录',siteIds:['interactive-mock'],mode:'mock_browser'});await f.runtime.waitForIdle();f.invalidate();
  await assert.rejects(f.runtime.resume({id:taskId}),/AGENT_BINDINGS_CHANGED/);
  await assert.rejects(f.runtime.saveSkill({taskId,name:'旧站点流程'}),/AGENT_BINDINGS_CHANGED/);
  assert.equal((await f.store.listTasks())[0].status,'awaiting_user');await f.runtime.cancel(taskId);assert.equal((await f.store.listTasks())[0].status,'cancelled');
});
test('取消模型等待关闭原会话且迟到成功不能写入终态',async t=>{
  let resolveModel,called;const entered=new Promise(r=>{called=r;});
  const f=await fixture(t,{requesterFactory:async()=>async()=>{called();return new Promise(r=>{resolveModel=r;});}});
  const {taskId}=await f.runtime.start({goal:'合成业务查看',siteIds:['test-site'],mode:'compatible_browser',consent:{taskText:true,pageContent:true}});await entered;
  await f.runtime.cancel(taskId);resolveModel({content:'迟到结果'});await f.runtime.waitForIdle();
  assert.equal((await f.store.listTasks())[0].status,'cancelled');assert.equal(f.counts().cancelled,1);assert.equal(f.runtime.busy,false);
});
test('执行中身份失效会留下可处理的中断，模型未观察就宣称成功会失败',async t=>{
  let f;f=await fixture(t,{getBrowser:async()=>{f.revoke();return f.browser;}});
  await f.runtime.start({goal:'合成记录',siteIds:['interactive-mock'],mode:'mock_browser'});await f.runtime.waitForIdle();assert.equal((await f.store.listTasks())[0].status,'interrupted');assert.equal(f.runtime.busy,false);
  const g=await fixture(t,{requesterFactory:async()=>async()=>({content:'当然可以，已完成'})});
  await g.runtime.start({goal:'业务查看',siteIds:['test-site'],mode:'compatible_browser',consent:{taskText:true,pageContent:true}});await g.runtime.waitForIdle();
  assert.equal((await g.store.listTasks())[0].error.code,'AGENT_RESULT_UNVERIFIED');
});
test('不可持久化的查询值在浏览器动作前拒绝；重放歧义不能任选一个按钮',async t=>{
  let turn=0;
  const f=await fixture(t,{requesterFactory:async()=>async({messages})=>{
    turn++;if(turn===1)return modelCall('browser_observe',{siteId:'test-site'});
    const page=JSON.parse(messages.at(-1).content);return modelCall('browser_act',{siteId:'test-site',action:{type:'fill',ref:page.elements[0].ref,value:'x'.repeat(201)}});
  }});f.login();f.browser.observe=async()=>({text:'合成搜索页面',elements:[{ref:`r-${randomUUID()}-1`,tag:'input',label:'搜索',credential:false}]});
  await f.runtime.start({goal:'合成业务查询',siteIds:['test-site'],mode:'compatible_browser',consent:{taskText:true,pageContent:true}});await f.runtime.waitForIdle();assert.equal((await f.store.listTasks())[0].status,'failed');assert.equal(f.counts().acts,0);
  await assert.rejects(replayRecipe({recipe:[{tool:'click',siteId:'test-site',locator:{role:'button',name:'查询',readOnly:true}}],check:async()=>{},browser:{observe:async()=>({elements:[{tag:'button',label:'查询'},{tag:'button',label:'查询'}]})}}),/PAGE_STRUCTURE_CHANGED/);
});

test('目录I/O期间撤权在各个分派检查点都不能放行旧身份浏览器动作',async t=>{
  for(let revokeAt=1;revokeAt<=20;revokeAt++){
    let f,reads=0,current=true;const opened=[];
    f=await fixture(t,{getSites:async()=>{await Promise.resolve();if(++reads===revokeAt){current=false;f.revoke();}return [{id:'interactive-mock',origin:'http://127.0.0.1:15333',revision:1,builtin:true}];}});
    const original=f.browser.open;f.browser.open=async(...args)=>{opened.push({current});return original(...args);};
    try{await f.runtime.start({goal:'合成记录',siteIds:['interactive-mock'],mode:'mock_browser'});}catch(error){assert.equal(error.code,'CANCELLED');}
    await f.runtime.waitForIdle();assert.ok(opened.every(entry=>entry.current),`第${revokeAt}次目录检查撤权后仍执行了旧身份动作`);
    const task=(await f.store.listTasks())[0];if(task)assert.notEqual(task.status,'running');
  }
});

test('参数化Skill实际读取不同月份，人工接管后保留原运行参数并拒绝修订后续跑',async t=>{
  const f=await fixture(t);f.login();const {taskId}=await f.runtime.start({goal:'读取2026-09合成记录',siteIds:['interactive-mock'],mode:'mock_browser'});await f.runtime.waitForIdle();
  const skill=await f.runtime.saveSkill({taskId,name:'原查询'}),stepIndex=skill.template.recipe.findIndex(entry=>entry.tool==='select');
  await f.store.editSkill({id:skill.id,expectedVersion:1,name:'月份参数查询',parameters:[{name:'month',label:'月份',stepIndex}]});
  const before=f.counts().acts;
  await assert.rejects(f.runtime.runSkill({id:skill.id,mode:'mock_browser',expectedVersion:1}),{code:'AGENT_SKILL_VERSION_CHANGED'});
  await assert.rejects(f.runtime.runSkill({id:skill.id,mode:'mock_browser',values:{month:'password=synthetic-secret'}}),{code:'AGENT_SENSITIVE_DATA'});assert.equal(f.counts().acts,before);
  f.logout();const run=await f.runtime.runSkill({id:skill.id,mode:'mock_browser',values:{month:'2026-10'}});await f.runtime.waitForIdle();
  let current=(await f.store.listTasks()).find(entry=>entry.id===run.taskId);assert.equal(current.status,'awaiting_user');assert.deepEqual(current.parameterValues,{month:'2026-10'});assert.equal(current.skillVersion,2);
  f.login();await f.runtime.resume({id:run.taskId});await f.runtime.waitForIdle();
  current=(await f.store.listTasks()).find(entry=>entry.id===run.taskId);assert.equal(current.status,'completed',JSON.stringify(current.error));assert.equal(current.trace.find(entry=>entry.tool==='select').value,'2026-10');assert.match((await f.browser.observe()).text,/SYN-101 12345/);
  assert.equal((await f.store.listSkills())[0].template.recipe[stepIndex].value,'2026-09');
  f.logout();const pending=await f.runtime.runSkill({id:skill.id,mode:'mock_browser'});await f.runtime.waitForIdle();
  await f.store.editSkill({id:skill.id,expectedVersion:2,name:'已修订'});
  await assert.rejects(f.runtime.resume({id:pending.taskId}),{code:'AGENT_SKILL_VERSION_CHANGED'});
});
