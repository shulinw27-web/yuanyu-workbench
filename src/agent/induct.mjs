import {matchesToolSchema} from '../tools/registry.mjs';
import {verifyTaskResult} from './verifier.mjs';
import {replayRecipe} from './runtime.mjs';
import {claimTaskBudget} from './budget.mjs';
import {validateAgentTrace} from './store.mjs';

const fail=code=>Object.assign(new Error(code),{code});
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const SECRET_TEXT=/(?:\b(?:password|passwd|secret|(?:access[_-]?|refresh[_-]?)?token|authorization|cookie|api[_-]?key|otp|mfa[_ -]?code)\s*[:=]|(?:密码|口令|验证码|访问令牌)\s*[:：=]|\bBearer\s+[a-zA-Z0-9._~-]+|\beyJ[a-zA-Z0-9_-]{12,}\.[a-zA-Z0-9_-]+\.|<\/?(?:html|body|script)\b|<!doctype)/i;
const SLOT=/^\{\{([a-z][a-z0-9_]{0,31})\}\}$/;
const ROLES={click:['button','link'],fill:['textbox'],select:['combobox']};
const roleOf=element=>({input:'textbox',textarea:'textbox',select:'combobox',a:'link',button:'button'}[element.tag]||element.role);

// Closed tool schema the induction model must call. Kept as data so the same object drives
// prompt disclosure, output validation and tests. Free prose is never accepted as a recipe.
const actionClick={type:'object',additionalProperties:false,properties:{type:{type:'string',enum:['click']},role:{type:'string',enum:['button','link']},name:{type:'string',minLength:1,maxLength:120}},required:['type','role','name']};
const actionField={type:'object',additionalProperties:false,properties:{type:{type:'string',enum:['fill','select']},role:{type:'string',enum:['textbox','combobox']},name:{type:'string',minLength:1,maxLength:120},value:{type:'string',minLength:0,maxLength:200}},required:['type','role','name','value']};
export const PROPOSE_RECIPE_TOOL={type:'function',function:{name:'propose_recipe',description:'Return exactly one propose_recipe tool call with a data recipe built only from demonstrated read-only steps. No prose, no code, no credentials.',parameters:{type:'object',additionalProperties:false,
  properties:{name:{type:'string',minLength:1,maxLength:80},description:{type:'string',maxLength:300},steps:{type:'array',maxItems:30,items:{type:'object',additionalProperties:false,
    properties:{siteId:{type:'string',minLength:1,maxLength:80},action:{anyOf:[actionClick,actionField]},parameterSlots:{type:'array',maxItems:3,items:{type:'object',additionalProperties:false,properties:{name:{type:'string',minLength:1,maxLength:40}},required:['name']}}},
    required:['siteId','action']}}},required:['name','steps']}}};
const RECIPE_SCHEMA=PROPOSE_RECIPE_TOOL.function.parameters;

const SYSTEM_PROMPT=`You induct a reusable data recipe from a completed, trusted demonstration. The demonstration trace contains only read-only browser steps with site ids and accessible control names; it has no page body, credentials or secrets. Return exactly one propose_recipe tool call. steps must each use a demonstrated siteId and an action whose role/name was demonstrated at that site; click actions have no value, fill/select actions carry a value that is either a demonstrated value or a {{slot}} reference declared in that step's parameterSlots (at most 3 slots total). The recipe is data only: no code, shell, network, credentials, writes, approvals or payments. Any request to learn arbitrary gestures or business rules is out of scope.`;

function normalizeUsage(value){
  if(!plain(value))return null;
  const count=v=>v===null||v===undefined?null:Number.isSafeInteger(v)&&v>=0?v:null;
  const out={promptTokens:count(value.promptTokens),completionTokens:count(value.completionTokens),cachedTokens:count(value.cachedTokens)};
  return Object.values(out).every(v=>v===null)?null:out;
}

/** Fatal codes stop induction immediately; other replay/verify failures earn one correction feedback. */
const FATAL=new Set(['CANCELLED','AGENT_TIMEOUT','AGENT_CONTEXT_CHANGED','AGENT_BINDINGS_CHANGED','AGENT_BUDGET_EXHAUSTED','AGENT_CONTEXT_BUDGET_EXHAUSTED','AGENT_MODEL_BUDGET_EXCEEDED','MODEL_CONFIG_CHANGED','MODEL_AUTH_REJECTED','MODEL_PAYMENT_REQUIRED','MODEL_RATE_LIMITED','MODEL_TIMEOUT','MODEL_UNAVAILABLE','SENSITIVE_TASK_TEXT','INDUCTION_OUTPUT_INVALID','INDUCTION_TRIAL_FAILED']);

