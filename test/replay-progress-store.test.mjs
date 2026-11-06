import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentStore} from '../src/agent/store.mjs';
import {backupWorkspace,restoreWorkspace} from '../src/runtime/backup.mjs';

const alice={companyId:'mock-acme',userId:'alice',displayName:'Alice',provider:'mock'};
const siteBindings=[{id:'interactive-mock',origin:'http://127.0.0.1:41500',revision:1}];
const recipe=[{tool:'open',siteId:'interactive-mock'},{tool:'observe',siteId:'interactive-mock'},
  {tool:'select',siteId:'interactive-mock',locator:{role:'combobox',name:'月份',readOnly:true},value:'2026-09'},
  {tool:'observe',siteId:'interactive-mock'}];
const progress={stepIndex:2,total:4,tool:'select',siteId:'interactive-mock',retries:1,state:'recovering',reason:'STALE_REFERENCE'};

async function fixture(t){
  const root=await realpath(await mkdtemp(join(tmpdir(),'yuanyu-replay-progress-'))),dataDir=join(root,'source');
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=createAgentStore({dataDir,identity:alice});
  const source=await store.createTask({goal:'查看合成月份资料',siteBindings,mode:'mock_browser'});
  await store.updateTask(source.id,{status:'completed',trace:recipe,expectedAttempt:source.attempt});
  const skill=await store.saveSkill({taskId:source.id,name:'月份查询'});
  const task=await store.createTask({goal:'复用合成月份资料查询',siteBindings,mode:'mock_browser',skillId:skill.id});
  return {root,dataDir,store,skill,task,file:join(dataDir,'agents','mock-acme','alice','state.json')};
}

test('重放进度仅持久化安全元数据，读写副本隔离且不进入Skill模板',async t=>{
  const f=await fixture(t),input=structuredClone(progress);
  const updated=await f.store.updateTask(f.task.id,{status:'running',replay:input,expectedAttempt:1});
  input.siteId='foreign';updated.replay.tool='forged';
  assert.deepEqual((await f.store.listTasks()).find(task=>task.id===f.task.id).replay,progress);
  const disk=JSON.parse(await readFile(f.file,'utf8'));
  assert.deepEqual(disk.tasks.find(task=>task.id===f.task.id).replay,progress);
  assert.equal(disk.schemaVersion,1);
  assert.equal(Object.hasOwn((await f.store.listSkills())[0],'replay'),false);
  assert.equal(Object.hasOwn((await f.store.listSkills())[0].template,'replay'),false);
});

test('重放元数据拒绝页面/ref/任意字段、越界数字、未知枚举及未绑定站点',async t=>{
  const f=await fixture(t);
  await f.store.updateTask(f.task.id,{status:'running',replay:progress});
  const invalid=[{stepIndex:-1},{stepIndex:4},{stepIndex:1.5},{total:0},{total:101},{total:Infinity},
    {retries:-1},{retries:2},{retries:true},{siteId:'foreign-site'},{tool:'submit'},
    {state:'skip'},{reason:'token=synthetic'},{reason:{body:'synthetic-page'}},
    {page:'synthetic-private-page'},{ref:'r-secret'},{selector:'#private'},{text:'untrusted-body'}];
  for(const patch of invalid){
    await assert.rejects(f.store.updateTask(f.task.id,{status:'running',replay:{...progress,...patch},expectedAttempt:1}),error=>['AGENT_REPLAY_INVALID','AGENT_INPUT_INVALID'].includes(error.code));
    assert.deepEqual((await f.store.listTasks()).find(task=>task.id===f.task.id).replay,progress);
  }
  assert.ok(!(await readFile(f.file,'utf8')).includes('synthetic-private-page'));
  await f.store.updateTask(f.task.id,{status:'cancelled'});
  const ordinary=await f.store.createTask({goal:'普通浏览器任务',siteBindings,mode:'mock_browser'});
  await assert.rejects(f.store.updateTask(ordinary.id,{status:'running',replay:progress}),{code:'AGENT_REPLAY_INVALID'});
});

