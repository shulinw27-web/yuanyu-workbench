import test from 'node:test';
import assert from 'node:assert/strict';
import {induceWorkflowRecipe,PROPOSE_RECIPE_TOOL} from '../src/agent/induct.mjs';
import {createTaskBudget} from '../src/agent/budget.mjs';

const SITE={id:'interactive-mock',origin:'http://127.0.0.1:15333',revision:1};
const TRACE=[
  {tool:'open',siteId:SITE.id},
  {tool:'observe',siteId:SITE.id},
  {tool:'select',siteId:SITE.id,locator:{role:'combobox',name:'月份',readOnly:true},value:'2026-10'},
  {tool:'click',siteId:SITE.id,locator:{role:'button',name:'筛选合成记录',readOnly:true}}
];
const GOOD_STEPS=[
  {siteId:SITE.id,action:{type:'select',role:'combobox',name:'月份',value:'2026-10'}},
  {siteId:SITE.id,action:{type:'click',role:'button',name:'筛选合成记录'}}
];
const toolCall=argumentsObject=>({message:{tool_calls:[{id:'induct-1',type:'function',function:{name:'propose_recipe',arguments:JSON.stringify(argumentsObject)}}]}});
const validRecipe=(overrides={})=>({name:'按月份查看合成资料',description:'先选月份再筛选',steps:GOOD_STEPS,...overrides});

function fixture({failActOnce=false,month='2026-10'}={}){
  let revision=0,acts=0,checks=0;
  const page=()=>({siteId:SITE.id,revision:++revision,title:'合成记录',text:`${month} SYN-101 12345`,elements:[
    {ref:`select-${revision}`,tag:'select',role:'combobox',label:'月份',credential:false,readOnly:false},
    {ref:`filter-${revision}`,tag:'button',role:'button',label:'筛选合成记录',credential:false,readOnly:false}
  ]});
  const browser={open:async()=>({ok:true}),observe:async()=>page(),handoff:async()=>({ok:true}),
    act:async()=>{acts++;if(failActOnce&&acts===1)throw Object.assign(new Error('synthetic-internal'),{code:'BROWSER_OPERATION_FAILED'});return {ok:true};}};
  const demonstration={trace:structuredClone(TRACE),siteBindings:[SITE],mode:'mock_browser',browser,check:async()=>{checks++;return true;}};
  return {demonstration,counts:()=>({acts,checks})};
}

test('归纳管线五步产出数据配方，usage透传且全链仍走确定性试运行',async()=>{
  const {demonstration,counts}=fixture();
  const calls=[],checkpoints=[];
  const result=await induceWorkflowRecipe({demonstration,goal:'把选月份和筛选保存为流程',
    requestModel:async input=>{calls.push(input);assert.deepEqual(input.tools,[PROPOSE_RECIPE_TOOL]);return {...toolCall(validRecipe()),usage:{promptTokens:500,completionTokens:60,cachedTokens:0}};},
    budget:createTaskBudget({profile:'induction'}),onCheckpoint:async event=>checkpoints.push(event)});
  assert.equal(result.status,'awaiting_confirmation');
  assert.equal(result.modelRequests,1);assert.equal(result.corrections,0);
  assert.deepEqual(result.usage,{promptTokens:500,completionTokens:60,cachedTokens:0});
  assert.equal(result.candidate.kind,'browser');assert.equal(result.candidate.mode,'mock_browser');
  assert.equal(result.candidate.verification.status,'verified');assert.equal(result.candidate.replay,'completed');
  assert.deepEqual(result.candidate.trace.map(step=>step.tool),['open','select','click']);
  assert.equal(result.candidate.parameterSlots.length,0);
  assert.equal(calls.length,1);assert.equal(calls[0].messages.length,2);
  assert.ok(counts().acts>=2);assert.ok(counts().checks>0);
  assert.deepEqual(checkpoints.map(cp=>cp.stage),['induction_request','induction_request','trial','trial','complete']);
  const encoded=JSON.stringify(result);for(const leaked of ['SYN-101','12345','synthetic-internal'])assert.ok(!encoded.includes(leaked));
});

test('归纳输出必须是单个propose_recipe闭集调用，散文/多调用/错名/schema外字段一律拒绝',async()=>{
  const bad=[
    {message:{content:'这是一段自由散文，不是工具调用'}},
    {message:{tool_calls:[]}},
    {message:{tool_calls:[{function:{name:'propose_recipe',arguments:'{}'}},{function:{name:'propose_recipe',arguments:'{}'}}]}},
    {message:{tool_calls:[{function:{name:'browser_act',arguments:'{}'}}]}},
    toolCall({name:'x',steps:GOOD_STEPS,extra:'evil'}),
    toolCall({name:'x',description:42,steps:GOOD_STEPS}),
    toolCall('not-an-object')
  ];
  for(const response of bad){
    const {demonstration}=fixture();
    await assert.rejects(induceWorkflowRecipe({demonstration,goal:'保存为流程',requestModel:async()=>response,budget:createTaskBudget({profile:'induction'})}),/INDUCTION_OUTPUT_INVALID/);
  }
});

