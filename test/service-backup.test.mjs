import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,readdir,mkdir,symlink,lstat,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createPromotionService} from '../src/service/index.mjs';
import {backupService,restoreService} from '../src/service/backup.mjs';

const password='synthetic-service-backup-password';
const payload={modelId:'demo-synthetic',messages:[{role:'user',content:'合成备份核对'}],tools:[],consent:{taskText:true},requestId:'backup-held-001'};
const request=async(base,path,{body,token}={})=>{
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  return {status:response.status,body:await response.json()};
};
async function startService(options){
  for(let attempt=0;attempt<10;attempt++){
    const service=await createPromotionService(options);
    try{await fetch(service.url+'/v1/public');return service;}
    catch(error){await service.close();if(error.cause?.message!=='bad port')throw error;}
  }
  throw new Error('NO_FETCH_COMPATIBLE_TEST_PORT');
}
async function fixture(t,options={}){
  const root=await mkdtemp(join(tmpdir(),'yuanyu-service-backup-')),dataDir=join(root,'source'),services=[];
  t.after(async()=>{for(const service of services.reverse())await service.close();await rm(root,{recursive:true,force:true});});
  const service=await startService({dataDir,demo:true,monthlyTokens:100000,dailyRequests:20,...options});services.push(service);
  return {root,dataDir,service,services};
}
const query=(dataDir,sql)=>{const db=new DatabaseSync(join(dataDir,'promotion.sqlite'),{readOnly:true});try{return db.prepare(sql).all();}finally{db.close();}};

test('活跃WAL和处理中推理的一致性备份，恢复撤销会话/挑战并保留预留不重复收费',async t=>{
  let entered,release,calls=0;const reached=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{requestModel:async()=>{calls++;entered();return held;}});
  t.after(()=>release({message:{role:'assistant',content:'合成结果'},usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}));
  const registration=await request(f.service.url,'/v1/auth/register',{body:{email:'backup@example.invalid',password,name:'合成备份用户'}});
  assert.equal(registration.status,201);const user=registration.body;
  await request(f.service.url,'/v1/auth/verify',{token:user.sessionToken,body:{code:user.demoVerificationCode}});
  await request(f.service.url,'/v1/auth/register',{body:{email:'unverified@example.invalid',password,name:'待验证合成用户'}});
  const inference=request(f.service.url,'/v1/inference',{token:user.sessionToken,body:payload});await reached;
  const original=query(f.dataDir,'SELECT used,reserved FROM quota')[0];assert.ok(original.reserved>0);assert.equal(calls,1);
  await writeFile(join(f.dataDir,'provider-key.txt'),'synthetic-external-key-must-not-copy');await writeFile(join(f.dataDir,'service.local.json'),'synthetic-config-must-not-copy');
  const backupDir=join(f.root,'backup'),targetDir=join(f.root,'restored');
  const backup=await backupService({dataDir:f.dataDir,backupDir});assert.equal(backup.snapshot,'consistent');assert.equal(backup.files,2);
  assert.deepEqual((await readdir(backupDir)).sort(),['promotion.sqlite','service-backup.json']);
  const snapshot=await readFile(join(backupDir,'promotion.sqlite'));assert.ok(!snapshot.includes(Buffer.from(password)));assert.ok(!snapshot.includes(Buffer.from(user.sessionToken)));
  assert.equal(query(f.dataDir,"SELECT status FROM requests WHERE request_id='backup-held-001'")[0].status,'pending','备份不能修改仍在处理的原服务');
  const restored=await restoreService({backupDir,targetDir});assert.equal(restored.sessionsRevoked,2);assert.equal(restored.requestsUncertain,1);assert.equal(restored.requiresLogin,true);
  assert.equal(query(targetDir,'SELECT count(*) AS count FROM sessions WHERE revoked=0')[0].count,0);
  assert.equal(query(targetDir,'SELECT count(*) AS count FROM verification')[0].count,0);
  assert.deepEqual({...query(targetDir,'SELECT used,reserved FROM quota')[0]},{...original});
  const restoredService=await startService({dataDir:targetDir,demo:true,requestModel:async()=>{calls++;throw Error('MUST_NOT_REPEAT');}});f.services.push(restoredService);
  assert.equal((await request(restoredService.url,'/v1/me',{token:user.sessionToken})).status,401);
  const login=await request(restoredService.url,'/v1/auth/login',{body:{email:user.account.email,password}});assert.equal(login.status,200);
  const repeated=await request(restoredService.url,'/v1/inference',{token:login.body.sessionToken,body:payload});assert.equal(repeated.status,409);assert.equal(repeated.body.error.code,'REQUEST_UNCERTAIN');assert.equal(calls,1);
  release({message:{role:'assistant',content:'隔离合成结果'},usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}});
  assert.equal((await inference).status,200);
  assert.equal(query(f.dataDir,'SELECT reserved FROM quota')[0].reserved,0);assert.equal(query(targetDir,'SELECT reserved FROM quota')[0].reserved,original.reserved);
  assert.deepEqual(await readFile(join(backupDir,'promotion.sqlite')),snapshot,'恢复不能改变原备份');
  if(process.platform!=='win32'){assert.equal((await lstat(join(backupDir,'promotion.sqlite'))).mode&0o777,0o600);assert.equal((await lstat(join(targetDir,'promotion.sqlite'))).mode&0o777,0o600);}
});

