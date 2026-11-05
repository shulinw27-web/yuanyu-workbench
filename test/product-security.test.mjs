import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {createPromotionService} from '../src/service/index.mjs';
import {createProductClient} from '../src/product/client.mjs';

const password='synthetic-security-password-2026';
const usage={prompt_tokens:10,completion_tokens:5,total_tokens:15};
function encryption(){
  const key=randomBytes(32);
  return {available:()=>true,encrypt:text=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),body=Buffer.concat([cipher.update(text),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64');},decrypt:text=>{const bytes=Buffer.from(text,'base64'),decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8');}};
}
async function fixture(t,requestModel){
  const root=await mkdtemp(join(tmpdir(),'yuanyu-product-security-')),dataDir=join(root,'service'),services=[];
  const start=async()=>{
    for(let attempt=0;attempt<10;attempt++){
      const service=await createPromotionService({dataDir,demo:true,monthlyTokens:100_000,dailyRequests:20,requestModel});services.push(service);
      // Windows may assign a WHATWG-forbidden ephemeral port (e.g. 6000).
      try{await fetch(service.url+'/v1/public');return service;}
      catch(error){await service.close();if(error.cause?.message!=='bad port')throw error;}
    }
    throw new Error('NO_FETCH_COMPATIBLE_TEST_PORT');
  };
  const service=await start();
  const call=async(route,{token,body,base=service.url}={})=>{const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,data:await response.json()};};
  const register=async()=>{const result=await call('/v1/auth/register',{body:{email:'security@example.invalid',password,name:'合成审查账号'}});assert.equal(result.status,201);await call('/v1/auth/verify',{token:result.data.sessionToken,body:{code:result.data.demoVerificationCode}});return result.data;};
  t.after(async()=>{for(const service of services.reverse())await service.close();await rm(root,{recursive:true,force:true});});
  return {root,dataDir,service,start,call,register};
}
const inference=(requestId,extra={})=>({requestId,modelId:'demo-synthetic',messages:[{role:'user',content:'读取合成数据'}],tools:[],consent:{taskText:true,pageContent:true},...extra});

test('推广提供方null可选字段正常结算，有界思考字段仅留内存并且重启不会重复付费调用',async t=>{
  const reasoning='synthetic-private-provider-continuation';let calls=0;
  const f=await fixture(t,async()=>{calls++;return {message:{role:'assistant',content:'当前合成结果',tool_calls:null,reasoning_content:reasoning},usage};}),user=await f.register();
  const body=inference('private-context-01');
  const initial=await f.call('/v1/inference',{token:user.sessionToken,body});assert.equal(initial.status,200);assert.equal(initial.data.message.reasoning_content,reasoning);
  assert.deepEqual((await f.call('/v1/inference',{token:user.sessionToken,body})).data,initial.data);assert.equal(calls,1);
  const bytes=Buffer.concat(await Promise.all(['promotion.sqlite','promotion.sqlite-wal'].map(file=>readFile(join(f.dataDir,file)))));
  assert.equal(bytes.includes(Buffer.from(reasoning)),false);
  const next=await f.start();
  const repeat=await f.call('/v1/inference',{token:user.sessionToken,body,base:next.url});assert.equal(repeat.status,409);assert.equal(repeat.data.error.code,'REQUEST_CONTEXT_EXPIRED');assert.equal(calls,1);
  const me=await f.call('/v1/me',{token:user.sessionToken});assert.equal(me.data.usage.usedTokens,15);assert.equal(me.data.usage.reservedTokens,0);
});

test('推广工具轮次接受有界思考上下文并透传上游，不写账本且不得由用户/工具角色伪造',async t=>{
  const reasoning='synthetic-tool-context-only';let calls=0;
  const f=await fixture(t,async({messages})=>{calls++;assert.equal(messages[1].reasoning_content,reasoning);return {message:{role:'assistant',content:'工具结果已读取',tool_calls:null,reasoning_content:null},usage};}),user=await f.register();
  const extra={messages:[{role:'user',content:'读取合成数据'},{role:'assistant',content:null,reasoning_content:reasoning,tool_calls:[{id:'call-1',type:'function',function:{name:'browser_observe',arguments:'{"siteId":"synthetic"}'}}]},{role:'tool',tool_call_id:'call-1',content:'合成结果'}]};
  const result=await f.call('/v1/inference',{token:user.sessionToken,body:inference('tool-context-001',extra)});assert.equal(result.status,200);assert.equal(calls,1);
  const bytes=Buffer.concat(await Promise.all(['promotion.sqlite','promotion.sqlite-wal'].map(file=>readFile(join(f.dataDir,file)))));assert.equal(bytes.includes(Buffer.from(reasoning)),false);
  for(const message of [{role:'user',content:'合成',reasoning_content:reasoning},{role:'tool',content:'合成',tool_call_id:'call-1',reasoning_content:reasoning},{role:'assistant',content:'合成',reasoning_content:'x'.repeat(30001)}]){
    const invalid=await f.call('/v1/inference',{token:user.sessionToken,body:inference('invalid-context-'+calls,{messages:[{role:'user',content:'合成'},message]})});assert.equal(invalid.status,400);
  }
  assert.equal(calls,1);
});

test('旧账号授权查询返回期间换号不能将旧任务计入新账号额度',async t=>{
  let calls=0,hold=false,entered,release;
  const f=await fixture(t,async()=>{calls++;return {message:{role:'assistant',content:'合成结果'},usage};});
  const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const client=createProductClient({dataDir:join(f.root,'client'),cryptoAdapter:encryption(),baseUrl:f.service.url,allowLocalDemo:true,fetchImpl:async(url,options)=>{
    const response=await fetch(url,options);
    if(hold&&url.endsWith('/v1/me')){hold=false;entered();await gate;}
    return response;
  }});
  const first=await client.register({email:'first-security@example.invalid',password,name:'第一位'});await client.verify({code:first.demoVerificationCode});
  const requester=await client.requester({modelId:'demo-synthetic',consent:{taskText:true,pageContent:false}});
  hold=true;const result=requester({messages:[{role:'user',content:'第一位的合成任务'}],tools:[]});const rejected=assert.rejects(result,/CANCELLED/);
  await started;await client.logout();
  const second=await client.register({email:'second-security@example.invalid',password,name:'第二位'});await client.verify({code:second.demoVerificationCode});
  release();await rejected;
  assert.equal(calls,0);const me=await client.me();assert.equal(me.account.id,second.account.id);assert.equal(me.usage.dailyRequestsUsed,0);assert.equal(me.usage.usedTokens,0);
});

test('提供方扩展metadata仅投影安全字段，客户端不能注入同样扩展字段',async t=>{
  let calls=0;
  const f=await fixture(t,async()=>{calls++;return {message:{role:'assistant',content:'合成结果',refusal:null,annotations:[],provider_internal:'must-not-return'},usage};}),user=await f.register();
  const result=await f.call('/v1/inference',{token:user.sessionToken,body:inference('provider-meta-01')});
  assert.equal(result.status,200);assert.deepEqual(result.data.message,{role:'assistant',content:'合成结果'});
  const rejected=await f.call('/v1/inference',{token:user.sessionToken,body:inference('client-meta-001',{messages:[{role:'user',content:'合成'},{role:'assistant',content:'旧结果',refusal:null}]})});
  assert.equal(rejected.status,400);assert.equal(calls,1);
});
