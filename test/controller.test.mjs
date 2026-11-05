import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv,createDecipheriv,randomBytes } from 'node:crypto';
import { createController } from '../src/controller.mjs';

async function fixture(t,options={}) {
  const dataDir=await mkdtemp(join(tmpdir(),'yuanyu-controller-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const key=randomBytes(32);
  const cryptoAdapter={available:()=>true,encrypt:text=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);const out=Buffer.concat([c.update(text),c.final()]);return Buffer.concat([iv,c.getAuthTag(),out]).toString('base64');},decrypt:text=>{const buf=Buffer.from(text,'base64'),d=createDecipheriv('aes-256-gcm',key,buf.subarray(0,12));d.setAuthTag(buf.subarray(12,28));return Buffer.concat([d.update(buf.subarray(28)),d.final()]).toString();}};
  const systems=Object.fromEntries([['procurement',15331],['warehouse',15332]].map(([id,port])=>[id,{id,label:id,origin:`http://127.0.0.1:${port}`,url:`http://127.0.0.1:${port}/`}]));
  let browserCalls=0;
  const controller=await createController({dataDir,cryptoAdapter,systems,BrowserWindow:class {constructor(){browserCalls++;throw new Error('NO_BROWSER_ALLOWED');}},...options});
  t.after(()=>controller.close());return {controller,dataDir,browserCalls:()=>browserCalls};
}
test('starting阶段立即取消及关闭不会漏接或打开浏览器',async t=>{
  const {controller,browserCalls}=await fixture(t);
  await controller.invoke('task.plan',{text:'采购月报',month:'2026-10'});
  const starting=controller.invoke('task.run',{month:'2026-10'});
  const cancelled=await controller.invoke('run.cancel');await starting;await controller.waitForIdle();
  assert.equal(cancelled.cancelled,true);assert.equal(browserCalls(),0);assert.equal((await controller.snapshot()).runs[0].status,'cancelled');
  await controller.invoke('task.plan',{text:'采购月报',month:'2026-09'});
  const next=controller.invoke('task.run',{month:'2026-09'});await controller.close();await next;
  assert.equal(browserCalls(),0);assert.equal((await controller.snapshot()).runs[0].status,'cancelled');
});
test('模型只形成待确认计划且切换身份丢弃迟到结果，不把新身份配置交给旧请求',async t=>{
  let finish,profile,ready;const called=new Promise(resolve=>{ready=resolve;});
  const {controller,browserCalls}=await fixture(t,{planningGateway:async input=>{profile=input.file;return new Promise(resolve=>{finish=resolve;ready();});}});
  await assert.rejects(controller.invoke('task.modelPlan',{text:'整理采购月报',month:'2026-10'}),/MODEL_CONSENT_REQUIRED/);
  const plan=controller.invoke('task.modelPlan',{text:'整理采购月报',month:'2026-10',consent:true});
  await called;assert.ok(profile.includes('alice'));
  await controller.invoke('identity.switch',{userId:'bob'});
  finish({supported:true,recipeId:'purchase-monthly',mode:'compatible',month:'2026-10',message:'合成模型计划'});
  await assert.rejects(plan,/CANCELLED/);assert.equal((await controller.snapshot()).identity.userId,'bob');assert.equal(browserCalls(),0);
  await assert.rejects(controller.invoke('task.run',{month:'2026-10'}),/PLAN_REQUIRED/);
});
test('原型键或非法身份不改变当前身份、凭据或有效计划',async t=>{
  const {controller}=await fixture(t);
  await controller.invoke('credential.save',{systemId:'procurement',username:'test-person',password:'synthetic-password'});
  await controller.invoke('task.plan',{text:'采购月报',month:'2026-10'});
  for(const userId of ['constructor','__proto__','toString','unknown',null])await assert.rejects(controller.invoke('identity.switch',{userId}),/IDENTITY_INVALID/);
  assert.equal((await controller.snapshot()).identity.userId,'alice');assert.equal((await controller.snapshot()).credentials.length,1);
  const next=controller.invoke('task.run',{month:'2026-10'});await controller.close();await next;
  assert.equal((await controller.snapshot()).runs[0].status,'cancelled');
});
test('计划参数不匹配、未经计划、跨身份旧计划拒绝',async t=>{
  const {controller}=await fixture(t);
  await assert.rejects(controller.invoke('task.run',{month:'2026-10'}),/PLAN_REQUIRED/);
  await controller.invoke('task.plan',{text:'采购月报',month:'2026-10'});
  await assert.rejects(controller.invoke('task.run',{month:'2026-09'}),/PLAN_REQUIRED/);
  await controller.invoke('identity.switch',{userId:'bob'});
  await assert.rejects(controller.invoke('task.run',{month:'2026-10'}),/PLAN_REQUIRED/);
});

test('通用浏览器启动与采购执行互斥，立即取消不打开窗口或留下running',async t=>{
  const builtinSites=[{id:'interactive-mock',origin:'http://127.0.0.1:15333',label:'合成站点',paths:['/'],entryPath:'/'}];
  const {controller,browserCalls}=await fixture(t,{builtinSites});
  const starting=controller.invoke('agent.start',{goal:'读取2026-09合成记录',siteIds:['interactive-mock'],mode:'mock_browser'});
  await assert.rejects(controller.invoke('task.plan',{text:'采购月报',month:'2026-10'}),/BUSY/);
  await controller.invoke('run.cancel');const {taskId}=await starting;await controller.waitForIdle();
  const state=await controller.snapshot();assert.equal(state.agentTasks.find(t=>t.id===taskId).status,'cancelled');assert.equal(state.runs.length,0);assert.equal(browserCalls(),0);assert.equal(state.busy,false);
});