test('已有目标、仓库路径、包含关系及目录链接拒绝，不覆盖任何用户目录',async t=>{
  const f=await fixture(t),backupDir=join(f.root,'backup');await backupService({dataDir:f.dataDir,backupDir});
  await assert.rejects(backupService({dataDir:f.dataDir,backupDir}),/SERVICE_BACKUP_TARGET_EXISTS/);
  await assert.rejects(restoreService({backupDir,targetDir:f.dataDir}),/SERVICE_BACKUP_TARGET_EXISTS/);
  await assert.rejects(backupService({dataDir:f.dataDir,backupDir:join(f.dataDir,'nested')}),/SERVICE_BACKUP_PATH_INVALID/);
  await assert.rejects(restoreService({backupDir,targetDir:join(backupDir,'nested')}),/SERVICE_BACKUP_PATH_INVALID/);
  const repo=resolve(fileURLToPath(new URL('..',import.meta.url)));
  await assert.rejects(backupService({dataDir:f.dataDir,backupDir:join(repo,'uncreated-backup')}),/SERVICE_BACKUP_PATH_INVALID/);
  const alias=join(f.root,'source-alias');await symlink(f.dataDir,alias,process.platform==='win32'?'junction':'dir');
  await assert.rejects(backupService({dataDir:alias,backupDir:join(f.root,'alias-backup')}),/SERVICE_BACKUP_SYMLINK_DENIED/);
  assert.equal(query(f.dataDir,'SELECT count(*) AS count FROM accounts')[0].count,0);
});

test('篡改数据库、manifest路径注入、额外文件和无效SQLite模式均拒绝且清理未完成目标',async t=>{
  const f=await fixture(t),backupDir=join(f.root,'backup');await backupService({dataDir:f.dataDir,backupDir});
  const file=join(backupDir,'promotion.sqlite'),manifestFile=join(backupDir,'service-backup.json'),original=await readFile(file),manifest=await readFile(manifestFile,'utf8');
  await writeFile(file,Buffer.concat([original,Buffer.from('tampered')]));
  const targetDir=join(f.root,'not-created');await assert.rejects(restoreService({backupDir,targetDir}),/SERVICE_BACKUP_HASH_MISMATCH/);await assert.rejects(access(targetDir));
  await writeFile(file,original);
  await writeFile(manifestFile,JSON.stringify({...JSON.parse(manifest),database:{...JSON.parse(manifest).database,name:'../private.sqlite'}}));
  await assert.rejects(restoreService({backupDir,targetDir}),/SERVICE_BACKUP_MANIFEST_INVALID/);await assert.rejects(access(targetDir));
  await writeFile(manifestFile,manifest);await writeFile(join(backupDir,'promotion.sqlite-wal'),'unexpected');
  await assert.rejects(restoreService({backupDir,targetDir}),/SERVICE_BACKUP_MANIFEST_INVALID/);await rm(join(backupDir,'promotion.sqlite-wal'));
  const bad=join(f.root,'wrong-service');await mkdir(bad);const db=new DatabaseSync(join(bad,'promotion.sqlite'));db.exec('CREATE TABLE private_data(value TEXT)');db.close();
  const invalidTarget=join(f.root,'invalid-backup');await assert.rejects(backupService({dataDir:bad,backupDir:invalidTarget}),/SERVICE_BACKUP_DATABASE_INVALID/);await assert.rejects(access(invalidTarget));
  const sourceDb=new DatabaseSync(join(f.dataDir,'promotion.sqlite'));sourceDb.exec('CREATE TABLE sqliteExtra(value TEXT)');sourceDb.close();
  await assert.rejects(backupService({dataDir:f.dataDir,backupDir:join(f.root,'extra-table-backup')}),/SERVICE_BACKUP_DATABASE_INVALID/,'sqliteExtra不属于SQLite内部sqlite_前缀，不能被通配过滤掩盖');
});

test('运营CLI子进程对活跃库备份和新目录恢复，不复制API密钥且不覆盖原服务',async t=>{
  const f=await fixture(t),backupDir=join(f.root,'cli-backup'),targetDir=join(f.root,'cli-restored');
  await writeFile(join(f.dataDir,'provider-key.txt'),'synthetic-cli-key-must-not-copy');
  const admin=fileURLToPath(new URL('../scripts/service-admin.mjs',import.meta.url));
  const run=args=>spawnSync(process.execPath,[admin,...args],{encoding:'utf8',windowsHide:true,env:{...process.env,YUANYU_PROMOTION_CONFIG:'',YUANYU_PROMOTION_DATA_DIR:f.dataDir}});
  const backup=run(['backup',backupDir]);assert.equal(backup.status,0,backup.stderr);assert.equal(JSON.parse(backup.stdout).files,2);assert.ok(!backup.stdout.includes('synthetic-cli-key'));
  assert.deepEqual((await readdir(backupDir)).sort(),['promotion.sqlite','service-backup.json']);
  const restore=run(['restore',backupDir,targetDir]);assert.equal(restore.status,0,restore.stderr);assert.equal(JSON.parse(restore.stdout).requiresLogin,true);
  const denied=run(['restore',backupDir,f.dataDir]);assert.notEqual(denied.status,0);assert.match(denied.stderr,/SERVICE_BACKUP_TARGET_EXISTS/);
  assert.equal((await request(f.service.url,'/v1/public')).status,200);assert.deepEqual(query(targetDir,'SELECT * FROM accounts'),[]);
  await assert.rejects(access(join(targetDir,'provider-key.txt')));
});
