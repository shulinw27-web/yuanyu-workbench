import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createSiteRegistry,validateSite} from '../src/sites/registry.mjs';import {validateInteractiveSite} from '../src/browser/interactive-policy.mjs';
test('personal HTTPS registration persists without granting access to another person',async t=>{const dataDir=await mkdtemp(join(tmpdir(),'yuanyu-site-test-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));const a=createSiteRegistry({dataDir,identity:{companyId:'company',userId:'alice'}}),b=createSiteRegistry({dataDir,identity:{companyId:'company',userId:'bob'}});await a.register({id:'site-erp',label:'ERP',origin:'https://erp.example.test',entryPath:'/',paths:['/','/orders']});assert.equal((await a.list()).length,1);assert.equal((await b.list()).length,0);await assert.rejects(a.register({id:'site-erp',label:'ERP',origin:'https://erp.example.test',entryPath:'/',paths:['/']}),/SITE_EXISTS/);});
test('site policy refuses embedded credentials, non-HTTPS and path traversal',()=>{for(const origin of ['http://example.test','https://user:pass@example.test','https://example.test/path'])assert.throws(()=>validateSite({id:'site-erp',label:'ERP',origin,entryPath:'/',paths:['/']}));assert.throws(()=>validateSite({id:'site-erp',label:'ERP',origin:'https://example.test',entryPath:'/../secret',paths:['/../secret']}));});
test('站点可受控修改/删除，旧revision与跨人修改拒绝',async t=>{const dataDir=await mkdtemp(join(tmpdir(),'yuanyu-site-test-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));const a=createSiteRegistry({dataDir,identity:{companyId:'company',userId:'alice'}}),b=createSiteRegistry({dataDir,identity:{companyId:'company',userId:'bob'}});const site=await a.register({id:'site-erp',label:'ERP',origin:'https://erp.example.test',entryPath:'/',paths:['/']});const updated=await a.update({...site,label:'ERP新版',revision:undefined,expectedRevision:1,paths:['/','/login']});assert.equal(updated.revision,2);await assert.rejects(a.remove({id:site.id,expectedRevision:1}),/SITE_VERSION_CONFLICT/);await assert.rejects(b.update({...site,expectedRevision:2}),/SITE_NOT_FOUND/);await a.remove({id:site.id,expectedRevision:2});assert.equal((await a.list()).length,0);});
test('个人站点的安全GET按钮与查询参数规则持久化并进入交互策略',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'yuanyu-site-test-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const registry=createSiteRegistry({dataDir,identity:{companyId:'company',userId:'alice'}});
  const rules=[{selector:'#search-submit',kind:'search'},{selector:'a.next-page',kind:'read'}];
  const site=await registry.register({id:'site-erp',label:'ERP',origin:'https://erp.example.test',entryPath:'/',paths:['/','/orders'],queryKeys:{'/orders':['month','status']},readOnlyActions:rules});
  assert.deepEqual(site.readOnlyActions,rules);assert.deepEqual(site.queryKeys,{'/orders':['month','status']});
  const stored=(await registry.list())[0];assert.deepEqual(stored.readOnlyActions,rules);
  const policy=validateInteractiveSite({...stored,manual:true});
  assert.deepEqual(policy.readOnlyActions.map(action=>({...action})),rules);
  assert.deepEqual(Object.fromEntries(Object.entries(policy.queryKeys).map(([path,keys])=>[path,[...keys]])),site.queryKeys);
  const updated=await registry.update({...stored,label:'ERP新版',revision:undefined,expectedRevision:1});
  assert.equal(updated.revision,2);assert.deepEqual(updated.readOnlyActions,rules);
});
test('旧站点数据没有按钮规则仍可读取，默认不放行任何按钮',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'yuanyu-site-test-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const dir=join(dataDir,'sites','company','alice');await mkdir(dir,{recursive:true});
  await writeFile(join(dir,'sites.json'),JSON.stringify([{id:'site-old',label:'旧站点',origin:'https://old.example.test',entryPath:'/',paths:['/'],revision:1}]));
  const registry=createSiteRegistry({dataDir,identity:{companyId:'company',userId:'alice'}});
  const site=(await registry.list())[0];
  assert.deepEqual(site.readOnlyActions,[]);assert.deepEqual(site.queryKeys,{});
  assert.deepEqual(validateInteractiveSite({...site,manual:true}).readOnlyActions,[]);
});
test('站点按钮规则拒绝越界路径、敏感查询参数、非法类型与过量配置',()=>{
  const base={id:'site-erp',label:'ERP',origin:'https://erp.example.test',entryPath:'/',paths:['/','/orders']};
  for(const queryKeys of [{'/admin':['month']},{'/orders':['token']},{'/orders':'month'},{'/orders':['a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','q','r','s','t','u']}])
    assert.throws(()=>validateSite({...base,queryKeys}),/SITE_INVALID/);
  for(const readOnlyActions of [{selector:'#search',kind:'read'},[{selector:'',kind:'read'}],[{selector:'#search',kind:'write'}],Array.from({length:101},()=>({selector:'#search',kind:'read'}))])
    assert.throws(()=>validateSite({...base,readOnlyActions}),/SITE_INVALID/);
});
