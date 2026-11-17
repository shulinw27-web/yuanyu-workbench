import {randomUUID} from 'node:crypto';

const fail=code=>Object.assign(new Error(code),{code});
const keys=['modelRequests','rounds','tools','activeMs','corrections','reflections','estimatedInputTokens','compactions'];
// Per-profile ceilings and zeroable limits. Legacy v1 budgets migrate to the standard profile.
const CAPS={standard:{modelRequests:12,rounds:12,tools:100,activeMs:45000,corrections:1,reflections:1,estimatedInputTokens:14_000_000,compactions:2},
  induction:{modelRequests:12,rounds:12,tools:100,activeMs:90000,corrections:1,reflections:1,estimatedInputTokens:14_000_000,compactions:2}};
const ZEROABLE={standard:['modelRequests','compactions'],induction:['modelRequests','reflections','compactions']};
const PROFILES=['standard','induction'];
const DEFAULT_LIMITS={standard:{modelRequests:8,rounds:12,tools:100,activeMs:45000,corrections:1,reflections:1,estimatedInputTokens:14_000_000,compactions:2},
  induction:{modelRequests:3,rounds:6,tools:30,activeMs:90000,corrections:1,reflections:0,estimatedInputTokens:2_000_000,compactions:0}};
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const closed=(value,fields)=>{if(!plain(value)||Object.keys(value).some(key=>!fields.includes(key)))throw fail('AGENT_BUDGET_INVALID');};
function migrateV1(input){
  closed(input,['schemaVersion','limits','used','lease']);
  if(input.schemaVersion!==1)throw fail('AGENT_BUDGET_INVALID');
  return {schemaVersion:2,profile:'standard',limits:{...input.limits,compactions:2},used:{...input.used,compactions:0},...(input.lease!==undefined?{lease:input.lease}:{})};
}
export function validateTaskBudget(input){
  if(plain(input)&&input.schemaVersion===1)input=migrateV1(input);
  closed(input,['schemaVersion','profile','limits','used','lease']);if(input.schemaVersion!==2||!PROFILES.includes(input.profile))throw fail('AGENT_BUDGET_INVALID');
  const caps=CAPS[input.profile],zeroable=ZEROABLE[input.profile];
  for(const field of ['limits','used']){closed(input[field],keys);for(const key of keys){const value=input[field][key];if(!Number.isSafeInteger(value)||value<0||value>(field==='limits'?caps[key]:input.limits[key]))throw fail('AGENT_BUDGET_INVALID');if(field==='limits'&&value===0&&!zeroable.includes(key))throw fail('AGENT_BUDGET_INVALID');}}
  if(input.lease!==undefined){closed(input.lease,['id','reservedMs']);if(typeof input.lease.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(input.lease.id)||!Number.isSafeInteger(input.lease.reservedMs)||input.lease.reservedMs<1||input.used.activeMs+input.lease.reservedMs>input.limits.activeMs)throw fail('AGENT_BUDGET_INVALID');}
  return structuredClone(input);
}
export function createTaskBudget({maxModelRequests,skill=false,profile='standard'}={}){
  if(!PROFILES.includes(profile))throw fail('AGENT_BUDGET_INVALID');
  // The per-profile default wins unless the caller explicitly passes a request ceiling.
  if(maxModelRequests===undefined)maxModelRequests=DEFAULT_LIMITS[profile].modelRequests;
  if(!Number.isSafeInteger(maxModelRequests)||maxModelRequests<1||maxModelRequests>12)throw fail('AGENT_BUDGET_INVALID');
  return {schemaVersion:2,profile,limits:{...DEFAULT_LIMITS[profile],modelRequests:skill?0:maxModelRequests},used:Object.fromEntries(keys.map(key=>[key,0]))};
}
export function claimTaskBudget(input,{kind,inputBytes=0}={}){
  const budget=validateTaskBudget(input),key={round:'rounds',model:'modelRequests',tool:'tools',correction:'corrections',reflection:'reflections',compaction:'compactions'}[kind];
  if(!key||!Number.isSafeInteger(inputBytes)||inputBytes<0||inputBytes>14_500_000)throw fail('AGENT_BUDGET_INVALID');
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