test('通用浏览器通过控制器使用兼容网关，私有skill不能误存为采购配方',async t=>{
  const {writeFile,mkdir}=await import('node:fs/promises');const {createBrowserModelRequester}=await import('../src/model/gateway.mjs');
  let turn=0,requests=0,closed=0,open=false;
  const browser={open:async()=>{open=true;return {mode:'automatic'};},observe:async()=>({text:'合成测试采购单已入库',elements:[]}),cancel:async()=>{},close:async()=>{closed++;}};
  const factory=options=>createBrowserModelRequester({...options,fetchImpl:async(_url,request)=>{
    requests++;const body=JSON.parse(request.body);assert.ok(!request.body.includes('synthetic-controller-key'));assert.equal(body.model,'synthetic-controller');
    const name=++turn===1?'browser_open':turn===2?'browser_observe':null;
    const message=name?{tool_calls:[{id:`step-${turn}`,function:{name,arguments:JSON.stringify({siteId:'site-business'})}}]}:{content:'根据当前合成页面，采购单已入库；未覆盖其他系统。'};
    return new Response(JSON.stringify({choices:[{message}]}));
  }});
  const {controller,dataDir}=await fixture(t,{interactiveFactory:()=>browser,agentRequesterFactory:factory});
  const site=await controller.invoke('site.register',{id:'site-business',label:'合成业务配置',origin:'https://fixture.example.invalid',entryPath:'/',paths:['/']});
  const file=join(dataDir,'models','mock-acme','alice','model.local.json'),apiKeyFile=join(dataDir,'synthetic.key');await mkdir(join(dataDir,'models','mock-acme','alice'),{recursive:true});await writeFile(apiKeyFile,'synthetic-controller-key');
  await writeFile(file,JSON.stringify({schemaVersion:1,enabled:true,baseUrl:'https://provider.example.invalid/v1',model:'synthetic-controller',apiKeyFile,dataScope:'selected_pages'}));
  const {taskId}=await controller.invoke('agent.start',{goal:'查看合成业务状态',siteIds:[site.id],mode:'compatible_browser',consent:{taskText:true,pageContent:true}});await controller.waitForIdle();
  assert.equal((await controller.snapshot()).agentTasks[0].status,'completed');assert.equal(requests,3);assert.equal(open,true);
  await assert.rejects(controller.invoke('workflow.save',{runId:taskId,name:'错误月报',pinned:true}));
  const skill=await controller.invoke('agent.skill.save',{taskId,name:'查看业务状态',pinned:true});assert.equal(skill.kind,'browser');assert.equal(skill.template.siteBindings[0].revision,1);
  await controller.invoke('site.update',{...site,revision:undefined,expectedRevision:1,label:'新来源配置'});
  await assert.rejects(controller.invoke('agent.skill.run',{id:skill.id,mode:'compatible_browser',consent:{taskText:true,pageContent:true}}),/AGENT_BINDINGS_CHANGED/);assert.equal(requests,3);
  await controller.invoke('identity.switch',{userId:'bob'});assert.equal((await controller.snapshot()).agentTasks.length,0);assert.equal((await controller.snapshot()).agentSkills.length,0);assert.ok(closed>=1);
});

test('站点变更全程互斥，不会并发覆盖已启动的通用runtime',async t=>{
  const builtinSites=[{id:'interactive-mock',origin:'http://127.0.0.1:15333',label:'合成站点',paths:['/'],entryPath:'/'}];
  const {controller,browserCalls}=await fixture(t,{builtinSites});
  const site={id:'site-one',origin:'https://fixture.example.invalid',label:'隔离配置',paths:['/'],entryPath:'/'};
  const register=controller.invoke('site.register',site);
  await assert.rejects(controller.invoke('agent.start',{goal:'合成记录',siteIds:['interactive-mock'],mode:'mock_browser'}),/BUSY/);
  await assert.rejects(controller.invoke('identity.switch',{userId:'bob'}),/BUSY/);await register;
  const update=controller.invoke('site.update',{...site,label:'修订',expectedRevision:1});
  await assert.rejects(controller.invoke('task.plan',{text:'采购月报',month:'2026-10'}),/BUSY/);await update;
  const remove=controller.invoke('site.delete',{id:site.id,expectedRevision:2});
  await assert.rejects(controller.invoke('agent.start',{goal:'合成记录',siteIds:['interactive-mock'],mode:'mock_browser'}),/BUSY/);await remove;
  const state=await controller.snapshot();assert.equal(state.agentTasks.length,0);assert.equal(state.busy,false);assert.equal(browserCalls(),0);
});

test('身份切换期间的并发snapshot不会混合Alice任务与Bob身份',async t=>{
  const builtinSites=[{id:'interactive-mock',origin:'http://127.0.0.1:15333',label:'合成站点',paths:['/'],entryPath:'/'}];
  const {controller}=await fixture(t,{builtinSites,interactiveFactory:()=>({open:async()=>({mode:'automatic'}),observe:async()=>({text:'需登录',elements:[{credential:true}]}),handoff:async()=>({}),cancel:async()=>{},close:async()=>{}})});
  await controller.invoke('agent.start',{goal:'合成记录',siteIds:['interactive-mock'],mode:'mock_browser'});await controller.waitForIdle();
  const pendingSnapshots=Array.from({length:12},()=>controller.snapshot());const switching=controller.invoke('identity.switch',{userId:'bob'});
  for(const state of await Promise.all(pendingSnapshots))assert.equal(state.agentTasks.length,state.identity.userId==='alice'?1:0);
  await switching;const state=await controller.snapshot();assert.equal(state.identity.userId,'bob');assert.equal(state.agentTasks.length,0);
});
