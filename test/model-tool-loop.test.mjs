import test from 'node:test';import assert from 'node:assert/strict';import {runBrowserToolLoop} from '../src/model/tool-loop.mjs';
const call=(name,input)=>({tool_calls:[{id:'synthetic-call',type:'function',function:{name,arguments:JSON.stringify(input)}}]});
test('受控工具循环读取经同意的页面并形成结果，checkpoint不存页面内容',async()=>{let step=0,reads=0;const checkpoints=[];const result=await runBrowserToolLoop({task:'查看合成订单状态',allowedSiteIds:['site-mock'],consent:{taskText:true,pageContent:true},browser:{observe:async()=>{reads++;return {text:'合成订单已入库',elements:[]};}},checkContext:async()=>true,onCheckpoint:async value=>checkpoints.push(value),requestModel:async({messages})=>{step++;if(step===1)return call('browser_observe',{siteId:'site-mock'});assert.ok(messages.some(m=>m.role==='tool'&&m.content.includes('合成订单已入库')));return {content:'当前读取的合成订单已入库；未覆盖其他系统。'};}});assert.equal(result.status,'completed');assert.equal(reads,1);assert.ok(!JSON.stringify(checkpoints).includes('合成订单已入库'));});
test('没有页面外发同意、越站点和任意代码工具在执行前拒绝',async()=>{let reads=0;const base={task:'合成任务',allowedSiteIds:['site-mock'],consent:{taskText:true,pageContent:false},checkContext:async()=>true,browser:{observe:async()=>{reads++;}}};await assert.rejects(runBrowserToolLoop({...base,requestModel:async()=>call('browser_observe',{siteId:'site-mock'})}),/PAGE_CONTENT_CONSENT_REQUIRED/);await assert.rejects(runBrowserToolLoop({...base,requestModel:async()=>call('shell_exec',{siteId:'site-mock',code:'evil'})}),/AGENT_TOOL_REJECTED/);await assert.rejects(runBrowserToolLoop({...base,requestModel:async()=>call('browser_open',{siteId:'site-other'})}),/AGENT_TOOL_REJECTED/);assert.equal(reads,0);});
test('MFA需要用户接管、步骤上限和迟到撤权都不会伪造完成',async()=>{let handoff=0;const base={task:'合成任务',allowedSiteIds:['site-mock'],consent:{taskText:true,pageContent:true},checkContext:async()=>true,browser:{handoff:async()=>{handoff++;},open:async()=>({status:'opened'})}};const result=await runBrowserToolLoop({...base,requestModel:async()=>call('browser_handoff',{siteId:'site-mock'})});assert.equal(result.status,'awaiting_user');assert.equal(handoff,1);assert.equal((await runBrowserToolLoop({...base,maxSteps:2,requestModel:async()=>call('browser_open',{siteId:'site-mock'})})).status,'step_limit');let current=true;await assert.rejects(runBrowserToolLoop({...base,checkContext:async()=>current,requestModel:async()=>{current=false;return {content:'迟到的成功'};}}),/AGENT_CONTEXT_CHANGED/);});
test('模型长时间无响应受总预算约束，不会无限等待或继续工具动作',async()=>{await assert.rejects(runBrowserToolLoop({task:'合成任务',allowedSiteIds:['site-mock'],consent:{taskText:true,pageContent:true},checkContext:async()=>true,browser:{},requestModel:async()=>new Promise(()=>{}),timeoutMs:100}),/AGENT_TIMEOUT/);});

test('兼容思考工具轮次保留提供方上下文但不写checkpoint，null工具列表正常收尾',async()=>{
  const checkpoints=[];let count=0;
  const reasoning='synthetic-opaque-reasoning';
  const result=await runBrowserToolLoop({task:'查看合成记录',allowedSiteIds:['site-mock'],consent:{taskText:true,pageContent:true},browser:{observe:async()=>({text:'合成记录',elements:[]})},checkContext:async()=>true,onCheckpoint:async value=>checkpoints.push(value),requestModel:async({messages})=>{
    if(count++===0)return {...call('browser_observe',{siteId:'site-mock'}),reasoning_content:reasoning,content:'读取所选站点。'};
    const assistant=messages.find(message=>message.role==='assistant');assert.equal(assistant.reasoning_content,reasoning);assert.equal(assistant.content,'读取所选站点。');
    return {content:'已读取当前记录。',tool_calls:null};
  }});
  assert.equal(result.status,'completed');assert.ok(!JSON.stringify(checkpoints).includes(reasoning));assert.ok(!JSON.stringify(result).includes(reasoning));
});

test('筛选或重新导航后必须重新读取才能完成，不沿用先前页面的结果',async()=>{
  for(const operation of ['browser_open','browser_act']){
    let count=0;
    const input={siteId:'site-mock',...(operation==='browser_act'?{action:{type:'click',ref:'r-00000000-0000-0000-0000-000000000000-1'}}:{})};
    const browser={observe:async()=>({text:'筛选前记录',elements:[]}),open:async()=>({mode:'automatic'}),act:async()=>({status:'acted'})};
    await assert.rejects(runBrowserToolLoop({task:'读取筛选后的合成记录',allowedSiteIds:['site-mock'],consent:{taskText:true,pageContent:true},browser,checkContext:async()=>true,requestModel:async()=>++count===1?call('browser_observe',{siteId:'site-mock'}):count===2?call(operation,input):{content:'不能沿用旧结果。'}}),/AGENT_RESULT_UNVERIFIED/);
  }
});

test('畸形工具列表及无效工具结果明确拒绝，不绕过读取证明或伪造完成',async()=>{
  const base={task:'合成任务',allowedSiteIds:['site-mock'],consent:{taskText:true,pageContent:true},checkContext:async()=>true,browser:{observe:async()=>({text:'合成记录',elements:[]})}};
  for(const tool_calls of [{},'not-an-array'])await assert.rejects(runBrowserToolLoop({...base,requestModel:async()=>({content:'未经读取',tool_calls})}),/AGENT_MODEL_RESPONSE_INVALID/);
  await assert.rejects(runBrowserToolLoop({...base,browser:{observe:async()=>undefined},requestModel:async()=>call('browser_observe',{siteId:'site-mock'})}),/AGENT_TOOL_OUTPUT_INVALID/);
});
