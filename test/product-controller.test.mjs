import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {createPromotionService} from '../src/service/index.mjs';
import {createProductClient} from '../src/product/client.mjs';
import {createController,safeError} from '../src/controller.mjs';

const password='synthetic-account-password-2026',apiKey='synthetic-private-model-key';
function adapter(){const key=randomBytes(32);return {available:()=>true,
  encrypt:text=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([cipher.update(text),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');},
  decrypt:text=>{const bytes=Buffer.from(text,'base64'),cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8');}};}
async function fixture(t,options={}){
  const root=await mkdtemp(join(tmpdir(),'yuanyu-product-controller-')),dataDir=join(root,'client');
  const service=await createPromotionService({dataDir:join(root,'service'),demo:true,monthlyTokens:100000,dailyRequests:20});
  const cryptoAdapter=adapter(),client=createProductClient({dataDir,cryptoAdapter,baseUrl:service.url,allowLocalDemo:true});
  const systems=Object.fromEntries([['procurement',15331],['warehouse',15332]].map(([id,port])=>[id,{id,label:id,origin:`http://127.0.0.1:${port}`,url:`http://127.0.0.1:${port}/`}]));
  let browserCalls=0;
  const controller=await createController({dataDir,cryptoAdapter,systems,productClient:client,BrowserWindow:class{constructor(){browserCalls++;throw new Error('NO_BROWSER_ALLOWED');}},...options});
  t.after(async()=>{await controller.close();await service.close();await rm(root,{recursive:true,force:true});});
  const register=async(email='personal@example.invalid',name='合成人员')=>controller.invoke('auth.register',{email,password,name});
  return {controller,service,client,register,dataDir,browserCalls:()=>browserCalls};
}
const modelInput=extra=>({label:'私有测试模型',provider:'custom',baseUrl:'https://synthetic-model.example.invalid/v1',model:'synthetic-test',dataScope:'selected_pages',apiKey,...extra});

test('个人入口注册前不暴露Mock身份或私有状态，注册后仅获得个人账户且不能升级公司权限',async t=>{
  const f=await fixture(t),initial=await f.controller.snapshot();
  assert.equal(initial.identity,null);assert.equal(initial.product.authenticated,false);assert.equal(initial.product.developer.contact,'wsltest');
  for(const key of ['credentials','workflows','runs','agentTasks','agentSkills','sites','agentSites'])assert.deepEqual(initial[key],[]);
  await assert.rejects(f.controller.invoke('credential.save',{systemId:'procurement',username:'synthetic',password}),/AUTH_REQUIRED/);
  const result=await f.register(),state=await f.controller.snapshot();
  assert.equal(state.identity.provider,'account');assert.equal(state.identity.companyId,`personal-${result.account.id}`);assert.equal(state.product.account.tier,'personal');
  assert.equal(state.shared.length,1);assert.equal(state.shared[0].publicSample,true);
  for(const [action,payload,code] of [
    ['identity.switch',{userId:'alice'},'MOCK_IDENTITY_DISABLED'],
    ['workflow.import',{publicationId:'sample-purchase-monthly'},'ENTERPRISE_REQUIRED'],
    ['workflow.publish',{id:'forged'},'ENTERPRISE_REQUIRED'],
    ['workflow.revoke',{id:'forged'},'ENTERPRISE_REQUIRED']
  ])await assert.rejects(f.controller.invoke(action,payload),new RegExp(code));
  assert.equal(f.browserCalls(),0);assert.ok(!JSON.stringify(state).includes(password));
});

test('双账户凭据、站点、BYOK配置和浏览器任务隔离；回到本人账户完整恢复',async t=>{
  const builtinSites=[{id:'interactive-mock',origin:'http://127.0.0.1:15333',label:'合成站点',paths:['/'],entryPath:'/'}];
  const browser={open:async()=>({mode:'automatic'}),observe:async()=>({text:'需登录',elements:[{credential:true}]}),handoff:async()=>({}),cancel:async()=>{},close:async()=>{}};
  const f=await fixture(t,{builtinSites,interactiveFactory:()=>browser}),first=await f.register();
  await f.controller.invoke('credential.save',{systemId:'procurement',username:'synthetic-first',password});
  await f.controller.invoke('site.register',{id:'site-personal',label:'个人测试站点',origin:'https://business.example.invalid',entryPath:'/',paths:['/']});
  const profile=await f.controller.invoke('model.profile.save',modelInput());
  await f.controller.invoke('agent.start',{goal:'读取2026-10合成记录',siteIds:['interactive-mock'],mode:'mock_browser'});await f.controller.waitForIdle();
  const firstState=await f.controller.snapshot();assert.equal(firstState.agentTasks.length,1);assert.equal(firstState.agentTasks[0].status,'awaiting_user');assert.equal(firstState.product.modelSource,'byok');
  const disk=await readFile(join(f.dataDir,'model-profiles',firstState.identity.companyId,firstState.identity.userId,'state.json'),'utf8');assert.ok(!disk.includes(apiKey));
  await f.controller.invoke('auth.logout');const second=await f.register('second-personal@example.invalid','第二位合成人员');
  const next=await f.controller.snapshot();assert.notEqual(next.identity.userId,firstState.identity.userId);assert.equal(next.credentials.length,0);assert.equal(next.sites.length,0);assert.equal(next.agentTasks.length,0);assert.equal(next.modelProfiles.profiles.length,0);assert.equal(next.product.modelSource,'sponsored');
  await assert.rejects(f.controller.invoke('model.profile.select',{id:profile.id}),/MODEL_PROFILE_NOT_FOUND/);
  await assert.rejects(f.controller.invoke('credential.delete',{id:firstState.credentials[0].id}),/当前用户没有此凭据/);
  await assert.rejects(f.controller.invoke('agent.resume',{id:firstState.agentTasks[0].id}),/AGENT_TASK_NOT_FOUND/);
  await f.controller.invoke('auth.logout');await f.controller.invoke('auth.login',{email:first.account.email,password});
  const restored=await f.controller.snapshot();assert.equal(restored.identity.userId,firstState.identity.userId);assert.equal(restored.credentials.length,1);assert.equal(restored.sites.length,1);assert.equal(restored.modelProfiles.activeId,profile.id);assert.equal(restored.product.modelSource,'byok');assert.equal(restored.agentTasks[0].id,firstState.agentTasks[0].id);assert.notEqual(second.account.id,first.account.id);
  assert.ok(!JSON.stringify(restored).includes(apiKey));assert.ok(!JSON.stringify(restored).includes(password));
});

test('真实HTTP会话撤销后立即隐藏私有状态并拒绝后续操作；登录恢复本人数据',async t=>{
  const f=await fixture(t),registered=await f.register();
  await f.controller.invoke('credential.save',{systemId:'warehouse',username:'synthetic-first',password});
  await f.controller.invoke('model.profile.save',modelInput());
  await f.controller.invoke('site.register',{id:'site-private',label:'私人业务入口',origin:'https://private-business.example.invalid',entryPath:'/',paths:['/']});
  f.service.operator.revokeSessions(registered.account.id);
  const state=await f.controller.snapshot();assert.equal(state.product.authenticated,false);assert.equal(state.identity,null);assert.deepEqual(state.credentials,[]);
  assert.equal(Object.hasOwn(state.model,'model'),false);assert.equal(Object.hasOwn(state.model,'host'),false);assert.equal(Object.hasOwn(state.model,'profileId'),false);
  assert.equal(state.systems.some(system=>system.id==='site-private'),false);
  await assert.rejects(f.controller.invoke('task.plan',{text:'采购月报',month:'2026-10'}),/AUTH_REQUIRED/);
  await f.controller.invoke('auth.login',{email:registered.account.email,password});assert.equal((await f.controller.snapshot()).credentials.length,1);
});

test('浏览器IO期间撤销账号阻止下一次读取和迟到成功，不将未授权执行标为完成',async t=>{
  let f,accountId,observed=0;
  const builtinSites=[{id:'interactive-mock',origin:'http://127.0.0.1:15333',label:'合成站点',paths:['/'],entryPath:'/'}];
  f=await fixture(t,{builtinSites,interactiveFactory:()=>({open:async()=>{f.service.operator.revokeSessions(accountId);return {mode:'automatic'};},observe:async()=>{observed++;return {text:'合成资料',elements:[]};},cancel:async()=>{},close:async()=>{}})});
  const registered=await f.register();accountId=registered.account.id;
  const {taskId}=await f.controller.invoke('agent.start',{goal:'读取2026-10合成记录',siteIds:['interactive-mock'],mode:'mock_browser'});await f.controller.waitForIdle();
  assert.equal(observed,0);assert.equal((await f.controller.snapshot()).identity,null);
  await f.controller.invoke('auth.login',{email:registered.account.email,password});const task=(await f.controller.snapshot()).agentTasks.find(t=>t.id===taskId);
  assert.equal(task.status,'failed');assert.equal(task.error.code,'AUTH_REQUIRED');assert.ok(!JSON.stringify(task).includes(password));
});

test('固定采购任务读取期间撤销会话，不继续跨系统读取或交付文件',async t=>{
  let f,accountId;const reads=[];
  class SyntheticWindow extends EventEmitter{
    constructor(options){
      super();this.system=options.title;this.destroyed=false;const contents=new EventEmitter(),session=new EventEmitter();this.webContents=contents;
      session.setPermissionRequestHandler=()=>{};session.setPermissionCheckHandler=()=>{};session.webRequest={onBeforeRequest:()=>{}};contents.session=session;contents.setWindowOpenHandler=()=>{};contents.getURL=()=>this.url;
      contents.executeJavaScript=async script=>{
        const data=JSON.parse(/\)\((\{.*\})\)$/s.exec(script)[1]);
        if(script.includes('function login(')){this.url=data.origin+(this.system==='procurement'?'/orders':'/receipts');queueMicrotask(()=>contents.emit('did-finish-load'));return true;}
        if(script.includes('function filter(')){this.url=data.origin+data.path+'?month='+data.month;queueMicrotask(()=>contents.emit('did-finish-load'));return true;}
        reads.push(this.system);if(this.system==='procurement')f.service.operator.revokeSessions(accountId);
        return {rows:[],source:{systemId:this.system,url:this.url,month:data.month,readAt:new Date().toISOString()}};
      };
    }
    async loadURL(url){this.url=url;}
    isDestroyed(){return this.destroyed;}
    destroy(){this.destroyed=true;this.emit('closed');this.webContents.emit('destroyed');}
  }
  f=await fixture(t,{BrowserWindow:SyntheticWindow});const registered=await f.register();accountId=registered.account.id;
  for(const systemId of ['procurement','warehouse'])await f.controller.invoke('credential.save',{systemId,username:'synthetic-only',password});
  await f.controller.invoke('task.plan',{text:'整理采购月报',month:'2026-10'});const {runId}=await f.controller.invoke('task.run',{month:'2026-10'});await f.controller.waitForIdle();
  await f.controller.invoke('auth.login',{email:registered.account.email,password});const run=(await f.controller.snapshot()).runs.find(r=>r.id===runId);
  assert.deepEqual(reads,['procurement']);assert.equal(run.status,'failed');assert.equal(run.artifact,undefined);assert.equal(run.error.code,'AUTH_REQUIRED');
});

test('模型探测必须逐次明确同意；登出抑制迟到结果，不借用下一账号的模型',async t=>{
  let finish,ready;const started=new Promise(resolve=>{ready=resolve;});let probes=0;
  const f=await fixture(t,{modelProbe:async()=>{probes++;ready();return new Promise(resolve=>{finish=resolve;});}});await f.register();await f.controller.invoke('model.profile.save',modelInput());
  await assert.rejects(f.controller.invoke('model.test',{}),/MODEL_CONSENT_REQUIRED/);assert.equal(probes,0);
  const result=f.controller.invoke('model.test',{consent:true}),rejected=assert.rejects(result,/CANCELLED/);await started;
  await f.controller.invoke('auth.logout');assert.equal((await f.controller.snapshot()).identity,null);finish({connected:true,source:'byok'});
  await rejected;await f.register('next-personal@example.invalid','下一位合成人员');assert.equal(probes,1);const state=await f.controller.snapshot();assert.equal(state.product.modelSource,'sponsored');assert.equal(state.modelProfiles.profiles.length,0);
});

test('面向渲染器的错误仅含稳定错误码和安全说明',()=>{
  const error=safeError({code:'AUTH_REQUIRED',message:password,stack:apiKey});
  assert.equal(error.code,'AUTH_REQUIRED');assert.ok(!JSON.stringify(error).includes(password));assert.ok(!JSON.stringify(error).includes(apiKey));assert.deepEqual(Object.keys(error),['code','message']);
});

test('删除本人当前模型后不得静默改用旧配置提供方',async t=>{
  let calls=0;const f=await fixture(t,{planningGateway:async()=>{calls++;return {supported:false};}});await f.register();
  const state=await f.controller.snapshot(),dir=join(f.dataDir,'models',state.identity.companyId,state.identity.userId);
  await mkdir(dir,{recursive:true});await writeFile(join(dir,'model.local.json'),JSON.stringify({schemaVersion:1,enabled:true,baseUrl:'https://legacy.example.invalid/v1',model:'legacy-synthetic',apiKeyFile:join(f.dataDir,'external-key.txt'),dataScope:'task_text'}));
  const profile=await f.controller.invoke('model.profile.save',modelInput());await f.controller.invoke('model.profile.delete',{id:profile.id});
  assert.equal((await f.controller.snapshot()).model.status,'not_configured');
  await assert.rejects(f.controller.invoke('task.modelPlan',{text:'采购月报',month:'2026-10',consent:true}),/MODEL_NOT_CONFIGURED/);
  assert.equal(calls,0);
});

test('合成业务必须预览确认，重复确认只有一条源记录，换账号不能读取回执',async t=>{
  const copied=[];const f=await fixture(t,{copyText:text=>copied.push(text)});
  await f.controller.invoke('developer.contact.copy',{text:'forged'});assert.deepEqual(copied,['wsltest']);
  await assert.rejects(f.controller.invoke('write.demo.preview',{month:'2026-10',note:'合成核对'}),/AUTH_REQUIRED/);
  const first=await f.register();
  const preview=await f.controller.invoke('write.demo.preview',{month:'2026-10',note:'两条待核实，仅为合成备注'});
  assert.equal(preview.status,'awaiting_confirmation');assert.equal((await f.controller.snapshot()).writeDemo.records.length,0);
  await assert.rejects(f.controller.invoke('write.demo.confirm',{id:preview.id,fingerprint:'wrong'}),/WRITE_CONFIRMATION_INVALID/);
  await f.controller.invoke('write.demo.confirm',{id:preview.id,fingerprint:preview.fingerprint});
  await f.controller.invoke('write.demo.confirm',{id:preview.id,fingerprint:preview.fingerprint});
  let state=await f.controller.snapshot();assert.equal(state.writeDemo.records.length,1);assert.equal(state.writeDemo.approvals[0].status,'completed');
  await f.controller.invoke('auth.logout');await f.register('write-second@example.invalid','第二人');
  assert.deepEqual((await f.controller.snapshot()).writeDemo.records,[]);
  await assert.rejects(f.controller.invoke('write.demo.inspect',{id:preview.id}),/WRITE_NOT_FOUND/);
  await f.controller.invoke('auth.logout');await f.controller.invoke('auth.login',{email:first.account.email,password});
  state=await f.controller.snapshot();assert.equal(state.writeDemo.records.length,1);assert.equal((await f.controller.invoke('write.demo.inspect',{id:preview.id})).receipt.idempotencyKey,preview.id);
});

test('兼容的Mock身份演示切换也不能带走前一成员的BYOK配置',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'yuanyu-legacy-model-isolation-'));
  const systems=Object.fromEntries([['procurement',15331],['warehouse',15332]].map(([id,port])=>[id,{id,label:id,origin:`http://127.0.0.1:${port}`,url:`http://127.0.0.1:${port}/`}]));
  const controller=await createController({dataDir,cryptoAdapter:adapter(),systems,BrowserWindow:class{constructor(){throw new Error('NO_BROWSER_ALLOWED');}}});
  t.after(async()=>{await controller.close();await rm(dataDir,{recursive:true,force:true});});
  const saved=await controller.invoke('model.profile.save',modelInput());
  await controller.invoke('identity.switch',{userId:'bob'});const bob=await controller.snapshot();
  assert.equal(bob.modelProfiles.profiles.length,0);assert.equal(bob.modelProfiles.activeId,null);
  await assert.rejects(controller.invoke('model.profile.select',{id:saved.id}),/MODEL_PROFILE_NOT_FOUND/);
  await controller.invoke('identity.switch',{userId:'alice'});assert.equal((await controller.snapshot()).modelProfiles.activeId,saved.id);
});
