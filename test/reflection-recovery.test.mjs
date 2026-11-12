import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {classifyRecovery} from '../src/agent/recovery-policy.mjs';
import {runBrowserToolLoop} from '../src/model/tool-loop.mjs';
import {replayRecipe} from '../src/agent/runtime.mjs';
import {createAgentStore} from '../src/agent/store.mjs';
import {createMemoryStore} from '../src/memory/store.mjs';
import {DAY} from '../src/memory/policy.mjs';
import {createController} from '../src/controller.mjs';

const call=(name,input,id='synthetic-call')=>({tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(input)}}]});
const pageText='合成测试采购单已入库';
const browserPage=()=>({text:pageText,elements:[]});
const base={task:'查看合成订单状态',allowedSiteIds:['site-mock'],consent:{taskText:true,pageContent:true},checkContext:async()=>true,browser:{observe:async()=>browserPage()}};
// Mirrors the store's cumulative budget shape, so reflect() reads used.corrections across attempts.
const counter=()=>{const used={modelRequests:0,rounds:0,tools:0,activeMs:0,corrections:0,reflections:0,estimatedInputTokens:0};const keys={round:'rounds',model:'modelRequests',tool:'tools',correction:'corrections',reflection:'reflections'};return {used,onBudget:async claim=>{used[keys[claim.kind]]++;return {used:{...used}};}};};
const identity={companyId:'mock-acme',userId:'alice',displayName:'合成用户',provider:'mock'};
const binding={id:'site-synthetic',origin:'https://synthetic.example.invalid',revision:1};
const replayStep={tool:'click',siteId:'site-synthetic',locator:{role:'button',name:'查询资料',readOnly:true}};
const replayPage=ref=>({text:'合成资料结果',elements:[{tag:'button',role:'button',label:'查询资料',ref,credential:false}]});

test('B阶段错误分类：只有首次无副作用的限定错误可修正一次，其余停止或人工接管',()=>{
  assert.deepEqual(classifyRecovery({code:'STALE_REFERENCE',effectState:'not_started',correctionsUsed:0}),{action:'repair_once',retry:true,reason:'not_started'});
  assert.equal(classifyRecovery({code:'STALE_REFERENCE',effectState:'not_started',correctionsUsed:1}).action,'stop');
  assert.equal(classifyRecovery({code:'STALE_REFERENCE',effectState:'may_have_occurred',correctionsUsed:0}).action,'stop');
  assert.equal(classifyRecovery({code:'LOGIN_REQUIRED',effectState:'not_started',correctionsUsed:0}).action,'handoff');
  assert.equal(classifyRecovery({code:'MANUAL_HANDOFF_ACTIVE',effectState:'not_started',correctionsUsed:0}).action,'handoff');
  for(const code of ['WRITE_CONFIRM_REQUIRED','WRITE_RECEIPT_UNKNOWN','PROVIDER_TIMEOUT','MONTHLY_QUOTA_EXCEEDED','DAILY_REQUEST_LIMIT','PROMOTION_BUDGET_EXCEEDED','CREDENTIAL_REQUIRED','ORIGIN_MISMATCH','SITE_VERSION_CONFLICT','MODEL_PAYMENT_REQUIRED','MODEL_AUTH_REJECTED','MODEL_TIMEOUT','CANCELLED','AGENT_TIMEOUT','AGENT_CONTEXT_CHANGED','AGENT_BUDGET_EXHAUSTED','AGENT_RESULT_UNVERIFIED','AGENT_TOOL_OUTPUT_INVALID','PAGE_STRUCTURE_CHANGED','PAGE_CONTENT_CONSENT_REQUIRED','AGENT_CORRECTION_NO_CHANGE','UNKNOWN_MODEL_ERROR']){
    assert.equal(classifyRecovery({code,effectState:'not_started',correctionsUsed:0}).action,'stop',code);
  }
  assert.equal(classifyRecovery({code:'STALE_REFERENCE',effectState:'not_started',correctionsUsed:-1}).action,'stop');
});

