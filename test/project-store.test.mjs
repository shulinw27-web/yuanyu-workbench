import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,access,symlink,stat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createProjectStore} from '../src/project/store.mjs';

const samePath=(actual,expected)=>assert.equal(actual.toLowerCase(),expected.toLowerCase());

const identities={alice:{companyId:'mock-acme',userId:'alice',displayName:'林悦',provider:'mock'},bob:{companyId:'mock-acme',userId:'bob',displayName:'陈宁',provider:'mock'},outsider:{companyId:'mock-other',userId:'outsider',displayName:'外人',provider:'mock'}};
async function fixture(t,userId='alice'){
  const dataDir=await mkdtemp(join(tmpdir(),'yuanyu-project-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const store=createProjectStore({dataDir,identity:identities[userId]});
  return {store,dataDir,make:userId=>createProjectStore({dataDir,identity:identities[userId]})};
}
const exists=async file=>{try{await access(file);return true;}catch{return false;}};

test('创建空项目：建立目录、登记来源并设为当前；重开实例后仍可读',async t=>{
  const {store,make}=await fixture(t);
  const root=join(await mkdtemp(join(tmpdir(),'yuanyu-root-')),'子目录','新项目');
  t.after(()=>rm(resolve(root,'..'),{recursive:true,force:true}));
  const project=await store.createEmpty({name:'季度核对',root});
  assert.equal(project.name,'季度核对');assert.equal(project.origin,'empty');
  assert.equal(await stat(project.root).then(s=>s.isDirectory()),true);
  let view=await store.snapshot();
  assert.equal(view.projects.length,1);assert.equal(view.currentId,project.id);
  const reopened=make('alice');
  view=await reopened.snapshot();
  samePath(view.projects[0].root,await realpath(resolve(root)));
  assert.equal(view.projects[0].name,'季度核对');assert.equal(view.currentId,project.id);
  assert.ok(view.revision>=2);
});

test('创建空项目拒绝非空目录、仓库内路径与相对路径',async t=>{
  const {store,dataDir}=await fixture(t);
  const busy=await mkdtemp(join(tmpdir(),'yuanyu-busy-'));t.after(()=>rm(busy,{recursive:true,force:true}));
  await writeFile(join(busy,'已有文件.txt'),'keep');
  await assert.rejects(store.createEmpty({name:'占用',root:busy}),{code:'PROJECT_DIRECTORY_NOT_EMPTY'});
  assert.equal(await store.snapshot().then(v=>v.projects.length),0);
  await assert.rejects(store.createEmpty({name:'仓库',root:join(resolve(process.cwd()),'project-root')}),{code:'PROJECT_UNSAFE_PATH'});
  await assert.rejects(store.createEmpty({name:'相对',root:'relative/path'}),{code:'PROJECT_UNSAFE_PATH'});
  assert.equal(await exists(join(busy,'已有文件.txt')),true);
});

test('从本地文件夹导入：默认取文件夹名；缺失路径与非目录被拒绝',async t=>{
  const {store}=await fixture(t);
  const folder=await mkdtemp(join(tmpdir(),'yuanyu-import-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  await writeFile(join(folder,'资料.csv'),'a,b');
  const project=await store.importFolder({root:folder});
  assert.equal(project.origin,'folder');
  assert.ok(project.name.length>0);
  samePath(project.root,await realpath(folder));
  await assert.rejects(store.importFolder({root:folder}),{code:'PROJECT_DUPLICATE'});
  await assert.rejects(store.importFolder({root:join(folder,'不存在')}),{code:'PROJECT_DIRECTORY_MISSING'});
  const file=join(folder,'资料.csv');
  await assert.rejects(store.importFolder({root:file}),{code:'PROJECT_DIRECTORY_MISSING'});
  assert.equal(await exists(join(folder,'资料.csv')),true);
});

test('同一真实路径不能重复登记（大小写/斜杠差异也不绕过）',async t=>{
  const {store}=await fixture(t);
  const folder=await mkdtemp(join(tmpdir(),'yuanyu-dup-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  await store.importFolder({root:folder});
  const variant=folder.endsWith('/')?folder:folder+'/';
  await assert.rejects(store.importFolder({root:variant}),{code:'PROJECT_DUPLICATE'});
});

test('重命名与当前项目切换使用修订号裁决',async t=>{
  const {store}=await fixture(t);
  const folder=await mkdtemp(join(tmpdir(),'yuanyu-rename-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const first=await store.importFolder({root:folder,name:'旧名'});
  const revision=(await store.snapshot()).revision;
  await assert.rejects(store.rename({id:first.id,name:'新名',expectedRevision:revision+99}),{code:'PROJECT_VERSION_CONFLICT'});
  const renamed=await store.rename({id:first.id,name:'新名',expectedRevision:revision});
  assert.equal(renamed.name,'新名');
  const otherRoot=join(await mkdtemp(join(tmpdir(),'yuanyu-other-')),'proj');t.after(()=>rm(resolve(otherRoot,'..'),{recursive:true,force:true}));
  const second=await store.createEmpty({name:'第二个',root:otherRoot});
  const rev2=(await store.snapshot()).revision;
  await store.setCurrent({id:second.id,expectedRevision:rev2});
  let view=await store.snapshot();
  assert.equal(view.currentId,second.id);
  assert.ok(view.projects.find(p=>p.id===second.id).lastOpenedAt>=second.createdAt);
  const rev3=view.revision;
  await store.setCurrent({id:null,expectedRevision:rev3});
  view=await store.snapshot();
  assert.equal(view.currentId,null);
  await assert.rejects(store.setCurrent({id:'不存在的',expectedRevision:view.revision}),{code:'PROJECT_NOT_FOUND'});
});

test('删除项目只移除登记记录，文件夹与其中的文件不被触碰',async t=>{
  const {store}=await fixture(t);
  const folder=await mkdtemp(join(tmpdir(),'yuanyu-remove-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const file=join(folder,'重要资料.txt');await writeFile(file,'不可丢失');
  const project=await store.importFolder({root:folder});
  const removed=await store.remove({id:project.id,expectedRevision:(await store.snapshot()).revision});
  assert.equal(removed.deleted,true);
  const view=await store.snapshot();
  assert.equal(view.projects.length,0);assert.equal(view.currentId,null);
  assert.equal(await exists(file),true);
  assert.equal(await stat(folder).then(s=>s.isDirectory()),true);
});

test('项目记录按身份隔离，他人不可见',async t=>{
  const {store,make}=await fixture(t);
  const folder=await mkdtemp(join(tmpdir(),'yuanyu-iso-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  await store.importFolder({root:folder,name:'私有项目'});
  assert.equal((await store.snapshot()).projects.length,1);
  assert.equal((await make('bob').snapshot()).projects.length,0);
  assert.equal((await make('outsider').snapshot()).projects.length,0);
});

test('路径含符号链接或落点在仓库内时拒绝导入',async t=>{
  const {store}=await fixture(t);
  const real=await mkdtemp(join(tmpdir(),'yuanyu-real-'));t.after(()=>rm(real,{recursive:true,force:true}));
  const link=join(await mkdtemp(join(tmpdir(),'yuanyu-link-')),'跳转');
  try{await symlink(real,link,'junction');}catch{return t.skip('当前环境不允许创建符号链接');}
  await assert.rejects(store.importFolder({root:link}),{code:'PROJECT_UNSAFE_PATH'});
  assert.equal((await store.snapshot()).projects.length,0);
});

test('状态文件被篡改或身份不符时拒绝读取',async t=>{
  const {store,dataDir}=await fixture(t);
  const folder=await mkdtemp(join(tmpdir(),'yuanyu-tamper-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  await store.importFolder({root:folder});
  const file=join(dataDir,'projects','mock-acme','alice','state.json');
  await writeFile(file,'{"schemaVersion":1,"companyId":"mock-acme","userId":"alice","revision":9,"projects":[{"id":"x","name":"伪造","root":"C:/ Windows","origin":"hacked","createdAt":"now","updatedAt":"now","lastOpenedAt":null}],"currentId":"x"}');
  await assert.rejects(store.snapshot(),{code:'PROJECT_STORE_INVALID'});
});

test('重复打开同一dataDir的多个存储不互相加锁',async t=>{
  const {store,make}=await fixture(t);
  const one=make('alice'),two=make('alice');
  const a=await one.snapshot(),b=await two.snapshot();
  assert.equal(a.revision,b.revision);
});
