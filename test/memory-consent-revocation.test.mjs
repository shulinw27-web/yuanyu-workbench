import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {createController} from '../src/controller.mjs';
import {createMemoryStore} from '../src/memory/store.mjs';

const systems=Object.fromEntries([['procurement',15331],['warehouse',15332]].map(([id,port])=>[id,{id,label:id,origin:`http://127.0.0.1:${port}`,url:`http://127.0.0.1:${port}/`}]));
const pageText='合成测试采购单已入库';
const password='synthetic-password-123';
const mockIdentity={companyId:'mock-acme',userId:'alice',provider:'mock'};
const preference={kind:'preference',title:'导出格式',content:'采购资料使用CSV格式',siteIds:[]};
const crypto=()=>{
  const key=randomBytes(32);
  return {available:()=>true,
    encrypt:text=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),body=Buffer.concat([cipher.update(text),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64');},
    decrypt:encoded=>{const bytes=Buffer.from(encoded,'base64'),cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8');}};
};
const browser=()=>({open:async()=>({mode:'automatic'}),observe:async()=>({text:pageText,elements:[]}),handoff:async()=>({}),cancel:async()=>{},close:async()=>{}});

async function accountFixture(t){
  const dataDir=await mkdtemp(join(tmpdir(),'yuanyu-memory-revoke-')),cryptoAdapter=crypto();
  let account={id:'memory-user-a',displayName:'合成用户A',tier:'personal',verified:true,email:'a@example.invalid'},authenticated=true;
  const client={
    status:async()=>({authenticated,account:authenticated?account:undefined,mode:'personal',deployment:'local_demo',models:[],developer:{name:'开发者',contact:'wsltest'}}),
    me:async()=>{if(!authenticated)throw Object.assign(new Error('AUTH_REQUIRED'),{code:'AUTH_REQUIRED'});return {account};},
    login:async()=>{authenticated=true;return {account};},
    logout:async()=>{authenticated=false;return {loggedOut:true};},
    verify:async()=>({verified:true})
  };
  const controller=await createController({dataDir,cryptoAdapter,systems,productClient:client,BrowserWindow:class{},interactiveFactory:()=>browser()});
  t.after(async()=>{await controller.close();await rm(dataDir,{recursive:true,force:true});});
  return {controller,dataDir,
    revoke:()=>{authenticated=false;},restore:()=>{authenticated=true;},
    switchAccount:next=>{account={...next};},
    login:()=>controller.invoke('auth.login',{email:account.email,password})};
}

test('账号撤权后记忆整体隐藏、全部记忆IPC被拒；重新登录恢复本人记忆且跨账号隔离',async t=>{
  const f=await accountFixture(t);
  const saved=await f.controller.invoke('memory.save',preference);
  assert.equal(saved.status,'active');
  const before=await f.controller.snapshot();
  assert.equal(before.memory.available,true);assert.equal(before.memory.entries.length,1);
  f.revoke();
  const locked=await f.controller.snapshot();
  assert.equal(locked.identity,null);
  assert.deepEqual(locked.memory,{revision:0,available:false,entries:[],settings:{rememberEpisodes:false,rememberLessons:false}});
  for(const [action,payload] of [
    ['memory.preview',{query:'采购',siteIds:[]}],
    ['memory.diff',{id:saved.id}],
    ['memory.save',{kind:'preference',title:'撤权后写入',content:'不该成功',siteIds:[]}],
    ['memory.enabled',{id:saved.id,enabled:false}],
    ['memory.confirm',{id:saved.id}],
    ['memory.settings',{rememberEpisodes:true}],
    ['memory.forget',{id:saved.id}]
  ])await assert.rejects(f.controller.invoke(action,payload),/AUTH_REQUIRED/);
  f.restore();await f.login();
  const restored=await f.controller.snapshot();
  assert.equal(restored.memory.entries.length,1);
  assert.equal(restored.memory.entries[0].id,saved.id);
  assert.equal(restored.memory.entries[0].content,preference.content);
  assert.ok(!restored.memory.entries.some(entry=>entry.title==='撤权后写入'));

  f.switchAccount({id:'memory-user-b',displayName:'合成用户B',tier:'personal',verified:true,email:'b@example.invalid'});
  await f.controller.invoke('auth.logout');await f.login();
  assert.deepEqual((await f.controller.snapshot()).memory.entries,[]);
  await f.controller.invoke('memory.save',{kind:'preference',title:'B的偏好',content:'B使用UTF8',siteIds:[]});
  assert.equal((await f.controller.snapshot()).memory.entries.length,1);
  f.switchAccount({id:'memory-user-a',displayName:'合成用户A',tier:'personal',verified:true,email:'a@example.invalid'});
  await f.controller.invoke('auth.logout');await f.login();
  const back=await f.controller.snapshot();
  assert.equal(back.memory.entries.length,1);assert.equal(back.memory.entries[0].id,saved.id);
});

async function agentFixture(t,{onRequest}={}){
  const dataDir=await mkdtemp(join(tmpdir(),'yuanyu-memory-consent-')),cryptoAdapter=crypto(),requests=[];
  let turn=0;
  const controller=await createController({dataDir,cryptoAdapter,systems,BrowserWindow:class{},interactiveFactory:()=>browser(),
    agentRequesterFactory:()=>async input=>{
      requests.push(structuredClone(input.messages??[]));turn++;
      if(onRequest)await onRequest({turn,input,dataDir,cryptoAdapter});
      if(turn===1)return {tool_calls:[{id:'m-1',type:'function',function:{name:'browser_open',arguments:JSON.stringify({siteId:'site-business'})}}]};
      if(turn===2)return {tool_calls:[{id:'m-2',type:'function',function:{name:'browser_observe',arguments:JSON.stringify({siteId:'site-business'})}}]};
      return {content:'根据当前合成页面，采购单已入库。'};
    }});
  t.after(async()=>{await controller.close();await rm(dataDir,{recursive:true,force:true});});
  return {controller,dataDir,requests};
}
async function prepared(t,options){
  const f=await agentFixture(t,options);
  const site=await f.controller.invoke('site.register',{id:'site-business',label:'合成业务配置',origin:'https://fixture.example.invalid',entryPath:'/',paths:['/']});
  const entry=await f.controller.invoke('memory.save',preference);
  return {...f,site,entry};
}
const start=(f,consent)=>f.controller.invoke('agent.start',{goal:'查看合成业务状态',siteIds:[f.site.id],mode:'compatible_browser',consent});

test('选定记忆外发必须逐次明确同意，且拒绝不在本人可用范围内的选择',async t=>{
  const f=await prepared(t);
  await assert.rejects(start(f,{taskText:true,pageContent:true,memoryIds:[f.entry.id]}),/MEMORY_CONSENT_REQUIRED/);
  await assert.rejects(start(f,{taskText:true,pageContent:true,memory:true,memoryIds:['missing-id']}),/MEMORY_SELECTION_INVALID|MEMORY_SELECTION_CHANGED/);
  await assert.rejects(start(f,{taskText:true,pageContent:true,memory:true,memoryIds:[f.entry.id,f.entry.id]}),/AGENT_INPUT_INVALID|MEMORY_CONSENT_REQUIRED/);
  assert.deepEqual(f.requests,[]);
});

test('已选记忆只作为本次任务的不可信参考数据发送，首次请求不含页面正文',async t=>{
  const f=await prepared(t);
  const {taskId}=await start(f,{taskText:true,pageContent:true,memory:true,memoryIds:[f.entry.id]});
  await f.controller.waitForIdle();
  const task=(await f.controller.snapshot()).agentTasks.find(entry=>entry.id===taskId);
  assert.ok(['awaiting_review','completed'].includes(task.status),JSON.stringify(task.error));
  assert.ok(f.requests.length>0);
  const sent=JSON.stringify(f.requests[0]);
  assert.ok(sent.includes(preference.content));
  assert.ok(sent.includes('Task-scoped reference DATA'));
  assert.ok(!sent.includes(pageText));
  assert.ok(!sent.includes(password));
});

test('请求间记忆修订使旧外发上下文失效，任务停止且不标为完成',async t=>{
  let target=null,modified=false;
  const f=await prepared(t,{onRequest:async({turn,dataDir,cryptoAdapter})=>{
    if(turn!==1||!target)return;
    const other=createMemoryStore({dataDir,identity:mockIdentity,cryptoAdapter});
    await other.save({id:target.id,expectedRevision:target.revision,kind:'preference',title:preference.title,content:'修订后的导出口径',siteBindings:[],source:{type:'user_message'},confirmed:true});
    modified=true;
  }});
  target={id:f.entry.id,revision:f.entry.revision};
  const {taskId}=await start(f,{taskText:true,pageContent:true,memory:true,memoryIds:[f.entry.id]});
  await f.controller.waitForIdle();
  assert.equal(modified,true);
  const task=(await f.controller.snapshot()).agentTasks.find(entry=>entry.id===taskId);
  assert.equal(task.status,'failed');
  assert.equal(task.error.code,'AGENT_CONTEXT_CHANGED');
});