test('一次可选模型修正后仍走独立Verifier，结构化记录不含页面正文且只占一次修正/复核额度',async()=>{
  const {used,onBudget}=counter(),records=[],feedback=[];let step=0;
  const result=await runBrowserToolLoop({...base,enableReflection:true,onBudget,onReflection:async record=>records.push(record),requestModel:async({messages})=>{
    step++;
    if(step===1)return call('browser_observe',{siteId:'site-mock',unexpected:'bad'});
    if(step===2){for(const message of messages)if(typeof message.content==='string'&&message.content.includes('tool_correction_feedback'))feedback.push(message.content);return call('browser_observe',{siteId:'site-mock'});}
    return {content:'已读取当前合成记录。'};
  }});
  assert.equal(result.status,'awaiting_review');assert.equal(result.corrections,1);assert.equal(step,3);
  assert.equal(used.corrections,1);assert.equal(used.reflections,1);assert.equal(used.modelRequests,3);
  assert.equal(records.length,2);assert.equal(records[0].checkResult,'pending');assert.equal(records[0].nextAction,'reobserve');
  assert.equal(records.at(-1).problemCode,'AGENT_TOOL_INPUT_INVALID');assert.equal(records.at(-1).proposedCorrection,'CORRECT_TOOL_INPUT');
  assert.equal(records.at(-1).checkResult,'needs_review');assert.equal(records.at(-1).nextAction,'await_user_review');
  assert.deepEqual(result.reflection,records.at(-1));assert.deepEqual(records[0].evidenceIds,[]);
  assert.ok(!JSON.stringify(records).includes(pageText));assert.equal(feedback.length,1);
  assert.ok(feedback[0].includes('AGENT_TOOL_INPUT_INVALID'));assert.ok(!feedback[0].includes(pageText));
});

test('未开启额外复核时错误直接停止，不产生修正记录或预算占用',async()=>{
  const {used,onBudget}=counter(),records=[];
  await assert.rejects(runBrowserToolLoop({...base,enableReflection:false,onBudget,onReflection:async record=>records.push(record),requestModel:async()=>call('browser_observe',{siteId:'site-mock',unexpected:'bad'})}),error=>error.code==='AGENT_TOOL_INPUT_INVALID');
  assert.equal(used.corrections,0);assert.equal(used.reflections,0);assert.equal(records.length,0);
});

test('同一类错误再次出现由共享预算拒绝，修正未完成复验时记录为停止',async()=>{
  const {used,onBudget}=counter(),records=[];let step=0;
  await assert.rejects(runBrowserToolLoop({...base,enableReflection:true,onBudget,onReflection:async record=>records.push(record),requestModel:async()=>{
    step++;
    if(step===1)return call('browser_observe',{siteId:'site-mock',unexpected:'bad'});
    if(step===2)return call('browser_observe',{siteId:'site-mock'});
    return call('browser_observe',{siteId:'site-mock',another:'bad2'});
  }}),error=>error.code==='AGENT_TOOL_INPUT_INVALID');
  assert.equal(used.corrections,1);assert.equal(used.reflections,1);
  assert.equal(records.at(-1).checkResult,'rejected');assert.equal(records.at(-1).nextAction,'stop');
});

test('修正后重复同一调用视为无变化并立即停止，不形成循环',async()=>{
  const {used,onBudget}=counter(),records=[];let step=0;
  const invalid=()=>call('browser_observe',{siteId:'site-mock',unexpected:'bad'});
  await assert.rejects(runBrowserToolLoop({...base,enableReflection:true,onBudget,onReflection:async record=>records.push(record),requestModel:async()=>{step++;return invalid();}}),error=>error.code==='AGENT_CORRECTION_NO_CHANGE');
  assert.equal(step,2);assert.equal(used.corrections,1);assert.equal(records.at(-1).checkResult,'rejected');
});

test('越权、费用、超时、未知结果与撤权错误不触发任何修正',async()=>{
  for(const code of ['WRITE_CONFIRM_REQUIRED','PROVIDER_TIMEOUT','MODEL_PAYMENT_REQUIRED','AGENT_CONTEXT_CHANGED','PAGE_STRUCTURE_CHANGED']){
    const {used,onBudget}=counter(),records=[];
    const browser={observe:async()=>{throw Object.assign(new Error(code),{code,effectState:'may_have_occurred'});}};
    await assert.rejects(runBrowserToolLoop({...base,browser,enableReflection:true,onBudget,onReflection:async record=>records.push(record),requestModel:async()=>call('browser_observe',{siteId:'site-mock'})}),error=>error.code===code);
    assert.equal(used.corrections,0);assert.equal(records.length,0);
  }
});