function demoIndex(trace){
  const sites=new Set(),actions=new Map(),values=new Map();
  for(const entry of trace){
    sites.add(entry.siteId);
    if(!entry.locator)continue;
    const key=`${entry.siteId}\u0000${entry.locator.role}\u0000${entry.locator.name}`;
    if(!actions.has(entry.siteId))actions.set(entry.siteId,new Set());
    actions.get(entry.siteId).add(`${entry.locator.role}\u0000${entry.locator.name}`);
    if(entry.value!==undefined){if(!values.has(key))values.set(key,new Set());values.get(key).add(entry.value);}
  }
  return {sites,actions,values};
}

/** Deterministic validation: every step must be grounded in the demonstrated trace. */
function validateCandidate(recipe,index){
  if(!matchesToolSchema(recipe,RECIPE_SCHEMA)||!Array.isArray(recipe.steps)||recipe.steps.length<1)throw fail('INDUCTION_OUTPUT_INVALID');
  const slots=new Set(),resolved=[];
  let slotCount=0;
  for(const step of recipe.steps){
    const {siteId,action}=step;
    if(!index.sites.has(siteId)||!index.actions.get(siteId)?.has(`${action.role}\u0000${action.name}`))throw fail('INDUCTION_OUTPUT_INVALID');
    if(!ROLES[action.type]?.includes(action.role))throw fail('INDUCTION_OUTPUT_INVALID');
    const declared=step.parameterSlots??[];
    for(const slot of declared){if(slots.has(slot.name))throw fail('INDUCTION_OUTPUT_INVALID');slots.add(slot.name);if(++slotCount>3)throw fail('INDUCTION_OUTPUT_INVALID');}
    const key=`${siteId}\u0000${action.role}\u0000${action.name}`;
    let value=action.value;
    if(action.type!=='click'){
      const match=typeof value==='string'?SLOT.exec(value):null;
      if(match){
        if(!declared.some(slot=>slot.name===match[1]))throw fail('INDUCTION_OUTPUT_INVALID');
        const demonstrated=index.values.get(key);
        if(!demonstrated||!demonstrated.size)throw fail('INDUCTION_OUTPUT_INVALID');
        value=[...demonstrated][0];
      }else if(!index.values.get(key)?.has(value))throw fail('INDUCTION_OUTPUT_INVALID');
    }else value=undefined;
    resolved.push({tool:action.type,siteId,locator:{role:action.role,name:action.name,readOnly:true},...(value!==undefined?{value}:{})});
  }
  // A standalone replayable recipe must open each site before acting on it; open steps are derived, never model-authored.
  const opened=new Set(),withOpen=[];
  for(const entry of resolved){if(!opened.has(entry.siteId)){opened.add(entry.siteId);withOpen.push({tool:'open',siteId:entry.siteId});}withOpen.push(entry);}
  return {recipe:withOpen,slots:[...slots],slotCount,siteIds:[...opened]};
}

/**
 * Induce a data recipe from a trusted demonstration trace.
 * `demonstration` = {trace, siteBindings, mode, browser, check, getCorrectionsUsed?, onRepair?}.
 * No page body or credentials ever enter the model request or the returned recipe.
 */
