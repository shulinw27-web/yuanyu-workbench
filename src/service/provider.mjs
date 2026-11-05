import {readFile,realpath,lstat} from 'node:fs/promises';
import {isAbsolute,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const fail=(code,status)=>Object.assign(new Error(code),{code,...(status?{status}:{})});
const outside=file=>{const offset=relative(ROOT,file);return !!offset&&(isAbsolute(offset)||offset==='..'||offset.startsWith('..'+sep));};
const identifier=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,150}$/.test(value);

/** Server-only upstream configuration. Construction never reads a key or makes a request. */
export function createSponsoredProvider({providers,fetchImpl=fetch}){
  if(!Array.isArray(providers)||providers.length<1||providers.length>30)throw fail('PROVIDER_CONFIG_INVALID');
  const entries=new Map();
  for(const input of providers){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['id','label','baseUrl','model','apiKeyFile'].includes(key))||!identifier(input.id)||!identifier(input.model)||typeof input.label!=='string'||!input.label.trim()||input.label.length>100||typeof input.apiKeyFile!=='string'||!isAbsolute(input.apiKeyFile)||!outside(resolve(input.apiKeyFile))||entries.has(input.id))throw fail('PROVIDER_CONFIG_INVALID');
    let url;try{url=new URL(input.baseUrl);}catch{throw fail('PROVIDER_CONFIG_INVALID');}
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!/^\/[a-zA-Z0-9/_-]*$/.test(url.pathname)||/\/chat\/completions\/?$/.test(url.pathname))throw fail('PROVIDER_CONFIG_INVALID');
    entries.set(input.id,Object.freeze({...input,baseUrl:url.href.replace(/\/$/,'')}));
  }
  return Object.freeze({
    models:[...entries.values()].map(({id,label})=>({id,label})),
    async requestModel({modelId,messages,tools,maxTokens,signal}){
      const profile=entries.get(modelId);if(!profile)throw fail('MODEL_NOT_ALLOWED');
      let key;
      try{
        if(signal?.aborted)throw fail('PROVIDER_TIMEOUT');
        const target=await realpath(profile.apiKeyFile),info=await lstat(target);
        if(!outside(target)||!info.isFile()||info.size>4096)throw fail('PROVIDER_KEY_UNAVAILABLE');
        key=(await readFile(target,'utf8')).trim();
        if(!/^[\x21-\x7e]{8,1024}$/.test(key))throw fail('PROVIDER_KEY_UNAVAILABLE');
        if(signal?.aborted)throw fail('PROVIDER_TIMEOUT');
        const response=await fetchImpl(profile.baseUrl+'/chat/completions',{method:'POST',redirect:'error',signal,
          headers:{'content-type':'application/json',authorization:`Bearer ${key}`},
          body:JSON.stringify({model:profile.model,messages,...(tools.length?{tools,tool_choice:'auto'}:{}),max_tokens:maxTokens,temperature:0,stream:false})});
        key='';
        if(!response.ok){await response.body?.cancel();throw fail('PROVIDER_REJECTED',response.status);}
        const reader=response.body?.getReader();if(!reader)throw fail('PROVIDER_RESPONSE_INVALID');
        const chunks=[];let total=0;
        while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>1024*1024){await reader.cancel();throw fail('PROVIDER_RESPONSE_INVALID');}chunks.push(Buffer.from(value));}
        const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(signal?.aborted)throw fail('PROVIDER_TIMEOUT');
        return {message:result?.choices?.[0]?.message,usage:result?.usage};
      }catch(cause){if(cause.code==='PROVIDER_REJECTED')throw fail('PROVIDER_REJECTED',cause.status);throw fail(signal?.aborted?'PROVIDER_TIMEOUT':'PROVIDER_UNAVAILABLE');}
      finally{key='';}
    }
  });
}
