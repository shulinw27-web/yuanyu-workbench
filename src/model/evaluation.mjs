const fail=code=>Object.assign(new Error(code),{code});
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const closed=(value,keys)=>plain(value)&&Object.keys(value).every(key=>keys.includes(key));
const month=value=>typeof value==='string'&&/^2026-(09|10)$/.test(value);
const identifier=value=>typeof value==='string'&&/^[a-z][a-z0-9-]{2,49}$/.test(value);
const SAFE_ERRORS=new Set(['MODEL_NOT_CONFIGURED','MODEL_CONFIG_INVALID','MODEL_CONFIG_CHANGED','MODEL_DISABLED','MODEL_KEY_UNAVAILABLE','MODEL_AUTH_REJECTED','MODEL_PAYMENT_REQUIRED','MODEL_RATE_LIMITED','MODEL_TIMEOUT','MODEL_UNAVAILABLE','MODEL_PROVIDER_FAILED','MODEL_PLAN_INVALID','MODEL_RESPONSE_INVALID','MODEL_RESPONSE_TOO_LARGE','MODEL_INPUT_INVALID','MODEL_CONSENT_REQUIRED','SENSITIVE_TASK_TEXT','CANCELLED']);
const STOP_ERRORS=new Set(['MODEL_NOT_CONFIGURED','MODEL_CONFIG_INVALID','MODEL_CONFIG_CHANGED','MODEL_DISABLED','MODEL_KEY_UNAVAILABLE','MODEL_AUTH_REJECTED','MODEL_PAYMENT_REQUIRED','MODEL_RATE_LIMITED','MODEL_TIMEOUT','MODEL_UNAVAILABLE','MODEL_PROVIDER_FAILED','CANCELLED']);

/** Public fixed-recipe cases. Expected outcomes stay in the evaluator and never enter model input. */
export function validatePlanningCases(input){
  if(!closed(input,['schemaVersion','scope','cases'])||input.schemaVersion!==1||input.scope!=='purchase_plan'||!Array.isArray(input.cases)||input.cases.length<1||input.cases.length>50)throw fail('EVAL_SUITE_INVALID');
  const ids=new Set();
  for(const item of input.cases){
    if(!closed(item,['id','input','expected'])||!identifier(item.id)||ids.has(item.id)||!closed(item.input,['task','month'])||typeof item.input.task!=='string'||!item.input.task.trim()||item.input.task.length>2000||/[\u0000-\u001f\u007f]/.test(item.input.task)||!month(item.input.month)||!closed(item.expected,['decision','recipeId','month'])||!['supported','clarify','unsupported'].includes(item.expected.decision)||item.expected.month!==item.input.month)throw fail('EVAL_SUITE_INVALID');
    if(item.expected.decision==='supported'&&item.expected.recipeId!=='purchase-monthly'||item.expected.decision==='unsupported'&&item.expected.recipeId!==null||item.expected.recipeId!==undefined&&![null,'purchase-monthly'].includes(item.expected.recipeId))throw fail('EVAL_SUITE_INVALID');
    ids.add(item.id);
  }
  return structuredClone(input);
}

export function scorePlanningResult(item,result){
  const valid=plain(result)&&typeof result.supported==='boolean'&&[null,'purchase-monthly'].includes(result.recipeId)&&month(result.month)&&Array.isArray(result.questions)&&result.questions.length<=3&&result.questions.every(question=>typeof question==='string'&&question.trim().length>0&&question.length<=300);
  const checks={format:valid,month:valid&&result.month===item.expected.month,decision:false,recipe:false,clarification:false};
  if(valid){
    checks.decision=item.expected.decision==='supported'?result.supported:!result.supported;
    checks.recipe=item.expected.recipeId===undefined||result.recipeId===item.expected.recipeId;
    checks.clarification=item.expected.decision!=='clarify'||result.questions.length>0;
  }
  return {passed:Object.values(checks).every(Boolean),checks};
}

/** No intrinsic I/O: offline never invokes requestPlan; live receives only task/month/signal. */
export async function runPlanningEvaluation({suite,mode='offline',allowPaid=false,maxRequests,requestPlan,signal}={}){
  const validated=validatePlanningCases(suite);
  if(!['offline','live'].includes(mode))throw fail('EVAL_MODE_INVALID');
  if(mode==='live'&&allowPaid!==true)throw fail('EVAL_LIVE_APPROVAL_REQUIRED');
  if(mode==='live'&&(!Number.isSafeInteger(maxRequests)||maxRequests<1||maxRequests>validated.cases.length))throw fail('EVAL_BUDGET_INVALID');
  if(mode==='live'&&typeof requestPlan!=='function')throw fail('EVAL_GATEWAY_REQUIRED');
  if(mode==='offline'&&(allowPaid!==false||maxRequests!==undefined))throw fail('EVAL_OFFLINE_ARGUMENT_INVALID');
  const results=validated.cases.map(item=>({id:item.id,status:'not_run'}));
  let attempted=0,stopReason;
  if(mode==='live')for(let index=0;index<maxRequests;index++){
    if(signal?.aborted){stopReason='CANCELLED';break;}
    const item=validated.cases[index];attempted++;
    try{
      const value=await requestPlan({task:item.input.task,month:item.input.month,...(signal?{signal}:{})});
      if(signal?.aborted)throw fail('CANCELLED');
      const score=scorePlanningResult(item,value);
      results[index]={id:item.id,status:score.passed?'passed':'failed',checks:score.checks};
    }catch(error){
      const code=SAFE_ERRORS.has(error?.code)?error.code:'MODEL_EVALUATION_FAILED';
      results[index]={id:item.id,status:'error',errorCode:code};
      if(STOP_ERRORS.has(code)||code==='MODEL_EVALUATION_FAILED'){stopReason=code;break;}
    }
  }
  const passed=results.filter(item=>item.status==='passed').length,failed=results.filter(item=>item.status==='failed').length,errors=results.filter(item=>item.status==='error').length,scored=passed+failed;
  return {
    schemaVersion:1,scope:'purchase_plan_only',mode,status:mode==='offline'?'not_run':stopReason?'stopped':attempted<results.length?'partial':errors?'completed_with_errors':'completed',
    limits:{maxRequests:mode==='live'?maxRequests:0,attemptsPerCase:1},
    summary:{total:results.length,requestsAttempted:attempted,scored,passed,failed,errors,notRun:results.length-attempted,scorePercent:scored?Math.round(passed/scored*10000)/100:null,coveragePercent:Math.round(scored/results.length*10000)/100},
    ...(stopReason?{stopReason}:{}),limitations:['NO_BROWSER_EXECUTION','NOT_GENERAL_BUSINESS_ACCEPTANCE','OFFLINE_IS_NOT_MODEL_VALIDATION'],results
  };
}
