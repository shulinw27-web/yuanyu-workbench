// Classification is advisory only. The trusted runtime still owns budgets, authorization and effects.
const STOPPED=new Set([
  'CANCELLED','AGENT_TIMEOUT','AGENT_CONTEXT_CHANGED','AGENT_BINDINGS_CHANGED','MODEL_CONFIG_CHANGED',
  'MODEL_AUTH_REJECTED','MODEL_PAYMENT_REQUIRED','MODEL_RATE_LIMITED','MODEL_TIMEOUT','MODEL_UNAVAILABLE',
  'WRITE_CONFIRM_REQUIRED','AGENT_BUDGET_EXHAUSTED','AGENT_CONTEXT_BUDGET_EXHAUSTED','AGENT_MODEL_BUDGET_EXCEEDED',
  'AGENT_CONTEXT_TOO_LARGE','AGENT_RESULT_UNVERIFIED','AGENT_TOOL_OUTPUT_INVALID','AGENT_TOOL_OUTPUT_TOO_LARGE',
  'AGENT_TOOL_BUSY','AGENT_TRACE_LIMIT','PAGE_STRUCTURE_CHANGED','PAGE_CONTENT_CONSENT_REQUIRED','AGENT_CORRECTION_NO_CHANGE'
]);
const STOPPED_PREFIX=/^(?:PROVIDER_|MONTHLY_|DAILY_|PROMOTION_|CREDENTIAL_|ORIGIN_|SITE_|WRITE_)/;
const HANDOFF=new Set(['LOGIN_REQUIRED','MANUAL_HANDOFF_ACTIVE']);
const REPAIRABLE=new Set(['STALE_REFERENCE','INVALID_BROWSER_ACTION','AGENT_TOOL_INPUT_INVALID']);

/** One task may repair one proven no-effect error. Anything uncertain or permission-related stops. */
export function classifyRecovery({code,effectState='may_have_occurred',correctionsUsed=0}){
  const safe=typeof code==='string'?code:'';
  if(STOPPED.has(safe)||STOPPED_PREFIX.test(safe))return {action:'stop',retry:false,reason:'stopped'};
  if(HANDOFF.has(safe))return {action:'handoff',retry:false,reason:'handoff'};
  if(!Number.isSafeInteger(correctionsUsed)||correctionsUsed<0)return {action:'stop',retry:false,reason:'budget'};
  if(correctionsUsed===0&&effectState==='not_started'&&REPAIRABLE.has(safe))return {action:'repair_once',retry:true,reason:'not_started'};
  return {action:'stop',retry:false,reason:'not_repairable'};
}
