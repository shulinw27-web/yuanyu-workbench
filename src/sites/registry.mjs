import { readFile,writeFile,mkdir,rename } from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const fail=code=>Object.assign(new Error(code),{code});
const queues=new Map();
export function validateSite(input) {
  if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(k=>!['id','label','origin','entryPath','paths','revision'].includes(k)) || !/^site-[a-zA-Z0-9_-]{1,64}$/.test(input.id) || typeof input.label!=='string' || !input.label.trim() || input.label.length>80 || input.revision!==undefined&&(!Number.isSafeInteger(input.revision)||input.revision<1))throw fail('SITE_INVALID');
  let url;try{url=new URL(input.origin);}catch{throw fail('SITE_INVALID');}
  if(url.protocol!=='https:' || url.origin!==input.origin || url.username || url.password)throw fail('SITE_HTTPS_REQUIRED');
  const validPath=p=>typeof p==='string' && /^\/[a-zA-Z0-9/_-]*$/.test(p) && !p.includes('//') && !p.split('/').includes('..');
  if(!validPath(input.entryPath) || !Array.isArray(input.paths) || !input.paths.length || input.paths.length>20 || !input.paths.every(validPath) || !input.paths.includes(input.entryPath))throw fail('SITE_PATH_INVALID');
  return {id:input.id,label:input.label.trim(),origin:url.origin,entryPath:input.entryPath,paths:[...new Set(input.paths)],revision:input.revision??1};
}
export function createSiteRegistry({dataDir,identity}) {
  if(!/^[a-zA-Z0-9_-]+$/.test(identity.companyId) || !/^[a-zA-Z0-9_-]+$/.test(identity.userId))throw fail('IDENTITY_INVALID');
  const dir=join(dataDir,'sites',identity.companyId,identity.userId),file=join(dir,'sites.json');
  const list=async()=>{try{const values=JSON.parse(await readFile(file,'utf8'));if(!Array.isArray(values) || values.length>12)throw fail('SITE_STORE_INVALID');return values.map(validateSite);}catch(error){if(error.code==='ENOENT')return [];throw error;}};
  const serial=fn=>{const promise=(queues.get(file)||Promise.resolve()).then(fn);queues.set(file,promise.catch(()=>{}));return promise;};
  const save=async items=>{await mkdir(dir,{recursive:true});const temporary=file+`.${randomUUID()}.tmp`;await writeFile(temporary,JSON.stringify(items,null,2),{flag:'wx',mode:0o600});await rename(temporary,file);};
  const register=input=>serial(async()=>{if(input.revision!==undefined)throw fail('SITE_INVALID');const site=validateSite(input),items=await list();if(items.some(s=>s.id===site.id))throw fail('SITE_EXISTS');if(items.length>=12)throw fail('SITE_LIMIT');items.push(site);await save(items);return site;});
  const update=input=>serial(async()=>{const {expectedRevision,...values}=input,items=await list(),index=items.findIndex(s=>s.id===input.id);if(index<0)throw fail('SITE_NOT_FOUND');if(items[index].revision!==expectedRevision)throw fail('SITE_VERSION_CONFLICT');const site=validateSite({...values,revision:expectedRevision+1});items[index]=site;await save(items);return site;});
  const remove=({id,expectedRevision})=>serial(async()=>{const items=await list(),index=items.findIndex(s=>s.id===id);if(index<0)throw fail('SITE_NOT_FOUND');if(items[index].revision!==expectedRevision)throw fail('SITE_VERSION_CONFLICT');items.splice(index,1);await save(items);return {deleted:true,id};});
  return {list,register,update,remove};
}
