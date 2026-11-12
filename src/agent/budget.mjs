import {randomUUID} from 'node:crypto';

const fail=code=>Object.assign(new Error(code),{code});
const keys=['modelRequests','rounds','tools','activeMs','corrections','reflections','estimatedInputTokens'];
const defaults={modelRequests:8,rounds:12,tools:100,activeMs:45000,corrections:1,reflections:1,estimatedInputTokens:48000};
const caps={modelRequests:12,rounds:12,tools:100,activeMs:45000,corrections:1,reflections:1,estimatedInputTokens:48000};
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const closed=(value,fields)=>{if(!plain(value)||Object.keys(value).some(key=>!fields.includes(key)))throw fail('AGENT_BUDGET_INVALID');};
export function validateTaskBudget(input){
  closed(input,['schemaVersion','limits','used','lease']);if(input.schemaVersion!==1)throw fail('AGENT_BUDGET_INVALID');
  for(const field of ['limits','used']){closed(input[field],keys);for(const key of keys){const value=input[field][key];if(!Number.isSafeInteger(value)||value<0||value>(field==='limits'?caps[key]:input.limits[key]))throw fail('AGENT_BUDGET_INVALID');}}
  for(const key of keys)if(key!=='modelRequests'&&input.limits[key]===0)throw fail('AGENT_BUDGET_INVALID');
  if(input.lease!==undefined){closed(input.lease,['id','reservedMs']);if(typeof input.lease.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(input.lease.id)||!Number.isSafeInteger(input.lease.reservedMs)||input.lease.reservedMs<1||input.used.activeMs+input.lease.reservedMs>input.limits.activeMs)throw fail('AGENT_BUDGET_INVALID');}
  return structuredClone(input);
}
export function createTaskBudget({maxModelRequests=8,skill=false}={}){
  if(!Number.isSafeInteger(maxModelRequests)||maxModelRequests<1||maxModelRequests>12)throw fail('AGENT_BUDGET_INVALID');
  return {schemaVersion:1,limits:{...defaults,modelRequests:skill?0:maxModelRequests},used:Object.fromEntries(keys.map(key=>[key,0]))};
}
export function claimTaskBudget(input,{kind,inputBytes=0}={}){
  const budget=validateTaskBudget(input),key={round:'rounds',model:'modelRequests',tool:'tools',correction:'corrections',reflection:'reflections'}[kind];
  if(!key||!Number.isSafeInteger(inputBytes)||inputBytes<0||inputBytes>200000)throw fail('AGENT_BUDGET_INVALID');
  if(budget.used.activeMs>=budget.limits.activeMs||budget.used[key]>=budget.limits[key])throw fail('AGENT_BUDGET_EXHAUSTED');
  if(kind==='model'&&budget.used.estimatedInputTokens+inputBytes>budget.limits.estimatedInputTokens)throw fail('AGENT_CONTEXT_BUDGET_EXHAUSTED');
  budget.used[key]++;if(kind==='model')budget.used.estimatedInputTokens+=inputBytes;return budget;
}
export function beginBudgetLease(input){
  const budget=validateTaskBudget(input);if(budget.lease)throw fail('AGENT_BUDGET_LEASE_ACTIVE');
  const remaining=budget.limits.activeMs-budget.used.activeMs;if(remaining<=0)throw fail('AGENT_BUDGET_EXHAUSTED');
  budget.lease={id:randomUUID(),reservedMs:remaining};return budget;
}
export function finishBudgetLease(input,{leaseId,elapsedMs,abandoned=false}={}){
  const budget=validateTaskBudget(input);if(!budget.lease||budget.lease.id!==leaseId)throw fail('AGENT_BUDGET_LEASE_STALE');
  if(!abandoned&&(!Number.isSafeInteger(elapsedMs)||elapsedMs<0))throw fail('AGENT_BUDGET_INVALID');
  budget.used.activeMs+=abandoned?budget.lease.reservedMs:Math.min(budget.lease.reservedMs,elapsedMs);delete budget.lease;return budget;
}