test('确定性校验：站点/角色/名称/值必须来自示范，参数槽最多三个且只能引用已声明槽',async()=>{
  const bad=[
    [{siteId:'evil-site',action:{type:'click',role:'button',name:'筛选合成记录'}}],
    [{siteId:SITE.id,action:{type:'click',role:'button',name:'未示范按钮'}}],
    [{siteId:SITE.id,action:{type:'select',role:'combobox',name:'月份',value:'2099-01'}}],
    [{siteId:SITE.id,action:{type:'fill',role:'textbox',name:'月份',value:'2026-10'}}],
    [{siteId:SITE.id,action:{type:'click',role:'button',name:'筛选合成记录',value:'x'}}],
    [{siteId:SITE.id,action:{type:'select',role:'combobox',name:'月份',value:'{{month}}'}}],
    [{siteId:SITE.id,action:{type:'select',role:'combobox',name:'月份',value:'2026-10'},parameterSlots:[{name:'a'},{name:'b'},{name:'c'},{name:'d'}]}]
  ];
  for(const steps of bad){
    const {demonstration}=fixture();
    await assert.rejects(induceWorkflowRecipe({demonstration,goal:'保存为流程',requestModel:async()=>toolCall(validRecipe({steps})),budget:createTaskBudget({profile:'induction'})}),/INDUCTION_OUTPUT_INVALID/);
  }
  const {demonstration}=fixture();
  const ok=await induceWorkflowRecipe({demonstration,goal:'保存为流程',requestModel:async()=>toolCall(validRecipe({steps:[
    {siteId:SITE.id,action:{type:'select',role:'combobox',name:'月份',value:'{{month}}'},parameterSlots:[{name:'month'}]},
    {siteId:SITE.id,action:{type:'click',role:'button',name:'筛选合成记录'}}
  ]})),budget:createTaskBudget({profile:'induction'})});
  assert.deepEqual(ok.candidate.parameterSlots,['month']);
  assert.equal(ok.candidate.trace.find(step=>step.tool==='select').value,'2026-10');
});

test('试运行失败回喂一次后重放成功；二次失败终止且不改配方',async()=>{
  const {demonstration}=fixture({failActOnce:true});
  let requests=0;const budgets=[];
  const result=await induceWorkflowRecipe({demonstration,goal:'保存为流程',
    requestModel:async()=>{requests++;return toolCall(validRecipe());},
    budget:createTaskBudget({profile:'induction'}),onCheckpoint:async cp=>budgets.push(cp)});
  assert.equal(requests,2);assert.equal(result.corrections,1);assert.equal(result.modelRequests,2);
  assert.ok(budgets.some(cp=>cp.stage==='feedback'&&cp.code==='BROWSER_OPERATION_FAILED'));
  assert.equal(result.candidate.verification.status,'verified');

  const persist=fixture();
  let alwaysFail=0;
  await assert.rejects(induceWorkflowRecipe({demonstration:{...persist.demonstration,browser:{...persist.demonstration.browser,act:async()=>{alwaysFail++;throw Object.assign(new Error('x'),{code:'BROWSER_OPERATION_FAILED'});}}},
    goal:'保存为流程',requestModel:async()=>{alwaysFail++;return toolCall(validRecipe());},budget:createTaskBudget({profile:'induction'})}),/INDUCTION_TRIAL_FAILED|AGENT_RESULT_UNVERIFIED|BROWSER_OPERATION_FAILED/);
});

test('凭据文本、非法示范与非归纳预算档在预算claim前拒绝',async()=>{
  const {demonstration}=fixture();
  await assert.rejects(induceWorkflowRecipe({demonstration,goal:'密码: 123456',requestModel:async()=>toolCall(validRecipe()),budget:createTaskBudget({profile:'induction'})}),/AGENT_INPUT_INVALID/);
  await assert.rejects(induceWorkflowRecipe({demonstration:{...demonstration,mode:'unknown'},goal:'保存为流程',requestModel:async()=>toolCall(validRecipe()),budget:createTaskBudget({profile:'induction'})}),/AGENT_INPUT_INVALID/);
  await assert.rejects(induceWorkflowRecipe({demonstration,goal:'保存为流程',requestModel:async()=>toolCall(validRecipe()),budget:createTaskBudget({profile:'induction',skill:true})}),/AGENT_BUDGET_EXHAUSTED/);
});