test('Skill重放与模型修正共用一次额度；登录类错误交人工，越权类不重试',async()=>{
  const actError=code=>Object.assign(new Error(code),{code});
  for(const usedCount of [0,1]){
    let acted=0,observed=0,repaired=0;
    const browser={observe:async()=>{observed++;return replayPage('ref-'+observed);},act:async()=>{acted++;throw actError('STALE_REFERENCE');}};
    await assert.rejects(replayRecipe({recipe:[replayStep],check:async()=>{},browser,getCorrectionsUsed:async()=>usedCount,onRepair:async()=>{repaired++;}}),error=>error.code==='STALE_REFERENCE');
    assert.equal(acted,usedCount?1:2);assert.equal(observed,usedCount?1:2);assert.equal(repaired,usedCount?0:1);
  }
  for(const [code,expected] of [['LOGIN_REQUIRED','handoff'],['WRITE_CONFIRM_REQUIRED','stop'],['PROVIDER_TIMEOUT','stop']]){
    let acted=0,handedOff=0,repaired=0;
    const browser={observe:async()=>replayPage('current-ref'),act:async()=>{acted++;throw actError(code);},handoff:async()=>{handedOff++;}};
    const result=await replayRecipe({recipe:[replayStep],check:async()=>{},browser,onRepair:async()=>{repaired++;}}).catch(error=>error);
    assert.equal(repaired,0);assert.equal(acted,1);
    if(expected==='handoff'){assert.equal(result.status,'awaiting_user');assert.equal(handedOff,1);}else assert.equal(result.code,code);
  }
});

test('修正记录为严格白名单，拒绝页面正文、伪造字段与超量，继续任务仍保留',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'yuanyu-reflection-store-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const store=createAgentStore({dataDir,identity});
  const task=await store.createTask({goal:'合成任务',mode:'compatible_browser',siteBindings:[binding]});
  const record={id:'reflection-1',problemCode:'STALE_REFERENCE',evidenceIds:[],proposedCorrection:'REOBSERVE_CURRENT_SITE',checkResult:'verified',nextAction:'deliver'};
  await store.updateTask(task.id,{status:'running',reflections:[record],expectedAttempt:1});
  assert.deepEqual((await store.listTasks()).find(entry=>entry.id===task.id).reflections,[record]);
  const invalid=[
    [{...record,pageText}],[{...record,problemCode:'合成订单正文'}],[{...record,checkResult:'model_says_ok'}],
    [{...record,proposedCorrection:'自动改工作流'}],[{...record,nextAction:'auto_publish'}],
    [{...record,evidenceIds:['<html>']}],Array.from({length:6},(_,index)=>({...record,id:'reflection-'+index}))
  ];
  for(const reflections of invalid)await assert.rejects(store.updateTask(task.id,{status:'running',reflections,expectedAttempt:1}),error=>['AGENT_INPUT_INVALID','AGENT_STORE_INVALID'].includes(error.code));
  const disk=await readFile(join(dataDir,'agents','mock-acme','alice','state.json'),'utf8');
  assert.ok(!disk.includes(pageText));assert.ok(disk.includes('REOBSERVE_CURRENT_SITE'));
  await store.updateTask(task.id,{status:'interrupted'});
  const resumed=await store.resumeTask(task.id);assert.equal(resumed.attempt,2);assert.deepEqual(resumed.reflections,[record]);
});

