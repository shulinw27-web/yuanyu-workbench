import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createController} from '../src/controller.mjs';
import {createAgentStore} from '../src/agent/store.mjs';
import {createDemonstration} from '../src/agent/demonstration.mjs';

const site={id:'interactive-mock',label:'合成查询站点',origin:'http://127.0.0.1:15333',paths:['/'],entryPath:'/',builtin:true,revision:1};
const identity={companyId:'mock-acme',userId:'alice',displayName:'Alice',provider:'mock'};
const systems=Object.fromEntries(['procurement','warehouse'].map((id,index)=>[id,{id,label:id,origin:`http://127.0.0.1:${15331+index}`,url:`http://127.0.0.1:${15331+index}/`}]));
function browserFixture(){
  let revision=0,text='isolated-synthetic-result-091',acts=0;
  const page=()=>({title:'合成查询',text,elements:[{ref:`fresh-${++revision}`,tag:'select',role:'combobox',type:'select-one',label:'月份',credential:false,readOnly:false,options:[{label:'2026-09'},{label:'2026-10'}]}]});
  return {browser:{open:async()=>({mode:'automatic'}),observe:async()=>page(),act:async()=>{acts++;},cancel:async()=>{},close:async()=>{}},change:value=>{text=value;},acts:()=>acts};
}
async function temporary(t){const root=await mkdtemp(join(tmpdir(),'yuanyu-demonstration-security-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}

test('账号撤权后的示范页面保持隐藏，用户可显式重新登录而不被旧示范锁死',async t=>{
  const dataDir=await temporary(t),f=browserFixture();let authenticated=true;
  const account={id:'synthetic-account',displayName:'合成用户',tier:'personal',verified:true};
  const client={
    status:async()=>({authenticated,account:authenticated?account:undefined,mode:'personal',deployment:'local_demo',models:[],developer:{name:'开发者',contact:'wsltest'}}),
    me:async()=>{if(!authenticated)throw Object.assign(new Error('AUTH_REQUIRED'),{code:'AUTH_REQUIRED'});return {account};},
    login:async()=>{authenticated=true;return {account};}
  };
  const controller=await createController({dataDir,systems,builtinSites:[site],cryptoAdapter:{available:()=>false},productClient:client,interactiveFactory:()=>f.browser});
  t.after(()=>controller.close());
  const started=await controller.invoke('demo.start',{goal:'学习合成查询',siteIds:[site.id],mode:'mock_browser'});
  authenticated=false;
  const locked=await controller.snapshot();assert.equal(locked.identity,null);assert.equal(locked.demonstration,null);assert.ok(!JSON.stringify(locked).includes('isolated-synthetic-result-091'));
  await controller.invoke('auth.login',{email:'synthetic@example.invalid',password:'synthetic-password-123'});
  const restored=await controller.snapshot();assert.equal(restored.product.authenticated,true);assert.equal(restored.demonstration,null);
  assert.equal(restored.agentTasks.find(task=>task.id===started.taskId).status,'cancelled');
});

test('过期示范id的取消请求不能中断另一条尚在启动的示范',async t=>{
  const dataDir=await temporary(t),store=createAgentStore({dataDir,identity}),f=browserFixture();let release,entered;
  const held=new Promise(resolve=>{release=resolve;}),reached=new Promise(resolve=>{entered=resolve;});let first=true;
  const demo=createDemonstration({store,getBrowser:async()=>f.browser,isCurrent:()=>true,getSites:async()=>{if(first){first=false;entered();await held;}return [site];}});
  t.after(()=>demo.cancel({}));
  const starting=demo.start({goal:'合成示范',siteIds:[site.id],mode:'mock_browser'}).then(value=>({value}),error=>({error}));
  await reached;
  const cancelled=assert.rejects(demo.cancel({id:'not-the-starting-task'}),/DEMONSTRATION_NOT_ACTIVE/);
  release();await cancelled;const result=await starting;
  assert.equal(result.error,undefined,'过期取消不得中断尚未绑定该id的新任务');assert.ok(result.value.taskId);assert.equal(demo.active,true);
});

test('示范完成重新核对当前页面，变化结果先刷新供用户确认，旧ref不能重用且页面不落盘',async t=>{
  const dataDir=await temporary(t),store=createAgentStore({dataDir,identity}),f=browserFixture();
  const demo=createDemonstration({store,getBrowser:async()=>f.browser,getSites:async()=>[site],isCurrent:()=>true});t.after(()=>demo.cancel({}));
  let view=await demo.start({goal:'学习合成月份筛选',siteIds:[site.id],mode:'mock_browser'}),id=view.taskId,ref=view.page.elements[0].ref;
  view=await demo.act({id,siteId:site.id,action:{type:'select',ref,value:'2026-09'}});
  await assert.rejects(demo.act({id,siteId:site.id,action:{type:'select',ref,value:'2026-10'}}),/STALE_REFERENCE/);assert.equal(f.acts(),1);
  f.change('new-unconfirmed-synthetic-business-result');
  await assert.rejects(demo.finish({id,confirmed:true}),/DEMONSTRATION_RESULT_CHANGED/);
  assert.equal((await store.listTasks())[0].status,'running');assert.ok(demo.snapshot().page.text.includes('new-unconfirmed'));
  await demo.finish({id,confirmed:true});assert.equal((await store.listTasks())[0].status,'completed');
  const disk=await readFile(join(dataDir,'agents','mock-acme','alice','state.json'),'utf8');
  for(const raw of ['isolated-synthetic-result','new-unconfirmed-synthetic-business-result','fresh-'])assert.ok(!disk.includes(raw));
});
