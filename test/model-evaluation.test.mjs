import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {validatePlanningCases,scorePlanningResult,runPlanningEvaluation} from '../src/model/evaluation.mjs';
import {runModelEvaluationCLI} from '../scripts/model-eval.mjs';

const suite=JSON.parse(await readFile(new URL('../src/model/planning-cases.json',import.meta.url),'utf8'));
const plan=(extra={})=>({supported:true,recipeId:'purchase-monthly',month:'2026-10',questions:[],message:'只提出计划，不执行操作',...extra});
const error=code=>Object.assign(new Error('synthetic-sensitive-provider-body'),{code});
async function configFixture(t){
  const dir=await mkdtemp(join(tmpdir(),'yuanyu-model-evaluation-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'model.local.json'),apiKeyFile=join(dir,'synthetic-key.txt');
  await writeFile(apiKeyFile,'synthetic-evaluation-key-value');
  await writeFile(file,JSON.stringify({schemaVersion:1,enabled:true,baseUrl:'https://synthetic-model.example.invalid/v1',model:'synthetic-planning-model',apiKeyFile,dataScope:'task_text'}));
  return {file,dir};
}
const live=(file,count)=>['--live','--allow-paid','--config',file,'--max-requests',String(count)];

test('固定规划题库覆盖月份、冲突、含混和禁写，闭合结构拒绝注入和重复编号',()=>{
  const value=validatePlanningCases(suite);assert.equal(value.cases.length,14);
  for(const id of ['purchase-october','month-conflict','ambiguous-report','payment-prohibited','approval-prohibited','business-write-prohibited','prompt-injection'])assert.ok(value.cases.some(item=>item.id===id));
  for(const mutate of [
    value=>{value.cases[0].expected.decision='execute';},
    value=>{value.cases[1].id=value.cases[0].id;},
    value=>{value.cases[0].input.apiKey='synthetic';},
    value=>{value.cases[0].expected.month='2026-09';},
    value=>{value.cases[0].input.month='2026-11';},
    value=>{value.cases[0].expected.recipeId='shell.exec';}
  ]){const changed=structuredClone(suite);mutate(changed);assert.throws(()=>validatePlanningCases(changed),/EVAL_SUITE_INVALID/);}
  value.cases[0].input.task='changed';assert.notEqual(suite.cases[0].input.task,'changed');
});

test('评分独立检查不安全的接受、错误月份及澄清问题，原回复不进入结果',()=>{
  const byId=id=>suite.cases.find(item=>item.id===id);
  assert.equal(scorePlanningResult(byId('purchase-october'),plan()).passed,true);
  assert.equal(scorePlanningResult(byId('purchase-october'),plan({month:'2026-09'})).passed,false);
  assert.equal(scorePlanningResult(byId('payment-prohibited'),plan()).passed,false);
  assert.equal(scorePlanningResult(byId('payment-prohibited'),plan({supported:false,recipeId:null})).passed,true);
  assert.equal(scorePlanningResult(byId('month-conflict'),plan({supported:false})).passed,false);
  const result=scorePlanningResult(byId('month-conflict'),plan({supported:false,questions:['确认要处理哪个月份？'],message:'synthetic-sensitive-answer'}));
  assert.equal(result.passed,true);assert.ok(!JSON.stringify(result).includes('synthetic-sensitive-answer'));
  assert.equal(scorePlanningResult(byId('ambiguous-report'),null).passed,false);
});

test('默认离线只校验题库，全部not_run且无模型分数，不调用网关或网络',async()=>{
  let calls=0;const never=async()=>{calls++;throw Error('never');};
  const pure=await runPlanningEvaluation({suite,requestPlan:never});
  const cli=await runModelEvaluationCLI([],{gateway:never,fetchImpl:never});
  assert.equal(calls,0);assert.equal(pure.status,'not_run');assert.equal(cli.networkRequests,0);
  assert.equal(cli.summary.requestsAttempted,0);assert.equal(cli.summary.scorePercent,null);assert.equal(cli.summary.notRun,suite.cases.length);
  assert.ok(cli.results.every(item=>item.status==='not_run'));
  assert.ok(!JSON.stringify(cli).includes(suite.cases[0].input.task));
});

test('真实入口需要逐次明确批准、仓库外配置和请求上限，错误参数在网关前拒绝',async t=>{
  const {file}=await configFixture(t);let calls=0;const gateway=async()=>{calls++;return plan();};
  for(const args of [
    ['--live','--config',file,'--max-requests','1'],
    ['--offline','--allow-paid'],
    ['--offline','--config',file],
    ['--live','--allow-paid','--config',file],
    live(file,0),live(file,15),live(file,'1e1'),
    ['--offline','--live'],['--offline','--offline'],['--other'],
    live(fileURLToPath(new URL('../README.md',import.meta.url)),1)
  ])await assert.rejects(runModelEvaluationCLI(args,{gateway}),error=>/^EVAL_/.test(error.code));
  await assert.rejects(runPlanningEvaluation({suite,mode:'live',maxRequests:1,requestPlan:gateway}),/EVAL_LIVE_APPROVAL_REQUIRED/);
  assert.equal(calls,0);
});

test('每题最多一次且错误占预算，模型只得到task/month，不得到expected',async()=>{
  const inputs=[];
  const result=await runPlanningEvaluation({suite,mode:'live',allowPaid:true,maxRequests:2,requestPlan:async input=>{
    inputs.push(input);assert.deepEqual(Object.keys(input).sort(),['month','task']);
    if(inputs.length===1)throw error('MODEL_PLAN_INVALID');
    return plan({supported:false,recipeId:null});
  }});
  assert.equal(inputs.length,2);assert.equal(result.summary.requestsAttempted,2);assert.equal(result.summary.errors,1);assert.equal(result.summary.passed,1);assert.equal(result.summary.notRun,12);assert.equal(result.status,'partial');
  assert.ok(!JSON.stringify(result).includes('synthetic-sensitive-provider-body'));
});

test('身份、额度、限流、超时及未知上游错误立即停止，不自动重试',async t=>{
  for(const code of ['MODEL_AUTH_REJECTED','MODEL_PAYMENT_REQUIRED','MODEL_RATE_LIMITED','MODEL_TIMEOUT','MODEL_UNAVAILABLE','MODEL_CONFIG_CHANGED','UNTRUSTED_PRIVATE_CODE'])await t.test(code,async()=>{
    let calls=0;const result=await runPlanningEvaluation({suite,mode:'live',allowPaid:true,maxRequests:5,requestPlan:async()=>{calls++;throw error(code);}});
    assert.equal(calls,1);assert.equal(result.status,'stopped');assert.equal(result.summary.requestsAttempted,1);assert.equal(result.summary.notRun,13);assert.equal(result.summary.scorePercent,null);
    assert.equal(result.results[0].errorCode,code==='UNTRUSTED_PRIVATE_CODE'?'MODEL_EVALUATION_FAILED':code);
    assert.ok(!JSON.stringify(result).includes('synthetic-sensitive-provider-body'));
  });
});

test('live通过既有gateway接线，题库答案不发送且计数来自实际fetch调用',async t=>{
  const {file,dir}=await configFixture(t);let calls=0;
  const report=await runModelEvaluationCLI(live(file,3),{fetchImpl:async(_url,options)=>{
    const index=calls++,body=JSON.parse(options.body),input=JSON.parse(body.messages[1].content);
    assert.deepEqual(Object.keys(input).sort(),['selectedMonth','task']);assert.equal(input.task,suite.cases[index].input.task);
    assert.equal(body.tools[0].function.name,'propose_workflow_plan');assert.ok(!options.body.includes('expected'));assert.ok(!options.body.includes('synthetic-evaluation-key-value'));
    const expected=suite.cases[index].expected;
    const answer={recipeId:expected.decision==='supported'?'purchase-monthly':null,month:input.selectedMonth,explanation:'合成响应，仅用于评测器接线验证',needsClarification:expected.decision==='clarify',questions:expected.decision==='clarify'?['请确认目标月份？']:[]};
    return new Response(JSON.stringify({choices:[{message:{tool_calls:[{function:{name:'propose_workflow_plan',arguments:JSON.stringify(answer)}}]}}]}));
  }});
  assert.equal(calls,3);assert.equal(report.networkRequests,3);assert.equal(report.summary.requestsAttempted,3);assert.equal(report.summary.passed,3);assert.equal(report.status,'partial');
  const encoded=JSON.stringify(report);for(const hidden of [file,dir,'synthetic-evaluation-key-value','合成响应'])assert.ok(!encoded.includes(hidden));
});

test('网关配置失败也占尝试预算但不冒充发生网络调用，401后不跑后续题目',async t=>{
  const {file}=await configFixture(t);await writeFile(file,'{}');let calls=0;
  let report=await runModelEvaluationCLI(live(file,2),{fetchImpl:async()=>{calls++;throw Error('never');}});
  assert.equal(report.networkRequests,0);assert.equal(report.summary.requestsAttempted,1);assert.equal(report.stopReason,'MODEL_CONFIG_INVALID');assert.equal(calls,0);
  const second=await configFixture(t);
  report=await runModelEvaluationCLI(live(second.file,3),{fetchImpl:async()=>{calls++;return new Response('synthetic-sensitive-error',{status:401});}});
  assert.equal(calls,1);assert.equal(report.networkRequests,1);assert.equal(report.stopReason,'MODEL_AUTH_REJECTED');assert.equal(report.summary.notRun,13);assert.ok(!JSON.stringify(report).includes('synthetic-sensitive-error'));
});

test('取消不发起后续请求，未知回复和错误原文不进入报告',async()=>{
  const abort=new AbortController();let calls=0;
  const result=await runPlanningEvaluation({suite,mode:'live',allowPaid:true,maxRequests:4,signal:abort.signal,requestPlan:async()=>{calls++;abort.abort();return plan({message:'synthetic-private-message'});}});
  assert.equal(calls,1);assert.equal(result.stopReason,'CANCELLED');assert.equal(result.summary.scored,0);assert.ok(!JSON.stringify(result).includes('synthetic-private-message'));
  const before=new AbortController();before.abort();
  const empty=await runPlanningEvaluation({suite,mode:'live',allowPaid:true,maxRequests:4,signal:before.signal,requestPlan:async()=>{throw Error('never');}});
  assert.equal(empty.summary.requestsAttempted,0);assert.equal(empty.summary.notRun,14);
});

test('默认CLI输出安全JSON，明确离线未验收，未经批准的live只返回稳定错误码',()=>{
  const script=fileURLToPath(new URL('../scripts/model-eval.mjs',import.meta.url));
  const offline=spawnSync(process.execPath,[script],{encoding:'utf8'});assert.equal(offline.status,0,offline.stderr);
  const report=JSON.parse(offline.stdout);assert.equal(report.status,'not_run');assert.equal(report.networkRequests,0);assert.equal(report.summary.scorePercent,null);
  const blocked=spawnSync(process.execPath,[script,'--live'],{encoding:'utf8'});assert.equal(blocked.status,1);assert.match(blocked.stderr,/EVAL_LIVE_APPROVAL_REQUIRED/);assert.equal(blocked.stdout,'');
});
