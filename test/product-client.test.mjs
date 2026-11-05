import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {createPromotionService} from '../src/service/index.mjs';
import {createProductClient,accountIdentity,isAccountIdentity} from '../src/product/client.mjs';

const password='synthetic-client-password-2026';
function cryptoFixture(){
  const key=randomBytes(32);let available=true;
  return {setAvailable:value=>{available=value;},adapter:{available:()=>available,
    encrypt:text=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([cipher.update(text),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');},
    decrypt:text=>{const data=Buffer.from(text,'base64'),cipher=createDecipheriv('aes-256-gcm',key,data.subarray(0,12));cipher.setAuthTag(data.subarray(12,28));return Buffer.concat([cipher.update(data.subarray(28)),cipher.final()]).toString('utf8');}}};
}
async function fixture(t,options={}){
  const dir=await mkdtemp(join(tmpdir(),'yuanyu-product-client-'));
  const service=await createPromotionService({dataDir:join(dir,'service'),demo:true,monthlyTokens:100000,dailyRequests:20,developer:{name:'开发者',contact:''},...options});
  const crypto=cryptoFixture(),dataDir=join(dir,'client');
  const client=createProductClient({dataDir,cryptoAdapter:crypto.adapter,baseUrl:service.url,allowLocalDemo:true});
  t.after(async()=>{await service.close();await rm(dir,{recursive:true,force:true});});
  const register=async(email='client@example.invalid',name='合成用户')=>client.register({email,password,name});
  return {service,client,register,dataDir,crypto};
}

test('实际HTTP注册/验证/重建客户端/登出：密文会话不回传，空企业邮箱保留',async t=>{
  const f=await fixture(t),before=await f.client.status();
  assert.equal(before.authenticated,false);assert.equal(before.developer.contact,'');assert.equal(before.deployment,'local_demo');
  const registered=await f.register();assert.equal(registered.account.verified,false);assert.ok(registered.demoVerificationCode);
  assert.equal(Object.hasOwn(registered,'sessionToken'),false);
  const disk=await readFile(join(f.dataDir,'account','session.json'),'utf8');
  for(const secret of [password,'client@example.invalid','sessionToken'])assert.ok(!disk.includes(secret));
  assert.equal(typeof JSON.parse(disk).ciphertext,'string');
  await f.client.verify({code:registered.demoVerificationCode});
  const restarted=createProductClient({dataDir:f.dataDir,cryptoAdapter:f.crypto.adapter,baseUrl:f.service.url,allowLocalDemo:true});
  const state=await restarted.status();assert.equal(state.authenticated,true);assert.equal(state.account.verified,true);assert.equal(state.companyWorkflows.readOnly,true);
  assert.ok(!JSON.stringify(state).includes('sessionToken'));assert.ok(!JSON.stringify(state).includes(password));
  await restarted.logout();assert.equal((await f.client.status()).authenticated,false);await assert.rejects(f.client.me(),/AUTH_REQUIRED/);
});

test('个人身份品牌只能由可信账号适配产生，普通复制对象不授予工作区身份',()=>{
  const identity=accountIdentity({id:'synthetic-account',displayName:'合成人员',tier:'personal'});
  assert.equal(isAccountIdentity(identity),true);assert.equal(isAccountIdentity({...identity}),false);assert.equal(Object.isFrozen(identity),true);
  assert.throws(()=>accountIdentity({id:'../escape',displayName:'合成',tier:'personal'}),/ACCOUNT_INVALID/);
  assert.throws(()=>accountIdentity({id:'safe-id',displayName:'合成',tier:'enterprise'}),/ACCOUNT_INVALID/);
});

test('未经验证或逐次同意不能请求，已验证合成调用计费记录来自服务端',async t=>{
  const f=await fixture(t),registered=await f.register();
  await assert.rejects(f.client.requester({modelId:'demo-synthetic',consent:{}}),/MODEL_CONSENT_REQUIRED/);
  await assert.rejects(f.client.requester({modelId:'unavailable',consent:{taskText:true}}),/MODEL_NOT_AVAILABLE/);
  const unverified=await f.client.requester({modelId:'demo-synthetic',consent:{taskText:true,pageContent:false}});
  const input={messages:[{role:'user',content:'解释此合成资料'}],tools:[]};
  await assert.rejects(unverified(input),/VERIFICATION_REQUIRED/);
  await f.client.verify({code:registered.demoVerificationCode});
  const requester=await f.client.requester({modelId:'demo-synthetic',consent:{taskText:true,pageContent:false}}),message=await requester(input);
  assert.equal(message.role,'assistant');assert.match(message.content,/合成/);
  const state=await f.client.me();assert.ok(state.usage.usedTokens>0);assert.equal(state.usage.reservedTokens,0);assert.equal(state.usage.dailyRequestsUsed,1);
});

test('撤销会话或切换账号后旧requester不能再请求；错误不会泄露响应中的敏感内容',async t=>{
  const f=await fixture(t),first=await f.register();await f.client.verify({code:first.demoVerificationCode});
  const requester=await f.client.requester({modelId:'demo-synthetic',consent:{taskText:true}});
  f.service.operator.revokeSessions(first.account.id);
  assert.equal((await f.client.status()).authenticated,false);
  await assert.rejects(requester({messages:[{role:'user',content:'合成'}]}),/AUTH_REQUIRED/);
  await f.client.login({email:first.account.email,password});
  const old=await f.client.requester({modelId:'demo-synthetic',consent:{taskText:true}});
  await f.client.logout();await f.register('other-client@example.invalid','另一位合成用户');
  await assert.rejects(old({messages:[{role:'user',content:'合成'}]}),/CANCELLED/);
  const bad=createProductClient({dataDir:join(f.dataDir,'bad'),cryptoAdapter:f.crypto.adapter,baseUrl:'https://example.invalid',fetchImpl:async()=>new Response(JSON.stringify({error:{code:'AUTH_FAILED',message:password}}),{status:401})});
  await assert.rejects(bad.login({email:'x@example.invalid',password}),error=>error.code==='AUTH_FAILED'&&!error.message.includes(password));
});

test('本机加密不可用不保留明文会话；HTTPS/本机白名单和响应大小约束失败关闭',async t=>{
  const f=await fixture(t);f.crypto.setAvailable(false);
  await assert.rejects(f.register(),/CRYPTO_UNAVAILABLE/);await assert.rejects(readFile(join(f.dataDir,'account','session.json')),error=>error.code==='ENOENT');
  for(const baseUrl of ['http://remote.example.invalid','http://127.0.0.2','https://user:pass@example.invalid','https://example.invalid/path','https://example.invalid?token=synthetic'])assert.throws(()=>createProductClient({dataDir:f.dataDir,cryptoAdapter:f.crypto.adapter,baseUrl,allowLocalDemo:true}),/SERVICE_CONFIG_INVALID/);
  const oversized=createProductClient({dataDir:join(f.dataDir,'oversized'),cryptoAdapter:f.crypto.adapter,baseUrl:'https://example.invalid',fetchImpl:async()=>new Response('x'.repeat(1024*1024+1))});
  assert.equal((await oversized.status()).serviceUnavailable,true);
});

test('推广额度默认未开放，用户重新登录也不能自行恢复额度',async t=>{
  const f=await fixture(t,{monthlyTokens:0,dailyRequests:0}),registered=await f.register();await f.client.verify({code:registered.demoVerificationCode});
  assert.equal((await f.client.status()).limits.configured,false);
  const request=await f.client.requester({modelId:'demo-synthetic',consent:{taskText:true}});
  await assert.rejects(request({messages:[{role:'user',content:'合成'}]}),/PROMOTION_NOT_AVAILABLE/);
  f.service.operator.setQuota({monthlyTokens:10000,dailyRequests:1});
  await request({messages:[{role:'user',content:'合成'}]});
  await f.client.logout();await f.client.login({email:registered.account.email,password});
  const after=await f.client.requester({modelId:'demo-synthetic',consent:{taskText:true}});
  await assert.rejects(after({messages:[{role:'user',content:'合成'}]}),/DAILY_REQUEST_LIMIT/);
  assert.equal((await f.client.me()).usage.dailyRequestsUsed,1);
});
