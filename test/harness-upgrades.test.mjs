import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runBrowserToolLoop,PROMPT_VERSION} from '../src/model/tool-loop.mjs';
import {classifyRecovery} from '../src/agent/recovery-policy.mjs';
import {createTaskBudget,validateTaskBudget,claimTaskBudget} from '../src/agent/budget.mjs';
import {createAgentStore} from '../src/agent/store.mjs';

const call=(name,input,id)=>({tool_calls:[{id:id??`call-${Math.random().toString(36).slice(2,8)}`,type:'function',function:{name,arguments:JSON.stringify(input)}}]});
const calls=list=>({tool_calls:list.map((entry,index)=>({id:`call-${index+1}`,type:'function',function:{name:entry.name,arguments:JSON.stringify(entry.input)}}))});
const timed=code=>Object.assign(new Error(code),{code});
const page=site=>({text:`合成记录 ${site}`,elements:[]});
// Mirrors the store's cumulative budget shape so corrections accounting is visible.
const counter=()=>{const used={modelRequests:0,rounds:0,tools:0,activeMs:0,corrections:0,reflections:0,estimatedInputTokens:0,compactions:0};const keys={round:'rounds',model:'modelRequests',tool:'tools',correction:'corrections',reflection:'reflections',compaction:'compactions'};return {used,onBudget:async claim=>{used[keys[claim.kind]]++;return {used:{...used}};}};};
const trackedBrowser=(observeImpl=()=>page('site-mock'))=>{
  let inFlight=0,maxInFlight=0;
  const wrap=fn=>async(...args)=>{inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);try{return await fn(...args);}finally{inFlight--;}};
  const open=async()=>({mode:'automatic'});
  return {browser:{open:wrap(open),observe:wrap(async id=>(observeImpl(id))),handoff:async()=>({}),act:wrap(async()=>({status:'acted'}))},maxInFlight:()=>maxInFlight,resetMax:()=>{maxInFlight=0;}};
};
const base={task:'查看合成订单状态',consent:{taskText:true,pageContent:true},checkContext:async()=>true};

// M-D1 prefix-stability: the system/task prefix is byte-identical across rounds within one task.
test('前缀稳定契约：同一任务各轮消息前缀字节相同且不含轮次相关内容',async()=>{
  const seen=[];
  const result=await runBrowserToolLoop({...base,allowedSiteIds:['site-mock'],browser:{observe:async()=>page('site-mock')},requestModel:async({messages})=>{seen.push(structuredClone(messages));return seen.length===1?call('browser_observe',{siteId:'site-mock'}):{content:'已读取当前合成记录。'};}});
  assert.equal(result.status,'awaiting_review');
  assert.deepEqual(seen[0].slice(0,2),seen[1].slice(0,2));
  assert.ok(!JSON.stringify(seen[0].slice(0,2)).includes('step')||!seen[0][0].content.includes('step'));
  assert.equal(typeof PROMPT_VERSION,'number');
});

// M-D2 A-class transient read failures become observations; the model stays informed and may retry within budget.
test('A类瞬时读取错误回喂为观察，不消耗修正额度，模型可知情重试',async()=>{
  let reads=0;const {used,onBudget}=counter();
  const result=await runBrowserToolLoop({...base,allowedSiteIds:['site-mock'],enableReflection:true,onBudget,browser:{observe:async()=>{if(++reads===1)throw timed('BROWSER_TIMEOUT');return page('site-mock');}},requestModel:async({messages})=>{
    if(reads===0)return call('browser_observe',{siteId:'site-mock'});
    if(reads===1){const feedback=messages.find(message=>message.role==='tool'&&message.content.includes('BROWSER_TIMEOUT'));assert.ok(feedback,'失败必须以工具消息回喂');assert.ok(feedback.content.includes('without side effects'));return call('browser_observe',{siteId:'site-mock'});}
    return {content:'重试读取成功，合成记录已入库。'};
  }});
  assert.equal(result.status,'awaiting_review');assert.equal(reads,2);
  assert.equal(result.corrections,0);assert.equal(used.corrections,0);assert.equal(used.reflections,0);
});

// M-D2 act failures stay conservative: may_have_occurred never feeds back as a harmless observation.
test('browser_act瞬时失败保持may_have_occurred并直接停止，不回喂不修正',async()=>{
  const {used,onBudget}=counter();
  let rounds=0;
  await assert.rejects(runBrowserToolLoop({...base,allowedSiteIds:['site-mock'],onBudget,
    browser:{observe:async()=>({text:'合成记录',elements:[{ref:'r-00000000-0000-0000-0000-000000000000-1',label:'查询',tag:'button',credential:false}]}),act:async()=>{throw timed('BROWSER_TIMEOUT');}},
    requestModel:async()=>++rounds===1?call('browser_observe',{siteId:'site-mock'}):call('browser_act',{siteId:'site-mock',action:{type:'click',ref:'r-00000000-0000-0000-0000-000000000000-1'}})}),
  error=>error.code==='BROWSER_TIMEOUT');
  assert.equal(used.corrections,0);
  assert.equal(classifyRecovery({code:'BROWSER_TIMEOUT',effectState:'may_have_occurred',correctionsUsed:0,tool:'browser_act'}).action,'stop');
});