export async function induceWorkflowRecipe({demonstration,goal,requestModel,budget,onCheckpoint=async()=>{},signal}={}){
  const guard=()=>{if(signal?.aborted)throw fail('CANCELLED');};
  const checkpoint=async event=>{guard();if(typeof onCheckpoint==='function')await onCheckpoint(event);guard();};
  guard();
  if(!plain(demonstration)||typeof goal!=='string'||!goal.trim()||goal.length>2000||SECRET_TEXT.test(goal))throw fail('AGENT_INPUT_INVALID');
  if(typeof requestModel!=='function')throw fail('AGENT_INPUT_INVALID');
  const {trace,siteBindings,mode,browser,check}=demonstration;
  const safeTrace=validateAgentTrace(trace,siteBindings);
  const siteIds=[...new Set(safeTrace.map(entry=>entry.siteId))];
  if(!siteIds.length||!['mock_browser','compatible_browser'].includes(mode)||!plain(browser)||typeof check!=='function')throw fail('AGENT_INPUT_INVALID');
  const index=demoIndex(safeTrace);
  let workingBudget=budget;
  const usageTotals={promptTokens:0,completionTokens:0,cachedTokens:0};let usageReports=0;
  const reportUsage=usage=>{const parsed=normalizeUsage(usage);if(!parsed)return;usageReports++;for(const key of Object.keys(usageTotals))if(parsed[key]!==null)usageTotals[key]+=parsed[key];};
  const usageSummary=()=>usageReports?{promptTokens:usageTotals.promptTokens,completionTokens:usageTotals.completionTokens,cachedTokens:usageTotals.cachedTokens}:null;

  const request=async messages=>{
    guard();
    const bytes=Buffer.byteLength(JSON.stringify(messages),'utf8');
    workingBudget=claimTaskBudget(workingBudget,{kind:'model',inputBytes:bytes});
    await checkpoint({stage:'induction_request',status:'executing'});
    const raw=await requestModel({messages:structuredClone(messages),tools:[PROPOSE_RECIPE_TOOL],signal});
    guard();
    const message=plain(raw)&&Object.hasOwn(raw,'message')?raw.message:raw;
    if(plain(raw)&&Object.hasOwn(raw,'usage'))reportUsage(raw.usage);
    if(!plain(message)||!Array.isArray(message.tool_calls)||message.tool_calls.length!==1)throw fail('INDUCTION_OUTPUT_INVALID');
    const call=message.tool_calls[0];
    if(call?.function?.name!=='propose_recipe'||typeof call.function.arguments!=='string'||Buffer.byteLength(call.function.arguments,'utf8')>8000)throw fail('INDUCTION_OUTPUT_INVALID');
    let candidate;try{candidate=JSON.parse(call.function.arguments);}catch{throw fail('INDUCTION_OUTPUT_INVALID');}
    await checkpoint({stage:'induction_request',status:'completed'});
    return candidate;
  };

  const trial=async (recipe,requiredSiteIds)=>{
    guard();
    await checkpoint({stage:'trial',status:'executing'});
    const observations=new Map(),dirty=new Set();
    const wrapped={
      open:async id=>{guard();await check();const result=await browser.open(id);guard();observations.delete(id);dirty.add(id);return result;},
      observe:async id=>{guard();await check();const result=await browser.observe(id);guard();observations.set(id,result);if(result?.text?.trim()&&!result.elements?.some(element=>element.credential))dirty.delete(id);return result;},
      handoff:async id=>{guard();return browser.handoff(id);},
      act:async(id,action)=>{guard();const page=observations.get(id);const element=page?.elements.find(item=>item.ref===action.ref);if(!element||element.credential)throw Object.assign(fail('STALE_REFERENCE'),{effectState:'not_started'});const entry={tool:action.type,siteId:id,locator:{role:roleOf(element),name:element.label,readOnly:true},...(action.value!==undefined?{value:action.value}:{})};validateAgentTrace([entry],siteBindings);const result=await browser.act(id,action);guard();observations.delete(id);dirty.add(id);return result;}
    };
    const result=await replayRecipe({recipe,browser:wrapped,check,signal,
      getCorrectionsUsed:async()=>typeof demonstration.getCorrectionsUsed==='function'?await demonstration.getCorrectionsUsed():0,
      onRepair:async()=>{if(typeof demonstration.onRepair==='function')await demonstration.onRepair();}});
    guard();
    const context={requiredSiteIds,parameters:{}};
    const verification=verifyTaskResult({mode,context,observations,dirtySiteIds:[...dirty]});
    await checkpoint({stage:'trial',status:'completed',verification:verification.status});
    if(verification.status==='rejected'){const error=fail(verification.code);throw error;}
    return {replay:result,verification};
  };

  const messages=[
    {role:'system',content:SYSTEM_PROMPT},
    {role:'user',content:JSON.stringify({goal,trace:safeTrace,siteIds})}
  ];
  let candidate=await request(messages),validated=validateCandidate(candidate,index),outcome;
  try{
    outcome=await trial(validated.recipe,validated.siteIds);
  }catch(error){
    const code=typeof error?.code==='string'?error.code:'INDUCTION_TRIAL_FAILED';
    if(FATAL.has(code))throw fail(code==='AGENT_RESULT_UNVERIFIED'?'AGENT_RESULT_UNVERIFIED':code);
    await checkpoint({stage:'trial',status:'failed',code});
    workingBudget=claimTaskBudget(workingBudget,{kind:'correction'});
    await checkpoint({stage:'feedback',status:'executing',code});
    messages.push({role:'user',content:JSON.stringify({type:'induction_trial_feedback',code,instruction:'The previous recipe failed the deterministic trial. Return exactly one propose_recipe tool call corrected to demonstrated sites, roles and values.'})});
    candidate=await request(messages);validated=validateCandidate(candidate,index);
    try{outcome=await trial(validated.recipe,validated.siteIds);}
    catch(second){throw fail(second?.code==='AGENT_RESULT_UNVERIFIED'?'AGENT_RESULT_UNVERIFIED':'INDUCTION_TRIAL_FAILED');}
  }
  guard();
  const recipe={schemaVersion:1,kind:'browser',name:candidate.name,description:candidate.description??'',goal,siteBindings,mode,trace:validated.recipe,parameterSlots:validated.slots,verification:outcome.verification,replay:outcome.replay.status};
  await checkpoint({stage:'complete',status:'awaiting_confirmation',steps:validated.recipe.length});
  return {status:'awaiting_confirmation',candidate:recipe,usage:usageSummary(),budgetUsed:workingBudget.used,modelRequests:workingBudget.used.modelRequests,corrections:workingBudget.used.corrections};
}

export const INDUCTION_FATAL_CODES=FATAL;
