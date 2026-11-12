const fail=code=>Object.assign(new Error(code),{code});
const assert=(value,code='MEMORY_INPUT_INVALID')=>{if(!value)throw fail(code);};
export const MEMORY_KINDS=Object.freeze(['preference','knowledge','episode','lesson']);
export const DAY=86_400_000;
export const memoryFields=(value,allowed)=>assert(value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Object.keys(value).every(key=>allowed.includes(key)));
export function memoryId(value){assert(typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value));return value;}
const SECRET=/(?:\b(?:password|passwd|secret|(?:access[_ -]?|refresh[_ -]?)?token|authorization|cookie|api[_ -]?key|otp|mfa[_ -]?code)\s*[:=]|(?:密码|口令|密钥|验证码|访问令牌)\s*[:：=]|\bBearer\s+\S+|\beyJ[a-zA-Z0-9_-]{12,}\.[a-zA-Z0-9_-]+\.|\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@|<\/?(?:html|body|script)\b|<!doctype)/i;
const INJECTION=/(?:ignore\s+(?:all\s+)?(?:previous|prior|system)\s+instructions|(?:忽略|覆盖|绕过).{0,12}(?:系统指令|权限|安全规则)|(?:上传|发送|泄露).{0,12}(?:密码|密钥|cookie|token))/i;
export function memoryText(value,max){assert(typeof value==='string'&&value.trim()&&value.length<=max&&!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value));assert(!SECRET.test(value)&&!INJECTION.test(value),'MEMORY_SENSITIVE_DATA');return value.trim();}
export function memoryBindings(input=[]){
  assert(Array.isArray(input)&&input.length<=12);const seen=new Set();
  return input.map(entry=>{memoryFields(entry,['id','origin','revision']);memoryId(entry.id);assert(!seen.has(entry.id)&&Number.isSafeInteger(entry.revision)&&entry.revision>=1);seen.add(entry.id);let url;try{url=new URL(entry.origin);}catch{throw fail('MEMORY_INPUT_INVALID');}assert(url.origin===entry.origin&&!url.username&&!url.password&&(url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)));return {id:entry.id,origin:entry.origin,revision:entry.revision};});
}
export function memorySource(input='user_message'){
  const source=typeof input==='string'?{type:input}:input;memoryFields(source,['type','id']);assert(['user_message','verified_run','approved_document'].includes(source.type));if(source.id!==undefined)memoryId(source.id);assert(source.type==='user_message'||source.id!==undefined);return {...source};
}
export function memoryExpiry({kind,confirmed,expiresAt,timestamp}){
  if(expiresAt!==undefined&&expiresAt!==null){assert(typeof expiresAt==='string'&&Number.isFinite(Date.parse(expiresAt))&&Date.parse(expiresAt)>timestamp&&Date.parse(expiresAt)<=timestamp+3660*DAY);return new Date(expiresAt).toISOString();}
  const days=!confirmed?7:kind==='episode'?30:kind==='knowledge'?7:kind==='lesson'?90:null;
  return days===null?null:new Date(timestamp+days*DAY).toISOString();
}
export function withinMemoryScope(entry,siteBindings){return entry.siteBindings.every(binding=>siteBindings.some(site=>site.id===binding.id&&site.origin===binding.origin&&site.revision===binding.revision));}
export function effectiveMemoryStatus(entry,timestamp,paused=false){if(paused&&entry.status==='active')return 'paused';if(entry.expiresAt&&Date.parse(entry.expiresAt)<=timestamp)return 'stale';return entry.status;}
export {fail as memoryError,assert as memoryAssert};
