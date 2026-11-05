import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,lstat,realpath} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createWriteApproval} from './write-approval.mjs';

const fail=code=>Object.assign(new Error(code),{code});
const queues=new Map();
const repo=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const inside=(base,target)=>{const path=relative(base,target);return !path||!isAbsolute(path)&&path!=='..'&&!path.startsWith('..'+sep);};

/** A concrete synthetic source adapter. No browser or real business system receives writes. */
export function createDemoWrite({dataDir,identity,checkContext}) {
  if(!isAbsolute(dataDir)||inside(repo,resolve(dataDir))||!['companyId','userId'].every(k=>/^[a-zA-Z0-9_-]{1,100}$/.test(identity[k])))throw fail('WRITE_CONFIG_INVALID');
  const dir=join(dataDir,'demo-source',identity.companyId,identity.userId),file=join(dir,'state.json');
  const serial=fn=>{const result=(queues.get(file)||Promise.resolve()).then(fn);queues.set(file,result.catch(()=>{}));return result;};
  async function read(){
    await mkdir(dir,{recursive:true,mode:0o700});
    for(let part=dir;inside(resolve(dataDir),part);part=resolve(part,'..'))if((await lstat(part)).isSymbolicLink())throw fail('WRITE_STORE_INVALID');
    if(inside(repo,await realpath(dir)))throw fail('WRITE_STORE_INVALID');
    try{
      const stat=await lstat(file);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>2_000_000)throw fail('WRITE_STORE_INVALID');
      const state=JSON.parse(await readFile(file,'utf8'));
      if(state.schemaVersion!==1||state.companyId!==identity.companyId||state.userId!==identity.userId||!Array.isArray(state.records)||state.records.length>1000)throw fail('WRITE_STORE_INVALID');
      return state;
    }catch(error){if(error.code==='ENOENT')return {schemaVersion:1,companyId:identity.companyId,userId:identity.userId,records:[]};throw error;}
  }
  async function save(state){const temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(state,null,2)+'\n',{flag:'wx',mode:0o600});await rename(temp,file);}
  const revision='synthetic-monthly-note-v1';
  const context=async()=>{if(await checkContext()!==true)throw fail('WRITE_CONTEXT_CHANGED');};
  const ledger=createWriteApproval({dataDir,identity,allowedOperations:['synthetic.monthly-note.create'],
    checkContext:async({sourceRevision})=>sourceRevision===revision&&await checkContext(),
    execute:({payload,idempotencyKey})=>serial(async()=>{
      await context();const state=await read(),previous=state.records.find(r=>r.id===idempotencyKey);
      if(!previous){if(state.records.length>=1000)throw fail('WRITE_STORE_LIMIT');state.records.push({id:idempotencyKey,month:payload.month,note:payload.note,createdAt:new Date().toISOString()});await context();await save(state);}
      return {completed:true,idempotencyKey,receiptId:'synthetic-note-'+idempotencyKey};
    }),
    reconcile:({idempotencyKey})=>serial(async()=>{await context();return (await read()).records.some(r=>r.id===idempotencyKey)?{completed:true,idempotencyKey,receiptId:'synthetic-note-'+idempotencyKey}:null;})
  });
  return {
    async snapshot(){await context();const records=await serial(async()=>structuredClone((await read()).records));const approvals=await ledger.list();await context();return {records,approvals};},
    async preview(input){
      if(!input||Object.keys(input).some(k=>!['month','note'].includes(k))||!/^2026-(09|10)$/.test(input.month)||typeof input.note!=='string'||!input.note.trim()||input.note.length>300||/[\u0000-\u001f]|(?:password|api.?key|token|密码|密钥)\s*[:：=]/i.test(input.note))throw fail('WRITE_INPUT_INVALID');
      const preview=await ledger.preview({operation:'synthetic.monthly-note.create',siteId:'site-local-demo',sourceRevision:revision,payload:{month:input.month,note:input.note.trim()}});
      return {...preview,fingerprint:await ledger.confirmationFingerprint(preview.id)};
    },
    confirm:input=>ledger.confirm(input),
    inspect:id=>ledger.inspect(id)
  };
}