// M-D2 loop fingerprint: repeating the identical failing call is a stuck loop, not a retry.
test('同一失败调用连续重复触发AGENT_LOOPS_DETECTED，有界不再循环',async()=>{
  let rounds=0;
  await assert.rejects(runBrowserToolLoop({...base,allowedSiteIds:['site-mock'],browser:{observe:async()=>{throw timed('BROWSER_READ_FAILED');}},requestModel:async()=>{rounds++;return call('browser_observe',{siteId:'site-mock'});}}),error=>error.code==='AGENT_LOOPS_DETECTED');
  assert.equal(rounds,2);
});

// M-D3 concurrent pure reads across distinct sites; resolved messages keep fixed call order.
test('异站纯读并行执行，工具消息按调用顺序对应tool_call_id',async()=>{
  const {browser,maxInFlight}=trackedBrowser(async id=>{await new Promise(resolve=>setTimeout(resolve,15));return page(id);});
  let seen;
  const result=await runBrowserToolLoop({...base,allowedSiteIds:['site-a','site-b'],browser,requestModel:async({messages})=>{
    if(messages.some(message=>message.role==='tool')){seen=structuredClone(messages);return {content:'两个站点的合成记录均已读取。'};}
    return calls([{name:'browser_observe',input:{siteId:'site-b'}},{name:'browser_observe',input:{siteId:'site-a'}}]);
  }});
  assert.equal(result.status,'awaiting_review');
  assert.equal(maxInFlight(),2,'异站observe应并发');
  const assistant=seen.filter(message=>message.role==='assistant').at(-1);
  const tools=seen.filter(message=>message.role==='tool');
  assert.equal(assistant.tool_calls.length,2);
  assert.deepEqual(tools.map(message=>message.tool_call_id),['call-1','call-2']);
  assert.ok(tools[0].content.includes('site-b'));assert.ok(tools[1].content.includes('site-a'));
});

// M-D3 degenerate batches (same site or non-observe tools) fall back to serial execution.
test('同站重复读取与非纯读批量降级为串行执行',async()=>{
  const {browser:browserA,maxInFlight:maxSameSite}=trackedBrowser(async id=>{await new Promise(resolve=>setTimeout(resolve,10));return page(id);});
  const result=await runBrowserToolLoop({...base,allowedSiteIds:['site-mock'],browser:browserA,requestModel:async({messages})=>messages.some(message=>message.role==='tool')?{content:'同站读取完成。'}:calls([{name:'browser_observe',input:{siteId:'site-mock'}},{name:'browser_observe',input:{siteId:'site-mock'}}])});
  assert.equal(result.status,'awaiting_review');assert.equal(maxSameSite(),1,'同站批量必须串行');
  const {browser:browserB,maxInFlight:maxMixed,resetMax}=trackedBrowser();
  let round=0;
  await runBrowserToolLoop({...base,allowedSiteIds:['site-a','site-b'],browser:browserB,requestModel:async()=>{
    if(++round===1)return calls([{name:'browser_open',input:{siteId:'site-a'}},{name:'browser_open',input:{siteId:'site-b'}}]);
    if(round===2){assert.equal(maxMixed(),1,'非纯读批量必须串行');resetMax();return calls([{name:'browser_observe',input:{siteId:'site-a'}},{name:'browser_observe',input:{siteId:'site-b'}}]);}
    return {content:'读取完成。'};
  }});
  assert.equal(maxMixed(),2,'后续纯读批量仍可并行');
});

// M-D4 the requester may return {message, usage}; usage accumulates honestly across rounds.
test('usage跨轮累计透传，未报告保持null，非法用量拒绝响应',async()=>{
  const requestModel=async({messages})=>messages.some(message=>message.role==='tool')
    ?{message:{content:'已读取当前合成记录。'},usage:{promptTokens:200,completionTokens:5,cachedTokens:30}}
    :{message:call('browser_observe',{siteId:'site-mock'}),usage:{promptTokens:100,completionTokens:10,cachedTokens:null}};
  const result=await runBrowserToolLoop({...base,allowedSiteIds:['site-mock'],browser:{observe:async()=>page('site-mock')},requestModel});
  assert.deepEqual(result.usage,{promptTokens:300,completionTokens:15,cachedTokens:30});
  assert.equal(result.compactions,0);assert.equal(result.promptVersion,PROMPT_VERSION);
  const unreported=await runBrowserToolLoop({...base,allowedSiteIds:['site-mock'],browser:{observe:async()=>page('site-mock')},requestModel:async({messages})=>messages.some(message=>message.role==='tool')?{message:{content:'已读取。'},usage:null}:{message:call('browser_observe',{siteId:'site-mock'}),usage:null}});
  assert.equal(unreported.usage,null);
  await assert.rejects(runBrowserToolLoop({...base,allowedSiteIds:['site-mock'],browser:{observe:async()=>page('site-mock')},requestModel:async()=>({message:call('browser_observe',{siteId:'site-mock'}),usage:{promptTokens:-1}})}),error=>error.code==='AGENT_MODEL_RESPONSE_INVALID');
});