test('继续从新attempt重建进度，旧attempt和终态拒绝迟到进度，跨用户不可写',async t=>{
  const f=await fixture(t);
  await f.store.updateTask(f.task.id,{status:'running',replay:progress,expectedAttempt:1});
  await f.store.updateTask(f.task.id,{status:'failed',error:{code:'PAGE_STRUCTURE_CHANGED',message:'页面发生变化'},expectedAttempt:1});
  const resumed=await f.store.resumeTask(f.task.id);
  assert.equal(resumed.attempt,2);assert.equal(Object.hasOwn(resumed,'replay'),false);
  await assert.rejects(f.store.updateTask(f.task.id,{status:'running',replay:progress,expectedAttempt:1}),{code:'AGENT_TASK_STALE'});
  await f.store.updateTask(f.task.id,{status:'running',replay:{...progress,retries:0,state:'executing'},expectedAttempt:2});
  const bob=createAgentStore({dataDir:f.dataDir,identity:{...alice,userId:'bob',displayName:'Bob'}});
  await assert.rejects(bob.updateTask(f.task.id,{status:'running',replay:progress,expectedAttempt:2}),{code:'AGENT_TASK_NOT_FOUND'});
  assert.deepEqual(await bob.listTasks(),[]);
  await f.store.updateTask(f.task.id,{status:'cancelled',expectedAttempt:2});
  await assert.rejects(f.store.updateTask(f.task.id,{status:'completed',replay:progress,expectedAttempt:2}),{code:'AGENT_TASK_TERMINAL'});
});

test('备份恢复兼容安全重放进度，遗留运行清旧进度并要求显式重新执行',async t=>{
  const f=await fixture(t),backupDir=join(f.root,'backup'),restoredDir=join(f.root,'restored');
  await f.store.updateTask(f.task.id,{status:'running',replay:progress,trace:recipe.slice(0,2)});
  await backupWorkspace({dataDir:f.dataDir,backupDir});
  const backed=JSON.parse(await readFile(join(backupDir,'agents','mock-acme','alice','state.json'),'utf8'));
  assert.deepEqual(backed.tasks.find(task=>task.id===f.task.id).replay,progress);
  await restoreWorkspace({backupDir,targetDir:restoredDir});
  const restored=createAgentStore({dataDir:restoredDir,identity:alice});
  const recovered=(await restored.listTasks()).find(task=>task.id===f.task.id);
  assert.equal(recovered.status,'interrupted');assert.equal(Object.hasOwn(recovered,'replay'),false);
  assert.deepEqual(recovered.trace,recipe.slice(0,2));
  assert.equal((await f.store.listTasks()).find(task=>task.id===f.task.id).status,'running');
  const resumed=await restored.resumeTask(f.task.id);assert.equal(resumed.attempt,2);assert.equal(Object.hasOwn(resumed,'replay'),false);
  assert.deepEqual((await restored.listSkills())[0],f.skill);
});

test('重启遗留登录等待清旧进度；文件伪造的非法重放元数据不能被读取',async t=>{
  const f=await fixture(t);
  await f.store.updateTask(f.task.id,{status:'awaiting_user',awaitingSiteId:'interactive-mock',replay:{...progress,state:'awaiting_user',reason:'LOGIN_REQUIRED'}});
  const state=JSON.parse(await readFile(f.file,'utf8')),task=state.tasks.find(task=>task.id===f.task.id);task.sessionId='previous-process-session';
  await writeFile(f.file,JSON.stringify(state));
  const waiting=(await f.store.listTasks()).find(task=>task.id===f.task.id);
  assert.equal(waiting.status,'awaiting_user');assert.equal(waiting.awaitingSiteId,'interactive-mock');assert.equal(Object.hasOwn(waiting,'replay'),false);
  const forged=JSON.parse(await readFile(f.file,'utf8'));forged.tasks.find(task=>task.id===f.task.id).replay={...progress,ref:'old-dom-reference'};
  await writeFile(f.file,JSON.stringify(forged));
  await assert.rejects(f.store.listTasks(),{code:'AGENT_STORE_INVALID'});
});
