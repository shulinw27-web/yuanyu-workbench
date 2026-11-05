import {mkdir,readFile,writeFile,rename,unlink,lstat,realpath} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const fail=code=>Object.assign(new Error(code),{code});
const ROOT=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const inside=(base,path)=>{const value=relative(base,path);return !value||value!=='..'&&!value.startsWith('..'+sep)&&!isAbsolute(value);};
const trusted=new WeakSet();
export function accountIdentity(account){
  if(!account||!/^[a-zA-Z0-9_-]{1,64}$/.test(account.id)||typeof account.displayName!=='string'||!account.displayName.trim()||account.displayName.length>80||account.tier!=='personal')throw fail('ACCOUNT_INVALID');
  const identity=Object.freeze({companyId:`personal-${account.id}`,userId:`user-${account.id}`,displayName:account.displayName,provider:'account'});trusted.add(identity);return identity;
}
export const isAccountIdentity=identity=>trusted.has(identity);

/** HTTPS account/inference client. Only the main process owns this instance and its encrypted session. */
export function createProductClient({dataDir,cryptoAdapter,baseUrl,allowLocalDemo=false,fetchImpl=fetch}){
  let url;try{url=new URL(baseUrl);}catch{throw fail('SERVICE_CONFIG_INVALID');}
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.protocol!=='https:'&&!(allowLocalDemo&&url.protocol==='http:'&&url.hostname==='127.0.0.1'))throw fail('SERVICE_CONFIG_INVALID');
  if(!isAbsolute(dataDir)||inside(ROOT,resolve(dataDir)))throw fail('SERVICE_CONFIG_INVALID');
  const origin=url.origin,dir=join(dataDir,'account'),file=join(dir,'session.json');let generation=0;
  async function safeFile(){
    await mkdir(dir,{recursive:true});if((await lstat(dir)).isSymbolicLink()||inside(ROOT,await realpath(dir)))throw fail('SESSION_PATH_INVALID');
    try{const info=await lstat(file);if(info.isSymbolicLink()||info.size>24000)throw fail('SESSION_PATH_INVALID');}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  async function token(){
    await safeFile();let saved;try{saved=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw fail('SESSION_INVALID');}
    if(saved.schemaVersion!==1||typeof saved.ciphertext!=='string'||!await cryptoAdapter.available())throw fail('SESSION_INVALID');
    let clear;try{clear=JSON.parse(await cryptoAdapter.decrypt(saved.ciphertext));}catch{throw fail('SESSION_INVALID');}
    if(clear.origin!==origin||typeof clear.sessionToken!=='string'||clear.sessionToken.length>512)throw fail('SESSION_INVALID');return clear.sessionToken;
  }
  async function save(sessionToken){
    if(typeof sessionToken!=='string'||sessionToken.length<20||sessionToken.length>512||!await cryptoAdapter.available())throw fail('CRYPTO_UNAVAILABLE');
    await safeFile();const ciphertext=await cryptoAdapter.encrypt(JSON.stringify({origin,sessionToken})),tmp=file+'.'+randomUUID()+'.tmp';
    if(typeof ciphertext!=='string'||!ciphertext)throw fail('CRYPTO_FAILED');await writeFile(tmp,JSON.stringify({schemaVersion:1,ciphertext}),{flag:'wx',mode:0o600});await rename(tmp,file);generation++;
  }
  async function request(path,{method='GET',body,authenticated=false,signal,expectedGeneration,expectedToken}={}){
    if(expectedGeneration!==undefined&&expectedGeneration!==generation)throw fail('CANCELLED');
    let sessionToken=authenticated?await token():null;if(authenticated&&!sessionToken)throw fail('AUTH_REQUIRED');
    if(expectedGeneration!==undefined&&expectedGeneration!==generation||expectedToken!==undefined&&expectedToken!==sessionToken)throw fail('CANCELLED');
    const abort=AbortSignal.any([AbortSignal.timeout(20000),...(signal?[signal]:[])]);
    try{
      const response=await fetchImpl(origin+path,{method,redirect:'error',signal:abort,headers:{'Content-Type':'application/json',...(sessionToken?{Authorization:`Bearer ${sessionToken}`}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
      const reader=response.body?.getReader();if(!reader)throw fail('SERVICE_RESPONSE_INVALID');let size=0;const chunks=[];
      while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024*1024){await reader.cancel();throw fail('SERVICE_RESPONSE_INVALID');}chunks.push(Buffer.from(value));}
      let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail('SERVICE_RESPONSE_INVALID');}
      if(!response.ok)throw fail(typeof result?.error?.code==='string'&&/^[A-Z_]{3,70}$/.test(result.error.code)?result.error.code:'SERVICE_REQUEST_FAILED');
      if(expectedGeneration!==undefined&&expectedGeneration!==generation)throw fail('CANCELLED');
      return result;
    }catch(error){if(error.code&&/^[A-Z_]{3,70}$/.test(error.code))throw fail(error.code);throw fail(signal?.aborted?'CANCELLED':abort.aborted?'SERVICE_TIMEOUT':'SERVICE_UNAVAILABLE');}
    finally{sessionToken=null;}
  }
  const publicInfo=async()=>{
    const result=await request('/v1/public');
    if(!['local_demo','configured'].includes(result.deployment)||result.deployment==='local_demo'&&!allowLocalDemo||!Array.isArray(result.models))throw fail('SERVICE_RESPONSE_INVALID');
    return result;
  };
  async function me(){const result=await request('/v1/me',{authenticated:true});accountIdentity(result.account);return result;}
  return {
    async status(){
      let info;try{info=await publicInfo();}catch{return {mode:'personal',authenticated:false,deployment:'unconfigured',developer:{name:'开发者',contact:'',contactType:'wechat'},models:[],companyWorkflows:{readOnly:true},serviceUnavailable:true};}
      try{const value=await me();return {...info,...value,mode:'personal',authenticated:true,companyWorkflows:{readOnly:true}};}catch(error){return {...info,mode:'personal',authenticated:false,companyWorkflows:{readOnly:true},...(error.code!=='AUTH_REQUIRED'?{sessionError:error.code}:{})};}
    },
    async register({email,password,name}){const value=await request('/v1/auth/register',{method:'POST',body:{email,password,name}});accountIdentity(value.account);await save(value.sessionToken);return {account:value.account,...(value.demoVerificationCode?{demoVerificationCode:value.demoVerificationCode}:{})};},
    async login({email,password}){const value=await request('/v1/auth/login',{method:'POST',body:{email,password}});accountIdentity(value.account);await save(value.sessionToken);return {account:value.account};},
    async verify({code}){return request('/v1/auth/verify',{method:'POST',body:{code},authenticated:true});},
    async logout(){try{await request('/v1/auth/logout',{method:'POST',body:{},authenticated:true});}finally{await safeFile();await unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;});generation++;}return {loggedOut:true};},
    me,
    async requester({modelId,consent}){
      if(consent?.taskText!==true)throw fail('MODEL_CONSENT_REQUIRED');
      const version=generation,sessionToken=await token();
      if(!sessionToken)throw fail('AUTH_REQUIRED');if(version!==generation)throw fail('CANCELLED');
      const session={authenticated:true,expectedGeneration:version,expectedToken:sessionToken};
      const lockedAccount=async()=>{const value=await request('/v1/me',session);accountIdentity(value.account);if(version!==generation)throw fail('CANCELLED');return value.account;};
      const info=await publicInfo(),owner=(await lockedAccount()).id;
      if(!info.models.some(model=>model.id===modelId))throw fail('MODEL_NOT_AVAILABLE');
      return async({messages,tools=[],signal})=>{
        if(version!==generation||(await lockedAccount()).id!==owner||version!==generation)throw fail('CANCELLED');
        const result=await request('/v1/inference',{...session,method:'POST',signal,body:{modelId,messages,tools,consent,requestId:randomUUID()}});
        if(version!==generation||(await lockedAccount()).id!==owner||version!==generation)throw fail('CANCELLED');
        if(!result.message||typeof result.message!=='object')throw fail('SERVICE_RESPONSE_INVALID');return result.message;
      };
    }
  };
}
