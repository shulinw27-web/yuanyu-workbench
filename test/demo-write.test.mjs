import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDemoWrite} from '../src/runtime/demo-write.mjs';
import {backupWorkspace,restoreWorkspace} from '../src/runtime/backup.mjs';

test('合成写入未知回执重建后核对，不重复写源；备份恢复保留对应源与账本',async t=>{
  const root=await mkdtemp(join(tmpdir(),'yuanyu-demo-write-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const dataDir=join(root,'source'),identity={companyId:'mock-acme',userId:'alice'},checkContext=async()=>true;
  let runtime=createDemoWrite({dataDir,identity,checkContext});
  const preview=await runtime.preview({month:'2026-09',note:'合成入库资料已核对'});
  assert.equal((await runtime.snapshot()).records.length,0);
  const receipt=await runtime.confirm({id:preview.id,fingerprint:preview.fingerprint});assert.equal(receipt.status,'completed');
  const ledger=join(dataDir,'write-approvals','mock-acme','alice','ledger.json');
  const entries=JSON.parse(await readFile(ledger,'utf8'));entries[0].status='receipt_unknown';delete entries[0].receipt;await writeFile(ledger,JSON.stringify(entries));
  runtime=createDemoWrite({dataDir,identity,checkContext});
  await assert.rejects(runtime.confirm({id:preview.id,fingerprint:preview.fingerprint}),/WRITE_RECEIPT_RECONCILE_REQUIRED/);
  assert.equal((await runtime.inspect(preview.id)).status,'completed');assert.equal((await runtime.snapshot()).records.length,1);
  await backupWorkspace({dataDir,backupDir:join(root,'backup')});
  await restoreWorkspace({backupDir:join(root,'backup'),targetDir:join(root,'restored')});
  const restored=createDemoWrite({dataDir:join(root,'restored'),identity,checkContext});
  assert.equal((await restored.snapshot()).records.length,1);assert.equal((await restored.inspect(preview.id)).status,'completed');
});

test('合成源不允许自选路径、操作、凭据或真实月份，撤权后不能确认或读回执',async t=>{
  const root=await mkdtemp(join(tmpdir(),'yuanyu-demo-write-policy-'));t.after(()=>rm(root,{recursive:true,force:true}));
  let enabled=true;const runtime=createDemoWrite({dataDir:root,identity:{companyId:'mock-acme',userId:'alice'},checkContext:async()=>enabled});
  for(const input of [{month:'2026-11',note:'合成'},{month:'2026-10',note:'token=secret'},{month:'2026-10',note:'正常',operation:'arbitrary'},{month:'2026-10',note:'x'.repeat(301)}])await assert.rejects(runtime.preview(input),/WRITE_INPUT_INVALID/);
  const preview=await runtime.preview({month:'2026-10',note:'合成核对'});enabled=false;
  await assert.rejects(runtime.confirm({id:preview.id,fingerprint:preview.fingerprint}),/WRITE_CONTEXT_CHANGED/);
  await assert.rejects(runtime.snapshot(),/WRITE_CONTEXT_CHANGED/);enabled=true;assert.equal((await runtime.snapshot()).records.length,0);
});