// M-D4 budget schema v2: compactions key, profile ceilings, v1 atomic migration, compaction claims.
test('预算v2：compactions键、分档caps、v1迁移与compaction记账',()=>{
  const standard=createTaskBudget({});
  assert.equal(standard.schemaVersion,2);assert.equal(standard.profile,'standard');
  assert.equal(standard.limits.compactions,2);assert.equal(standard.used.compactions,0);
  const induction=createTaskBudget({profile:'induction'});
  assert.equal(induction.profile,'induction');assert.equal(induction.limits.modelRequests,3);
  assert.equal(induction.limits.rounds,6);assert.equal(induction.limits.compactions,0);
  assert.equal(createTaskBudget({skill:true}).limits.modelRequests,0);
  const v1={schemaVersion:1,limits:{modelRequests:8,rounds:12,tools:100,activeMs:45000,corrections:1,reflections:1,estimatedInputTokens:14_000_000},used:{modelRequests:1,rounds:1,tools:2,activeMs:100,corrections:0,reflections:0,estimatedInputTokens:1000}};
  const migrated=validateTaskBudget(v1);
  assert.equal(migrated.schemaVersion,2);assert.equal(migrated.profile,'standard');
  assert.equal(migrated.limits.compactions,2);assert.equal(migrated.used.compactions,0);
  let budget=createTaskBudget({});
  budget=claimTaskBudget(budget,{kind:'compaction'});budget=claimTaskBudget(budget,{kind:'compaction'});
  assert.equal(budget.used.compactions,2);
  assert.throws(()=>claimTaskBudget(budget,{kind:'compaction'}),/AGENT_BUDGET_EXHAUSTED/);
  assert.throws(()=>claimTaskBudget(budget,{kind:'unknown'}),/AGENT_BUDGET_INVALID/);
  assert.throws(()=>validateTaskBudget({...standard,profile:'other'}),/AGENT_BUDGET_INVALID/);
  assert.throws(()=>validateTaskBudget({...structuredClone(standard),limits:{...standard.limits,reflections:0}}),/AGENT_BUDGET_INVALID/);
  const zeroReflections=structuredClone(createTaskBudget({profile:'induction'}));
  assert.equal(zeroReflections.limits.reflections,0);
  validateTaskBudget(zeroReflections);
});

// M-D4 the task record persists cost observability fields under a strict whitelist.
test('任务终态落盘usage/promptVersion/compactions白名单字段并拒绝非法值',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'yuanyu-harness-store-'));
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const store=createAgentStore({dataDir,identity:{companyId:'mock-acme',userId:'alice',displayName:'合成用户',provider:'mock'}});
  const task=await store.createTask({goal:'查看合成订单状态',siteBindings:[{id:'site-synthetic',origin:'https://synthetic.example.invalid',revision:1}],mode:'mock_browser',budget:createTaskBudget({})});
  const updated=await store.updateTask(task.id,{status:'awaiting_review',message:'已读取。',usage:{promptTokens:120,completionTokens:8,cachedTokens:null},promptVersion:2,compactions:0});
  assert.deepEqual(updated.usage,{promptTokens:120,completionTokens:8,cachedTokens:null});
  assert.equal(updated.promptVersion,2);assert.equal(updated.compactions,0);
  const unreported=await store.createTask({goal:'再次查看',siteBindings:[{id:'site-synthetic',origin:'https://synthetic.example.invalid',revision:1}],mode:'mock_browser',budget:createTaskBudget({})});
  const updatedNull=await store.updateTask(unreported.id,{status:'awaiting_review',message:'已读取。',usage:null});
  assert.equal(updatedNull.usage,null);
  const bad=await store.createTask({goal:'第三次查看',siteBindings:[{id:'site-synthetic',origin:'https://synthetic.example.invalid',revision:1}],mode:'mock_browser',budget:createTaskBudget({})});
  await assert.rejects(store.updateTask(bad.id,{status:'awaiting_review',usage:{promptTokens:1,unknown:2}}),error=>error.code==='AGENT_INPUT_INVALID');
  await assert.rejects(store.updateTask(bad.id,{status:'awaiting_review',promptVersion:0}),error=>error.code==='AGENT_STORE_INVALID');
  await assert.rejects(store.updateTask(bad.id,{status:'awaiting_review',compactions:3}),error=>error.code==='AGENT_STORE_INVALID');
});
