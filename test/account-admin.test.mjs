import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Readable} from 'node:stream';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createPromotionService} from '../src/service/index.mjs';
import {resetAccountPassword,readAdminPassword} from '../src/service/account-admin.mjs';

const oldPassword='synthetic-original-password',newPassword='synthetic-replacement-password';
async function fixture(t,options={}){
  const dir=await mkdtemp(join(tmpdir(),'yuanyu-account-reset-'));
  const service=await createPromotionService({dataDir:dir,demo:true,monthlyTokens:100000,dailyRequests:20,...options});
  t.after(async()=>{await service.close();await rm(dir,{recursive:true,force:true});});
  const call=async(route,body,token)=>{const response=await fetch(service.url+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,data:await response.json()};};
  const registered=await call('/v1/auth/register',{email:'recover@example.invalid',name:'合成用户',password:oldPassword});assert.equal(registered.status,201);
  const user=registered.data;await call('/v1/auth/verify',{code:user.demoVerificationCode},user.sessionToken);
  return {dir,service,call,user};
}

test('人工重置撤销旧会话，新密码可登录且本人身份/已用额度保持，库中不含明文密码',async t=>{
  const f=await fixture(t),db=new DatabaseSync(join(f.dir,'promotion.sqlite'));
  db.prepare('INSERT INTO quota(account_id,month,used,reserved) VALUES(?,?,?,?)').run(f.user.account.id,'2026-11',123,456);db.close();
  const result=await resetAccountPassword({dataDir:f.dir,email:f.user.account.email,password:newPassword});
  assert.equal(result.requiresLogin,true);assert.equal(result.verified,true);assert.equal(result.sessionsRevoked,1);assert.equal(Object.hasOwn(result,'email'),false);
  assert.equal((await f.call('/v1/me',undefined,f.user.sessionToken)).status,401);
  assert.equal((await f.call('/v1/auth/login',{email:f.user.account.email,password:oldPassword})).status,401);
  const logged=await f.call('/v1/auth/login',{email:f.user.account.email,password:newPassword});assert.equal(logged.status,200);assert.equal(logged.data.account.id,f.user.account.id);
  const checked=new DatabaseSync(join(f.dir,'promotion.sqlite'),{readOnly:true});assert.deepEqual({...checked.prepare('SELECT used,reserved FROM quota WHERE account_id=?').get(f.user.account.id)},{used:123,reserved:456});checked.close();
  const bytes=Buffer.concat(await Promise.all(['promotion.sqlite','promotion.sqlite-wal'].map(file=>readFile(join(f.dir,file)))));
  for(const password of [oldPassword,newPassword])assert.equal(bytes.includes(Buffer.from(password)),false);
});

test('重置不启用停用账号，不替用户完成验证，错误输入或未知账号不修改原密码',async t=>{
  const f=await fixture(t);f.service.operator.setAccountEnabled(f.user.account.id,false);
  for(const args of [{password:'short'}, {email:'missing@example.invalid',password:newPassword}])await assert.rejects(resetAccountPassword({dataDir:f.dir,email:f.user.account.email,password:newPassword,...args}),/ADMIN_/);
  const result=await resetAccountPassword({dataDir:f.dir,email:f.user.account.email,password:newPassword});assert.equal(result.enabled,false);
  assert.equal((await f.call('/v1/auth/login',{email:f.user.account.email,password:newPassword})).status,401);
  f.service.operator.setAccountEnabled(f.user.account.id,true);assert.equal((await f.call('/v1/auth/login',{email:f.user.account.email,password:newPassword})).status,200);
  const pending=await f.call('/v1/auth/register',{email:'pending-recover@example.invalid',name:'待验证',password:oldPassword});assert.equal(pending.status,201);
  const unverified=await resetAccountPassword({dataDir:f.dir,email:pending.data.account.email,password:newPassword});assert.equal(unverified.verified,false);
  const stillUnverified=await f.call('/v1/auth/login',{email:pending.data.account.email,password:newPassword});assert.equal(stillUnverified.data.account.verified,false);
  await assert.rejects(resetAccountPassword({dataDir:resolve('.'),email:f.user.account.email,password:newPassword}),/ADMIN_PATH_INVALID/);
});

test('重置发生在上游请求期间时抑制旧账号回执，保留预留且不自动重试',async t=>{
  let finish,entered;const reached=new Promise(resolve=>{entered=resolve;});let calls=0;
  const f=await fixture(t,{requestModel:async()=>{calls++;entered();return new Promise(resolve=>{finish=resolve;});}});
  const request=f.call('/v1/inference',{requestId:'reset-pending-001',modelId:'demo-synthetic',messages:[{role:'user',content:'读取合成资料'}],tools:[],consent:{taskText:true}},f.user.sessionToken);
  await reached;await resetAccountPassword({dataDir:f.dir,email:f.user.account.email,password:newPassword});
  finish({message:{role:'assistant',content:'合成回执'},usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}});
  assert.equal((await request).status,401);assert.equal(calls,1);
  const db=new DatabaseSync(join(f.dir,'promotion.sqlite'),{readOnly:true});assert.ok(db.prepare('SELECT reserved FROM quota WHERE account_id=?').get(f.user.account.id).reserved>0);db.close();
});

test('非交互密码输入只接受两次一致的有限内容，不把秘密放入命令参数或输出',async t=>{
  assert.equal(await readAdminPassword({input:Readable.from([newPassword+'\n'+newPassword+'\n'])}),newPassword);
  await assert.rejects(readAdminPassword({input:Readable.from([newPassword+'\nother-password-123\n'])}),/ADMIN_PASSWORD_MISMATCH/);
  await assert.rejects(readAdminPassword({input:Readable.from(['x'.repeat(5000)])}),/ADMIN_PASSWORD_INPUT_INVALID/);
  const f=await fixture(t);
  const child=spawn(process.execPath,['scripts/service-admin.mjs','reset-password',f.user.account.email],{cwd:resolve('.'),env:{...process.env,YUANYU_PROMOTION_CONFIG:'',YUANYU_PROMOTION_DATA_DIR:f.dir},stdio:['pipe','pipe','pipe'],windowsHide:true});
  let output='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
  const exited=new Promise(resolve=>child.on('exit',resolve));child.stdin.end(newPassword+'\n'+newPassword+'\n');
  assert.equal(await exited,0,output);assert.ok(!output.includes(newPassword));assert.ok(!output.includes(oldPassword));assert.ok(!output.includes(f.user.sessionToken));
  assert.equal((await f.call('/v1/auth/login',{email:f.user.account.email,password:newPassword})).status,200);
});
