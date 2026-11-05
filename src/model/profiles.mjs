import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const REPOSITORY=path.resolve(fileURLToPath(new URL('../..',import.meta.url)));
const LOCKS=new Set();
let queue=Promise.resolve();
const fail=code=>Object.assign(new Error(code),{code});
const assert=(value,code='MODEL_PROFILE_INVALID')=>{if(!value)throw fail(code);};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const closed=(value,allowed)=>assert(plain(value)&&Object.keys(value).every(key=>allowed.includes(key)),'MODEL_PROFILE_INPUT_INVALID');
const within=(base,file)=>{const rel=path.relative(base,file);return !rel||!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${path.sep}`);};
const id=value=>{assert(typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value),'MODEL_PROFILE_INPUT_INVALID');return value;};
const text=(value,max)=>{assert(typeof value==='string'&&value.trim()&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value),'MODEL_PROFILE_INPUT_INVALID');return value.trim();};

// Standard metered Chat Completions APIs. Coding/subscription endpoints require a separate custom configuration.
export const PROVIDERS=Object.freeze(Object.fromEntries(Object.entries({
  deepseek:{label:'DeepSeek',defaultBaseUrl:'https://api.deepseek.com',docUrl:'https://api-docs.deepseek.com/quick_start/agent_integrations/'},
  glm:{label:'智谱 GLM',defaultBaseUrl:'https://open.bigmodel.cn/api/paas/v4',docUrl:'https://docs.bigmodel.cn/cn/api/introduction'},
  qwen:{label:'阿里云百炼 / 千问',defaultBaseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',docUrl:'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope'},
  moonshot:{label:'月之暗面 Kimi',defaultBaseUrl:'https://api.moonshot.cn/v1',docUrl:'https://platform.moonshot.cn/docs/api/chat'},
  ark:{label:'火山方舟',defaultBaseUrl:'https://ark.cn-beijing.volces.com/api/v3',docUrl:'https://console.volcengine.com/ark/region%3Acn-beijing/docs/base-url-and-authentication'},
  custom:{label:'自定义兼容服务',defaultBaseUrl:'',docUrl:''}
}).map(([key,value])=>[key,Object.freeze(value)])));

function metadata(input){
  const label=text(input.label,80),model=text(input.model,151);
  assert(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,150}$/.test(model),'MODEL_PROFILE_INPUT_INVALID');
  assert(typeof input.provider==='string'&&Object.hasOwn(PROVIDERS,input.provider),'MODEL_PROVIDER_INVALID');
  assert(['task_text','selected_pages'].includes(input.dataScope),'MODEL_PROFILE_INPUT_INVALID');
  let url;try{url=new URL(input.baseUrl);}catch{throw fail('MODEL_PROFILE_INPUT_INVALID');}
  assert(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.href.length<=2048&&/^\/[a-zA-Z0-9/_-]*$/.test(url.pathname),'MODEL_PROFILE_HTTPS_REQUIRED');
  const baseUrl=url.href.replace(/\/$/,'');
  assert(!/\/chat\/completions\/?$/.test(url.pathname),'MODEL_PROFILE_BASE_URL_REQUIRED');
  if(input.provider!=='custom')assert(baseUrl===PROVIDERS[input.provider].defaultBaseUrl,'MODEL_PROVIDER_ENDPOINT_MISMATCH');
  return {label,provider:input.provider,baseUrl,model,dataScope:input.dataScope};
}
function view(profile){
  const {id,label,provider,baseUrl,model,dataScope,revision,createdAt,updatedAt}=profile;
  return {id,label,provider,baseUrl,model,dataScope,revision,createdAt,updatedAt,configured:true};
}
async function directory(target){await fs.mkdir(target,{recursive:true,mode:0o700});const info=await fs.lstat(target);assert(info.isDirectory()&&!info.isSymbolicLink(),'MODEL_PROFILE_UNSAFE_PATH');}
async function readJSON(file){
  try{const info=await fs.lstat(file);assert(info.isFile()&&!info.isSymbolicLink()&&info.size<=1_000_000,'MODEL_PROFILE_UNSAFE_PATH');return JSON.parse(await fs.readFile(file,'utf8'));}
  catch(error){if(error.code==='ENOENT')return undefined;if(error.code==='MODEL_PROFILE_UNSAFE_PATH')throw error;throw fail('MODEL_PROFILE_STORE_INVALID');}
}
async function atomicJSON(file,value){
  const encoded=JSON.stringify(value,null,2)+'\n';assert(Buffer.byteLength(encoded)<=1_000_000,'MODEL_PROFILE_LIMIT');
  const temporary=path.join(path.dirname(file),`.state.${randomUUID()}.tmp`);let handle;
  try{handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(encoded,'utf8');await handle.sync();await handle.close();handle=undefined;await fs.rename(temporary,file);}
  finally{await handle?.close().catch(()=>{});await fs.rm(temporary,{force:true}).catch(()=>{});}
}
async function lockRoot(resolved){
  await directory(resolved);const root=await fs.realpath(resolved);assert(!within(REPOSITORY,root),'MODEL_PROFILE_UNSAFE_PATH');
  const key=process.platform==='win32'?root.toLowerCase():root;
  if(!LOCKS.has(key)){
    const file=path.join(root,'.model-profiles.lock');
    const previous=await readJSON(file);
    if(previous){assert(Number.isInteger(previous.pid)&&previous.pid>0,'MODEL_PROFILE_LOCKED');let alive=true;try{process.kill(previous.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;}assert(!alive,'MODEL_PROFILE_LOCKED');await fs.rm(file);}
    let handle;try{handle=await fs.open(file,'wx',0o600);await handle.writeFile(JSON.stringify({pid:process.pid}));await handle.sync();LOCKS.add(key);}catch(error){if(error.code==='EEXIST')throw fail('MODEL_PROFILE_LOCKED');throw error;}finally{await handle?.close();}
  }
  return root;
}
function validateState(state,identity){
  try{
    closed(state,['schemaVersion','companyId','userId','activeId','revision','profiles']);
    assert(state.schemaVersion===1&&state.companyId===identity.companyId&&state.userId===identity.userId&&Number.isSafeInteger(state.revision)&&state.revision>=1&&Array.isArray(state.profiles)&&state.profiles.length<=32);
    const ids=new Set();
    for(const profile of state.profiles){
      closed(profile,['id','label','provider','baseUrl','model','dataScope','revision','keyCipher','createdAt','updatedAt']);id(profile.id);metadata(profile);
      assert(!ids.has(profile.id)&&Number.isSafeInteger(profile.revision)&&profile.revision>=1&&typeof profile.keyCipher==='string'&&profile.keyCipher.length>0&&profile.keyCipher.length<=20000);ids.add(profile.id);
      text(profile.createdAt,80);text(profile.updatedAt,80);
    }
    assert(state.activeId===null||typeof state.activeId==='string'&&ids.has(state.activeId));
  }catch{throw fail('MODEL_PROFILE_STORE_INVALID');}
}

/** Trusted main-process store. Never expose readActive/withActive through renderer IPC. */
export function createModelProfiles({dataDir,identity,cryptoAdapter}){
  assert(typeof dataDir==='string'&&path.isAbsolute(dataDir),'MODEL_PROFILE_UNSAFE_PATH');
  const resolved=path.resolve(dataDir);assert(!within(REPOSITORY,resolved),'MODEL_PROFILE_UNSAFE_PATH');
  const owner={companyId:id(identity?.companyId),userId:id(identity?.userId)};
  const operation=callback=>{
    const result=queue.then(async()=>{
      const root=await lockRoot(resolved);let target=root;
      for(const part of ['model-profiles',owner.companyId,owner.userId]){target=path.join(target,part);await directory(target);}
      assert(await fs.realpath(target)===target,'MODEL_PROFILE_UNSAFE_PATH');
      const file=path.join(target,'state.json'),state=await readJSON(file)??{schemaVersion:1,...owner,activeId:null,revision:1,profiles:[]};
      validateState(state,owner);
      return callback(state,async()=>{state.revision++;validateState(state,owner);await atomicJSON(file,state);});
    });queue=result.catch(()=>{});return result;
  };
  const find=(state,profileId)=>{id(profileId);const profile=state.profiles.find(value=>value.id===profileId);assert(profile,'MODEL_PROFILE_NOT_FOUND');return profile;};
  const available=()=>assert(cryptoAdapter?.available?.()===true&&typeof cryptoAdapter.encrypt==='function'&&typeof cryptoAdapter.decrypt==='function','MODEL_CRYPTO_UNAVAILABLE');
  const binding=profile=>({schemaVersion:1,...owner,profileId:profile.id,provider:profile.provider,baseUrl:profile.baseUrl,model:profile.model});
  const decrypt=async profile=>{
    available();let value;
    try{value=JSON.parse(await cryptoAdapter.decrypt(profile.keyCipher));}catch{throw fail('MODEL_KEY_UNAVAILABLE');}
    try{closed(value,['schemaVersion','companyId','userId','profileId','provider','baseUrl','model','apiKey']);for(const [key,expected]of Object.entries(binding(profile)))assert(value[key]===expected,'MODEL_KEY_BINDING_MISMATCH');assert(typeof value.apiKey==='string'&&/^[\x21-\x7e]{8,1024}$/.test(value.apiKey),'MODEL_KEY_UNAVAILABLE');return value.apiKey;}
    finally{if(value)value.apiKey='';}
  };
  const encrypt=async(profile,apiKey)=>{available();try{const cipher=await cryptoAdapter.encrypt(JSON.stringify({...binding(profile),apiKey}));assert(typeof cipher==='string'&&cipher.length>0&&cipher.length<=20000,'MODEL_CRYPTO_FAILED');return cipher;}catch{throw fail('MODEL_CRYPTO_FAILED');}};
  const active=state=>{assert(state.activeId,'MODEL_NOT_CONFIGURED');return find(state,state.activeId);};
  const readActive=()=>operation(state=>state.activeId?{...view(active(state)),enabled:true,selectionRevision:state.revision}:null);
  return Object.freeze({
    list:()=>operation(state=>({profiles:state.profiles.map(view),activeId:state.activeId,revision:state.revision})),
    save:input=>operation(async(state,save)=>{
      closed(input,['id','label','provider','baseUrl','model','dataScope','apiKey','expectedRevision']);
      const properties=metadata(input),previous=input.id===undefined?undefined:find(state,input.id);
      if(input.expectedRevision!==undefined)assert(previous&&previous.revision===input.expectedRevision,'MODEL_PROFILE_VERSION_CONFLICT');
      if(input.apiKey!==undefined)assert(typeof input.apiKey==='string','MODEL_PROFILE_INPUT_INVALID');
      let apiKey=input.apiKey?.trim()??'';
      if(apiKey)assert(/^[\x21-\x7e]{8,1024}$/.test(apiKey),'MODEL_KEY_INVALID');
      else{
        assert(previous,'MODEL_KEY_REQUIRED');
        assert(previous.provider===properties.provider&&previous.baseUrl===properties.baseUrl,'MODEL_KEY_REENTRY_REQUIRED');
        apiKey=await decrypt(previous);
      }
      try{
        assert(!Object.values(properties).some(value=>value.includes(apiKey)),'MODEL_PROFILE_INPUT_SENSITIVE');
        assert(previous||state.profiles.length<32,'MODEL_PROFILE_LIMIT');
        const timestamp=new Date().toISOString(),profile={id:previous?.id??randomUUID(),...properties,revision:(previous?.revision??0)+1,createdAt:previous?.createdAt??timestamp,updatedAt:timestamp};
        profile.keyCipher=await encrypt(profile,apiKey);
        if(previous)state.profiles[state.profiles.indexOf(previous)]=profile;else state.profiles.push(profile);
        if(!state.activeId)state.activeId=profile.id;
        await save();return view(profile);
      }finally{apiKey='';}
    }),
    select:profileId=>operation(async(state,save)=>{const profile=find(state,profileId);state.activeId=profile.id;await save();return view(profile);}),
    remove:profileId=>operation(async(state,save)=>{const profile=find(state,profileId);state.profiles.splice(state.profiles.indexOf(profile),1);if(state.activeId===profileId)state.activeId=null;await save();return {removed:true,id:profileId};}),
    status:()=>operation(state=>{if(!state.activeId)return {status:'not_configured',mode:'compatible',dataScope:'task_text'};const profile=active(state);return {status:'ready',connection:'not_verified',mode:'compatible',model:profile.model,host:new URL(profile.baseUrl).host,dataScope:profile.dataScope,profileId:profile.id,revision:profile.revision};}),
    readActive,
    async withActive(callback){
      assert(typeof callback==='function','MODEL_PROFILE_INPUT_INVALID');
      const selected=await operation(state=>({profile:structuredClone(active(state)),selectionRevision:state.revision}));
      const temporary={...view(selected.profile),enabled:true,selectionRevision:selected.selectionRevision,apiKey:await decrypt(selected.profile)};
      try{
        const before=await readActive();
        assert(before?.id===temporary.id&&before?.revision===temporary.revision&&before?.selectionRevision===temporary.selectionRevision,'MODEL_CONFIG_CHANGED');
        const result=await callback(temporary),current=await readActive();
        assert(current?.id===temporary.id&&current?.revision===temporary.revision&&current?.selectionRevision===temporary.selectionRevision,'MODEL_CONFIG_CHANGED');return result;
      }finally{temporary.apiKey='';}
    }
  });
}
