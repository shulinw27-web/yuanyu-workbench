import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {createModelProfiles,PROVIDERS} from '../src/model/profiles.mjs';
import {createBrowserModelRequester,proposeModelPlan,probeModelProfile,modelStatus} from '../src/model/gateway.mjs';

const alice={companyId:'mock-acme',userId:'alice'},bob={companyId:'mock-acme',userId:'bob'},outsider={companyId:'mock-other',userId:'outsider'};
const key='synthetic-primary-api-key',otherKey='synthetic-second-api-key';
const makeInput=(extra={})=>({label:'我的合成模型',provider:'deepseek',baseUrl:PROVIDERS.deepseek.defaultBaseUrl,model:'synthetic-model',dataScope:'selected_pages',apiKey:key,...extra});
const tools=[{type:'function',function:{name:'browser_observe',parameters:{type:'object',properties:{siteId:{type:'string'}},required:['siteId'],additionalProperties:false}}}];
const messages=[{role:'system',content:'Use only read-only tools.'},{role:'user',content:'读取合成记录'}];
const response=(content='OK')=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content}}]}));
async function fixture(t){
  const dataDir=await mkdtemp(join(tmpdir(),'yuanyu-model-profiles-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));const cipherKey=randomBytes(32);let available=true,decrypts=0;
  const cryptoAdapter={available:()=>available,encrypt:text=>{const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',cipherKey,nonce),body=Buffer.concat([cipher.update(text),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),body]).toString('base64');},decrypt:text=>{decrypts++;const bytes=Buffer.from(text,'base64'),decipher=createDecipheriv('aes-256-gcm',cipherKey,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8');}};
  const store=identity=>createModelProfiles({dataDir,identity,cryptoAdapter});return {dataDir,cryptoAdapter,profiles:store(alice),store,decrypts:()=>decrypts,setAvailable:value=>{available=value;},state:identity=>join(dataDir,'model-profiles',identity.companyId,identity.userId,'state.json')};
}

test('多模型密钥整体加密且列表/状态/活动元数据不解密，不回传任何密钥或密文',async t=>{
  const f=await fixture(t);assert.equal((await f.profiles.status()).status,'not_configured');const first=await f.profiles.save(makeInput());
  const raw=await readFile(f.state(alice),'utf8');assert.ok(!raw.includes(key));assert.ok(raw.includes('keyCipher'));
  const state=await f.profiles.list();assert.equal(state.activeId,first.id);assert.equal(state.profiles[0].configured,true);assert.equal(state.profiles[0].revision,1);
  assert.equal((await f.profiles.status()).connection,'not_verified');assert.equal((await modelStatus({profiles:f.profiles})).profileId,first.id);
  const active=await f.profiles.readActive();assert.equal(active.id,first.id);assert.equal(active.enabled,true);assert.equal(f.decrypts(),0);
  for(const value of [first,state,active]){assert.ok(!JSON.stringify(value).includes(key));assert.ok(!JSON.stringify(value).includes('keyCipher'));assert.ok(!Object.hasOwn(value,'apiKey'));}
  let temporary;await f.profiles.withActive(value=>{temporary=value;assert.equal(value.apiKey,key);return true;});assert.equal(temporary.apiKey,'');assert.equal(f.decrypts(),1);
});

test('更新留空保留密钥并重绑模型，CAS防旧写；切换/删除不会偷偷改用其他提供方',async t=>{
  const f=await fixture(t),first=await f.profiles.save(makeInput());
  const updated=await f.profiles.save(makeInput({id:first.id,apiKey:'',model:'synthetic-new-model',expectedRevision:1}));assert.equal(updated.revision,2);
  await f.profiles.withActive(value=>assert.equal(value.apiKey,key));
  await assert.rejects(f.profiles.save(makeInput({id:first.id,apiKey:'',expectedRevision:1})),/MODEL_PROFILE_VERSION_CONFLICT/);
  await assert.rejects(f.profiles.save(makeInput({id:first.id,apiKey:'',provider:'glm',baseUrl:PROVIDERS.glm.defaultBaseUrl})),/MODEL_KEY_REENTRY_REQUIRED/);
  const second=await f.profiles.save(makeInput({label:'备用合成模型',provider:'glm',baseUrl:PROVIDERS.glm.defaultBaseUrl,apiKey:otherKey}));assert.equal((await f.profiles.list()).activeId,first.id);
  await f.profiles.select(second.id);await f.profiles.withActive(value=>assert.equal(value.apiKey,otherKey));await f.profiles.remove(second.id);assert.equal((await f.profiles.list()).activeId,null);assert.equal((await f.profiles.status()).status,'not_configured');
  assert.equal(await f.profiles.readActive(),null);await f.profiles.select(first.id);assert.equal((await f.profiles.list()).activeId,first.id);
});

test('六类国内/自定义预设严格区分普通API，禁止额外字段、明文metadata与非法URL/身份',async t=>{
  const f=await fixture(t);assert.deepEqual(Object.keys(PROVIDERS),['deepseek','glm','qwen','moonshot','ark','custom']);
  for(const [provider,preset]of Object.entries(PROVIDERS))await f.profiles.save(makeInput({provider,baseUrl:preset.defaultBaseUrl||'https://compatible.example.test/v1',label:provider}));
  for(const baseUrl of ['http://plain.example/v1','https://user:pass@model.example/v1','https://model.example/v1?key=abc','https://model.example/v1#x','https://model.example/v1/chat/completions'])await assert.rejects(f.profiles.save(makeInput({provider:'custom',baseUrl})),/MODEL_PROFILE_(HTTPS_REQUIRED|BASE_URL_REQUIRED)/);
  await assert.rejects(f.profiles.save(makeInput({provider:'glm',baseUrl:'https://open.bigmodel.cn/api/coding/paas/v4'})),/MODEL_PROVIDER_ENDPOINT_MISMATCH/);
  await assert.rejects(f.profiles.save(makeInput({keyCipher:'injected'})),/MODEL_PROFILE_INPUT_INVALID/);
  await assert.rejects(f.profiles.save(makeInput({apiKey:''})),/MODEL_KEY_REQUIRED/);
  await assert.rejects(f.profiles.save(makeInput({label:key})),/MODEL_PROFILE_INPUT_SENSITIVE/);
  await assert.rejects(f.profiles.save(makeInput({provider:'constructor'})),/MODEL_PROVIDER_INVALID/);
  assert.throws(()=>createModelProfiles({dataDir:f.dataDir,identity:{companyId:'../escape',userId:'x'},cryptoAdapter:f.cryptoAdapter}),/MODEL_PROFILE_INPUT_INVALID/);
});

test('同公司成员与其他公司隔离，跨人/模型移植密文均被绑定校验阻止',async t=>{
  const f=await fixture(t),first=await f.profiles.save(makeInput());
  for(const identity of [bob,outsider]){const other=f.store(identity);assert.equal((await other.list()).profiles.length,0);await assert.rejects(other.select(first.id),/MODEL_PROFILE_NOT_FOUND/);}
  const other=f.store(bob);await other.save(makeInput({apiKey:otherKey}));
  const a=JSON.parse(await readFile(f.state(alice),'utf8')),b=JSON.parse(await readFile(f.state(bob),'utf8'));b.profiles[0].keyCipher=a.profiles[0].keyCipher;await writeFile(f.state(bob),JSON.stringify(b));
  await assert.rejects(other.withActive(()=>{throw new Error('should not reach callback');}),/MODEL_KEY_BINDING_MISMATCH/);
  a.profiles[0].model='tampered-model';await writeFile(f.state(alice),JSON.stringify(a));await assert.rejects(f.profiles.withActive(()=>true),/MODEL_KEY_BINDING_MISMATCH/);
});

test('不可用加密拒绝保存和请求；并发保存串行落盘，无活进程锁旁路或路径链接覆盖',async t=>{
  const f=await fixture(t);f.setAvailable(false);await assert.rejects(f.profiles.save(makeInput()),/MODEL_(CRYPTO_UNAVAILABLE|CRYPTO_FAILED)/);f.setAvailable(true);
  await Promise.all(Array.from({length:8},(_,i)=>f.profiles.save(makeInput({label:`合成配置${i}`}))));assert.equal((await f.profiles.list()).profiles.length,8);
  f.setAvailable(false);await assert.rejects(f.profiles.withActive(()=>true),/MODEL_CRYPTO_UNAVAILABLE/);assert.equal((await f.profiles.list()).profiles.length,8);
  const moduleUrl=pathToFileURL(join(process.cwd(),'src/model/profiles.mjs')).href;
  const result=await promisify(execFile)(process.execPath,['--input-type=module','-e',`import {createModelProfiles} from ${JSON.stringify(moduleUrl)}; try{await createModelProfiles({dataDir:${JSON.stringify(f.dataDir)},identity:{companyId:'mock-acme',userId:'alice'}}).list();process.exitCode=2;}catch(error){process.stdout.write(error.code);}`]);assert.equal(result.stdout,'MODEL_PROFILE_LOCKED');
  const linked=await mkdtemp(join(tmpdir(),'yuanyu-model-link-'));t.after(()=>rm(linked,{recursive:true,force:true}));await mkdir(join(linked,'model-profiles'),{recursive:true});await symlink(join(f.dataDir,'model-profiles','mock-acme'),join(linked,'model-profiles','mock-acme'),'junction');
  await assert.rejects(createModelProfiles({dataDir:linked,identity:alice,cryptoAdapter:f.cryptoAdapter}).list(),/MODEL_PROFILE_UNSAFE_PATH/);
});

test('保存/选择/状态不联网；浏览器网关只在双授权请求中解密，配置切换拒绝迟到结果',async t=>{
  const f=await fixture(t),first=await f.profiles.save(makeInput()),second=await f.profiles.save(makeInput({label:'备用',apiKey:otherKey}));let calls=0;
  const request=await createBrowserModelRequester({profiles:f.profiles,consent:{taskText:true,pageContent:true},fetchImpl:async(url,options)=>{calls++;assert.equal(url,`${PROVIDERS.deepseek.defaultBaseUrl}/chat/completions`);assert.equal(options.headers.Authorization,`Bearer ${key}`);assert.ok(!options.body.includes(key));return response('合成记录已读取。');}});
  assert.equal(calls,0);assert.equal(f.decrypts(),0);assert.equal((await request({messages,tools})).content,'合成记录已读取。');assert.equal(calls,1);
  await f.profiles.select(second.id);await assert.rejects(request({messages,tools}),/MODEL_CONFIG_CHANGED/);assert.equal(calls,1);
  await f.profiles.select(first.id);const pending=await createBrowserModelRequester({profiles:f.profiles,consent:{taskText:true,pageContent:true},fetchImpl:async()=>{calls++;await f.profiles.select(second.id);return response('不能采用的旧结果');}});await assert.rejects(pending({messages,tools}),/MODEL_CONFIG_CHANGED/);assert.equal(calls,2);
});

test('连接测试必须显式同意，只发送一次16-token最小请求且不回显提供方正文或密钥',async t=>{
  const f=await fixture(t);await f.profiles.save(makeInput({dataScope:'task_text'}));let calls=0;
  const fetchImpl=async(_url,options)=>{calls++;const body=JSON.parse(options.body);assert.equal(body.max_tokens,16);assert.deepEqual(body.thinking,{type:'disabled'});assert.deepEqual(body.messages,[{role:'user',content:'Reply OK.'}]);assert.equal(body.tools,undefined);return response('provider reply may contain details');};
  await assert.rejects(probeModelProfile({profiles:f.profiles,fetchImpl}),/MODEL_PROBE_CONSENT_REQUIRED/);assert.equal(calls,0);assert.equal(f.decrypts(),0);
  const result=await probeModelProfile({profiles:f.profiles,consent:true,fetchImpl});assert.equal(result.connection,'verified');assert.equal(calls,1);assert.ok(!JSON.stringify(result).includes('provider reply'));assert.ok(!JSON.stringify(result).includes(key));assert.equal((await f.profiles.status()).connection,'not_verified');
  await assert.rejects(probeModelProfile({profiles:f.profiles,consent:true,fetchImpl:async()=>{calls++;return new Response('secret provider diagnostics',{status:402});}}),error=>error.code==='MODEL_PAYMENT_REQUIRED'&&error.message==='MODEL_PAYMENT_REQUIRED');assert.equal(calls,2);
});

test('固定配方规划兼容加密多模型配置且只发送任务文本，页面范围不足不会读取密钥',async t=>{
  const f=await fixture(t);await f.profiles.save(makeInput({dataScope:'task_text'}));
  await assert.rejects(createBrowserModelRequester({profiles:f.profiles,consent:{taskText:true,pageContent:true}}),/MODEL_PAGE_SCOPE_REQUIRED/);assert.equal(f.decrypts(),0);
  const result=await proposeModelPlan({profiles:f.profiles,text:'整理采购资料',month:'2026-10',consent:true,fetchImpl:async(_url,options)=>{const body=JSON.parse(options.body);assert.equal(body.messages.length,2);assert.equal(body.max_tokens,1200);assert.equal(body.tool_choice,'auto');assert.deepEqual(JSON.parse(body.messages[1].content),{task:'整理采购资料',selectedMonth:'2026-10'});return new Response(JSON.stringify({choices:[{message:{tool_calls:[{function:{name:'propose_workflow_plan',arguments:JSON.stringify({recipeId:'purchase-monthly',month:'2026-10',explanation:'整理合成资料草稿',needsClarification:false})}}]}}]}));}});assert.equal(result.supported,true);
});

test('密钥解密期间撤换配置也不会发送旧请求，安全account身份沿用独立存储',async t=>{
  const f=await fixture(t);await f.profiles.save(makeInput());const second=await f.profiles.save(makeInput({label:'备用',apiKey:otherKey}));let ready,release,calls=0;
  const started=new Promise(resolve=>{ready=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const delayed=createModelProfiles({dataDir:f.dataDir,identity:alice,cryptoAdapter:{...f.cryptoAdapter,decrypt:async value=>{ready();await gate;return f.cryptoAdapter.decrypt(value);}}});
  const request=await createBrowserModelRequester({profiles:delayed,consent:{taskText:true,pageContent:true},fetchImpl:async()=>{calls++;return response();}});
  const inFlight=request({messages,tools});await started;await f.profiles.select(second.id);release();await assert.rejects(inFlight,/MODEL_CONFIG_CHANGED/);assert.equal(calls,0);
  const account=f.store({companyId:'personal-123',userId:'account-123',provider:'account'});assert.equal(await account.readActive(),null);await account.save(makeInput());assert.equal((await account.list()).profiles.length,1);assert.equal((await f.profiles.list()).profiles.length,2);
});
