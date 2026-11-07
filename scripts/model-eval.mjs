import {readFile,realpath,lstat} from 'node:fs/promises';
import {dirname,isAbsolute,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {proposeModelPlan} from '../src/model/gateway.mjs';
import {runPlanningEvaluation,validatePlanningCases} from '../src/model/evaluation.mjs';

const ROOT=resolve(fileURLToPath(new URL('..',import.meta.url)));
const CASE_FILE=new URL('../src/model/planning-cases.json',import.meta.url);
const fail=code=>Object.assign(new Error(code),{code});
const inside=(base,file)=>{const offset=relative(base,file);return !offset||!isAbsolute(offset)&&offset!=='..'&&!offset.startsWith('..'+sep);};
function argumentsFor(args){
  const parsed={mode:'offline'};const seen=new Set();
  for(let index=0;index<args.length;index++){
    const option=args[index];if(seen.has(option))throw fail('EVAL_ARGUMENT_INVALID');seen.add(option);
    if(option==='--offline'){if(seen.has('--live'))throw fail('EVAL_ARGUMENT_INVALID');parsed.mode='offline';}
    else if(option==='--live'){if(seen.has('--offline'))throw fail('EVAL_ARGUMENT_INVALID');parsed.mode='live';}
    else if(option==='--allow-paid')parsed.allowPaid=true;
    else if(option==='--config'||option==='--max-requests'){
      const value=args[++index];if(typeof value!=='string'||!value||value.startsWith('--'))throw fail('EVAL_ARGUMENT_INVALID');
      if(option==='--config')parsed.config=value;
      else{if(!/^[1-9]\d{0,2}$/.test(value))throw fail('EVAL_BUDGET_INVALID');parsed.maxRequests=Number(value);}
    }else throw fail('EVAL_ARGUMENT_INVALID');
  }
  if(parsed.mode==='offline'&&(parsed.allowPaid||parsed.config!==undefined||parsed.maxRequests!==undefined))throw fail('EVAL_OFFLINE_ARGUMENT_INVALID');
  if(parsed.mode==='live'&&!parsed.allowPaid)throw fail('EVAL_LIVE_APPROVAL_REQUIRED');
  if(parsed.mode==='live'&&(!parsed.config||!isAbsolute(parsed.config)||inside(ROOT,resolve(parsed.config))))throw fail('EVAL_CONFIG_PATH_INVALID');
  return parsed;
}

/** Explicit developer CLI. Offline reads public cases only; it does not inspect config, keys or providers. */
export async function runModelEvaluationCLI(args,{gateway=proposeModelPlan,fetchImpl=fetch,signal}={}){
  const options=argumentsFor(args);
  let suite;try{suite=validatePlanningCases(JSON.parse(await readFile(CASE_FILE,'utf8')));}catch{throw fail('EVAL_SUITE_INVALID');}
  if(options.mode==='live'&&(!Number.isSafeInteger(options.maxRequests)||options.maxRequests<1||options.maxRequests>suite.cases.length))throw fail('EVAL_BUDGET_INVALID');
  if(options.mode==='live'){
    try{const target=await realpath(options.config),info=await lstat(options.config);if(inside(ROOT,target)||!info.isFile()||info.isSymbolicLink()||info.size>16384)throw fail('EVAL_CONFIG_PATH_INVALID');}
    catch{throw fail('EVAL_CONFIG_PATH_INVALID');}
  }
  let networkRequests=0;
  const report=await runPlanningEvaluation({suite,mode:options.mode,allowPaid:options.allowPaid??false,maxRequests:options.maxRequests,signal,
    requestPlan:async({task,month,signal:requestSignal})=>gateway({file:options.config,text:task,month,consent:true,signal:requestSignal,fetchImpl:async(...parameters)=>{networkRequests++;return fetchImpl(...parameters);}})
  });
  return {...report,networkRequests};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const abort=new AbortController(),cancel=()=>abort.abort();process.once('SIGINT',cancel);
  try{process.stdout.write(JSON.stringify(await runModelEvaluationCLI(process.argv.slice(2),{signal:abort.signal}),null,2)+'\n');}
  catch(error){const code=/^EVAL_[A-Z_]+$/.test(error?.code??'')?error.code:'EVAL_OPERATION_FAILED';process.stderr.write(code+'\n用法：node scripts/model-eval.mjs --offline\n真实评测：node scripts/model-eval.mjs --live --allow-paid --config <仓库外绝对配置路径> --max-requests <题目数上限>\n');process.exitCode=1;}
  finally{process.removeListener('SIGINT',cancel);}
}