test('经验候选需独立开关，默认待确认、7天未确认清理且不能自动启用',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'yuanyu-lesson-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const key=randomBytes(32);let instant=Date.parse('2026-11-13T00:00:00Z');
  const cryptoAdapter={available:()=>true,encrypt:text=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),body=Buffer.concat([cipher.update(text),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64');},decrypt:encoded=>{const bytes=Buffer.from(encoded,'base64'),cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8');}};
  const store=createMemoryStore({dataDir,identity:{companyId:'mock-acme',userId:'alice',provider:'mock'},cryptoAdapter,now:()=>instant});
  assert.equal((await store.snapshot()).settings.rememberLessons,false);
  await assert.rejects(store.updateSettings({}),/MEMORY_INPUT_INVALID/);
  await store.updateSettings({rememberLessons:true,expectedRevision:await store.getRevision()});
  assert.equal((await store.snapshot()).settings.rememberLessons,true);
  const candidate=await store.save({kind:'lesson',title:'一次修正经验（待确认）',content:'遇到 STALE_REFERENCE 时按限定路径重新观察并复验；复验结果 verified。',siteBindings:[],source:{type:'verified_run',id:'synthetic-run'},confirmed:false});
  assert.equal(candidate.status,'proposed');assert.equal(Date.parse(candidate.expiresAt)-instant,7*DAY);
  assert.deepEqual((await store.retrieve({query:'修正'})).entries,[]);
  await assert.rejects(store.setEnabled({id:candidate.id,enabled:true,expectedRevision:1}),/MEMORY_CONFIRM_REQUIRED/);
  instant+=8*DAY;assert.deepEqual((await store.snapshot()).entries,[]);
});

const crypto=()=>{const key=randomBytes(32);return {available:()=>true,encrypt:text=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),body=Buffer.concat([cipher.update(text),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64');},decrypt:encoded=>{const bytes=Buffer.from(encoded,'base64'),cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8');}};};
async function controllerFixture(t){
  const dataDir=await mkdtemp(join(tmpdir(),'yuanyu-b-controller-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const systems=Object.fromEntries([['procurement',15331],['warehouse',15332]].map(([id,port])=>[id,{id,label:id,origin:`http://127.0.0.1:${port}`,url:`http://127.0.0.1:${port}/`}]));
  const browser={open:async()=>({mode:'automatic'}),observe:async()=>browserPage(),handoff:async()=>({}),cancel:async()=>{},close:async()=>{}};
  let turn=0;
  const controller=await createController({dataDir,cryptoAdapter:crypto(),systems,BrowserWindow:class{},interactiveFactory:()=>browser,
    agentRequesterFactory:()=>async()=>{turn++;
      if(turn===1)return call('browser_observe',{siteId:'site-business',unexpected:'bad'});
      if(turn===2)return call('browser_observe',{siteId:'site-business'});
      return {content:'已读取当前合成页面。'};}});
  t.after(()=>controller.close());return {controller,dataDir};
}

test('控制器闭环：修正与复验可见，经验候选需要独立开关、默认待确认且不自动改Skill',async t=>{
  for(const enabled of [false,true])await t.test(enabled?'开关打开':'开关关闭',async()=>{
    const {controller}=await controllerFixture(t);
    const site=await controller.invoke('site.register',{id:'site-business',label:'合成业务配置',origin:'https://fixture.example.invalid',entryPath:'/',paths:['/']});
    if(enabled){const revision=(await controller.snapshot()).memory.revision;await controller.invoke('memory.settings',{rememberLessons:true,expectedRevision:revision});}
    const {taskId}=await controller.invoke('agent.start',{goal:'查看合成业务状态',siteIds:[site.id],mode:'compatible_browser',consent:{taskText:true,pageContent:true},enableReflection:true});
    await controller.waitForIdle();
    let state=await controller.snapshot(),task=state.agentTasks.find(entry=>entry.id===taskId);
    assert.equal(task.status,'awaiting_review',JSON.stringify(task.error));
    assert.equal(task.reflections.length,1);assert.equal(task.reflections[0].problemCode,'AGENT_TOOL_INPUT_INVALID');
    assert.equal(task.reflections[0].checkResult,'needs_review');assert.equal(task.reflections[0].nextAction,'await_user_review');
    assert.equal(task.budget.used.corrections,1);assert.equal(task.budget.used.reflections,1);
    assert.ok(!JSON.stringify(task.reflections).includes(pageText));
    await controller.invoke('agent.confirmResult',{id:taskId,confirmed:true,expectedAttempt:task.attempt});
    state=await controller.snapshot();const lessons=state.memory.entries.filter(entry=>entry.kind==='lesson');
    if(enabled){
      assert.equal(lessons.length,1);assert.equal(lessons[0].status,'proposed');assert.equal(lessons[0].source.id,taskId);
      assert.ok(!lessons[0].content.includes(pageText));assert.ok(lessons[0].content.includes('AGENT_TOOL_INPUT_INVALID'));
      assert.equal(state.agentSkills.length,0);
    }else assert.equal(lessons.length,0);
  });
});
