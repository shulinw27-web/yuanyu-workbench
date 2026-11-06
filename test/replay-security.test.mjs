import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentStore} from '../src/agent/store.mjs';
import {createAgentRuntime} from '../src/agent/runtime.mjs';
import {safeError} from '../src/controller.mjs';

const identity={companyId:'mock-acme',userId:'alice',displayName:'合成人员',provider:'mock'};
const binding={id:'personal-site',origin:'https://business.example.invalid',revision:1};
const recipe=[{tool:'open',siteId:binding.id},{tool:'observe',siteId:binding.id},
  {tool:'select',siteId:binding.id,locator:{role:'combobox',name:'月份',readOnly:true},value:'2026-10'},
  {tool:'observe',siteId:binding.id},
  {tool:'click',siteId:binding.id,locator:{role:'button',name:'筛选记录',readOnly:true}},
  {tool:'observe',siteId:binding.id}];
const failure=code=>Object.assign(new Error(code),{code});

async function fixture(t,{duringClick,duringObserve,onUpdate}={}){
  const dataDir=await mkdtemp(join(tmpdir(),'yuanyu-replay-security-'));
  const store=createAgentStore({dataDir,identity});
  const original=await store.createTask({goal:'查看个人合成资料',siteBindings:[binding],mode:'compatible_browser'});
  await store.updateTask(original.id,{status:'completed',trace:recipe});
  const skill=await store.saveSkill({taskId:original.id,name:'个人站点只读查询'});
  const state={authorized:true,revision:1,reads:0,readsAfterRevocation:0,acts:[],successful:[],factoryCalls:0,cancelled:0};
  const page=()=>({text:'isolated-synthetic-live-page',elements:[
    {ref:`select-ref-${state.reads}`,tag:'select',role:'combobox',label:'月份',credential:false},
    {ref:`filter-ref-${state.reads}`,tag:'button',role:'button',label:'筛选记录',credential:false}
  ]});
  const browser={
    open:async()=>({}),resume:async()=>page(),handoff:async()=>({}),
    observe:async()=>{state.reads++;if(!state.authorized)state.readsAfterRevocation++;if(duringObserve)return duringObserve(state,page);return page();},
    act:async(_site,action)=>{state.acts.push(action.type);if(action.type==='click'&&duringClick)await duringClick(state);state.successful.push(action.type);},
    cancel:async()=>{state.cancelled++;}
  };
  const runtime=createAgentRuntime({store,getSites:async()=>[{...binding,revision:state.revision,builtin:false}],getBrowser:async()=>browser,isCurrent:()=>true,
    authorize:async()=>state.authorized,onUpdate:onUpdate?()=>onUpdate(state,store):async()=>{},safeError,
    requesterFactory:async()=>{state.factoryCalls++;throw failure('MODEL_MUST_NOT_RUN');}});
  t.after(async()=>{await runtime.cancel();await rm(dataDir,{recursive:true,force:true});});
  return {runtime,store,skill,state,dataDir,page};
}

test('HTTPS只读Skill本机重放不依赖模型同意或配置，撤权后的旧引用不得恢复动作',async t=>{
  const f=await fixture(t,{duringClick:async state=>{state.authorized=false;throw failure('STALE_REFERENCE');}});
  const run=await f.runtime.runSkill({id:f.skill.id,mode:'compatible_browser'});await f.runtime.waitForIdle();
  const task=(await f.store.listTasks()).find(task=>task.id===run.taskId);
  assert.equal(task.status,'failed');assert.equal(task.error.code,'AGENT_CONTEXT_CHANGED');
  assert.deepEqual(f.state.successful,['select']);assert.deepEqual(f.state.acts,['select','click']);assert.equal(f.state.readsAfterRevocation,0);assert.equal(f.state.reads,2);assert.equal(f.state.factoryCalls,0);
});

test('引用恢复前站点修订变化时停止，不向新来源重新读取或重试点击',async t=>{
  const f=await fixture(t,{duringClick:async state=>{state.revision++;throw failure('STALE_REFERENCE');}});
  const run=await f.runtime.runSkill({id:f.skill.id,mode:'compatible_browser'});await f.runtime.waitForIdle();
  const task=(await f.store.listTasks()).find(task=>task.id===run.taskId);
  assert.equal(task.status,'failed');assert.notEqual(task.error.code,'STALE_REFERENCE');
  assert.equal(f.state.reads,2);assert.deepEqual(f.state.acts,['select','click']);assert.deepEqual(f.state.successful,['select']);assert.equal(f.state.factoryCalls,0);
});

test('可能已经执行的浏览器错误不会被引用恢复机制自动重试',async t=>{
  for(const code of ['BROWSER_TIMEOUT','BROWSER_OPERATION_FAILED','WRITE_CONFIRM_REQUIRED','BROWSER_SOURCE_MISMATCH']){
    await t.test(code,async t=>{
      let applied=0;const f=await fixture(t,{duringClick:async()=>{applied++;throw failure(code);}});
      const run=await f.runtime.runSkill({id:f.skill.id,mode:'compatible_browser'});await f.runtime.waitForIdle();
      const task=(await f.store.listTasks()).find(task=>task.id===run.taskId);
      assert.equal(task.status,'failed');assert.equal(task.error.code,code);assert.equal(applied,1);
      assert.equal(task.steps.some(step=>step.id.startsWith('recovery-')),false);assert.equal(f.state.reads,2);assert.equal(f.state.factoryCalls,0);
    });
  }
});

test('恢复进度通知期间撤权也会在重新读取前停止',async t=>{
  const f=await fixture(t,{duringClick:async()=>{throw failure('STALE_REFERENCE');},onUpdate:async(state,store)=>{
    if((await store.listTasks()).some(task=>task.replay?.state==='recovering'))state.authorized=false;
  }});
  const run=await f.runtime.runSkill({id:f.skill.id,mode:'compatible_browser'});await f.runtime.waitForIdle();
  const task=(await f.store.listTasks()).find(task=>task.id===run.taskId);
  assert.equal(task.status,'failed');assert.equal(task.error.code,'AGENT_CONTEXT_CHANGED');
  assert.equal(f.state.reads,2);assert.equal(f.state.readsAfterRevocation,0);assert.deepEqual(f.state.acts,['select','click']);
});

test('重新观察挂起时取消能收尾，迟到页面不会恢复动作或写入任务',async t=>{
  let reached,release;const waiting=new Promise(resolve=>{reached=resolve;}),held=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{duringClick:async()=>{throw failure('STALE_REFERENCE');},duringObserve:async(state,page)=>{
    if(state.reads===3){reached();await held;return {...page(),text:'late-synthetic-private-page'};}return page();
  }});
  const run=await f.runtime.runSkill({id:f.skill.id,mode:'compatible_browser'});await waiting;
  await f.runtime.cancel(run.taskId);release();await f.runtime.waitForIdle();
  const task=(await f.store.listTasks()).find(task=>task.id===run.taskId);
  assert.equal(task.status,'cancelled');assert.equal(f.runtime.busy,false);assert.deepEqual(f.state.acts,['select','click']);assert.ok(f.state.cancelled>0);
  const disk=await readFile(join(f.dataDir,'agents','mock-acme','alice','state.json'),'utf8');assert.ok(!disk.includes('late-synthetic-private-page'));assert.ok(!disk.includes('filter-ref-'));
});
