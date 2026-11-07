import {DatabaseSync} from 'node:sqlite';
import {constants} from 'node:fs';
import {mkdir,lstat,realpath,readFile,writeFile,copyFile,chmod,readdir,rm,rmdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isAbsolute,resolve,relative,dirname,basename,join,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const REPOSITORY=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const DATABASE='promotion.sqlite',MANIFEST='service-backup.json',MAX_BYTES=128*1024*1024;
const fail=code=>Object.assign(new Error(code),{code});
const requireValue=(condition,code)=>{if(!condition)throw fail(code);};
const inside=(base,target)=>{const path=relative(base,target);return !path||!isAbsolute(path)&&path!=='..'&&!path.startsWith('..'+sep);};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const closed=(value,names)=>plain(value)&&Object.keys(value).every(key=>names.includes(key))&&names.every(key=>Object.hasOwn(value,key));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const columns={
  accounts:['id','email','display_name','salt','password_hash','verified','enabled','created_at'],
  sessions:['token_hash','account_id','expires_at','revoked'],
  verification:['account_id','code_hash','expires_at','attempts'],
  auth_rates:['rate_key','bucket','count'],
  service_settings:['setting_key','value'],
  quota:['account_id','month','used','reserved'],
  daily:['account_id','day','count'],
  requests:['account_id','request_id','payload_hash','month','day','reserved','status','response_json','error_status','error_code','created_at','owner_pid','owner_instance']
};

// These are trusted local operator tools. No key/config file or browser state is copied.
async function safePath(input){
  requireValue(typeof input==='string'&&isAbsolute(input)&&!input.includes('\0'),'SERVICE_BACKUP_PATH_INVALID');
  const requested=resolve(input),repo=await realpath(REPOSITORY);
  requireValue(!inside(repo,requested),'SERVICE_BACKUP_PATH_INVALID');
  for(let current=requested;;current=dirname(current)){
    try{requireValue(!(await lstat(current)).isSymbolicLink(),'SERVICE_BACKUP_SYMLINK_DENIED');}
    catch(error){if(error.code!=='ENOENT')throw error;}
    if(dirname(current)===current)break;
  }
  const suffix=[];let ancestor=requested;
  while(true){
    try{
      const canonical=join(await realpath(ancestor),...suffix);
      requireValue(!inside(repo,canonical),'SERVICE_BACKUP_PATH_INVALID');return canonical;
    }catch(error){if(error.code!=='ENOENT')throw error;suffix.unshift(basename(ancestor));ancestor=dirname(ancestor);}
  }
}
async function directory(input){const target=await safePath(input);requireValue((await lstat(target)).isDirectory(),'SERVICE_BACKUP_PATH_INVALID');return target;}
async function newDirectory(input){
  const target=await safePath(input);
  try{await lstat(target);throw fail('SERVICE_BACKUP_TARGET_EXISTS');}catch(error){if(error.code!=='ENOENT')throw error;}
  requireValue((await lstat(dirname(target))).isDirectory(),'SERVICE_BACKUP_PATH_INVALID');return target;
}
async function regularFile(file,max=MAX_BYTES){
  const stat=await lstat(file);requireValue(!stat.isSymbolicLink()&&stat.isFile(),'SERVICE_BACKUP_SYMLINK_DENIED');
  requireValue(stat.size>0&&stat.size<=max,'SERVICE_BACKUP_TOO_LARGE');return stat;
}
async function cleanup(target){
  // Only files created by this operation are removed; never recursively delete a computed directory.
  for(const name of [DATABASE,MANIFEST,DATABASE+'-wal',DATABASE+'-shm',DATABASE+'-journal'])await rm(join(target,name),{force:true}).catch(()=>{});
  await rmdir(target).catch(()=>{});
}
function checkDatabase(db){
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;');
  const pageCount=Number(Object.values(db.prepare('PRAGMA page_count').get())[0]),pageSize=Number(Object.values(db.prepare('PRAGMA page_size').get())[0]);
  requireValue(Number.isSafeInteger(pageCount)&&Number.isSafeInteger(pageSize)&&pageCount>0&&pageSize>0&&pageCount*pageSize<=MAX_BYTES,'SERVICE_BACKUP_TOO_LARGE');
  const checks=db.prepare('PRAGMA integrity_check').all();
  requireValue(checks.length===1&&Object.values(checks[0])[0]==='ok','SERVICE_BACKUP_DATABASE_INVALID');
  requireValue(db.prepare('PRAGMA foreign_key_check').all().length===0,'SERVICE_BACKUP_DATABASE_INVALID');
  const objects=db.prepare("SELECT name,type FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all();
  requireValue(!objects.some(object=>['trigger','view'].includes(object.type)),'SERVICE_BACKUP_DATABASE_INVALID');
  const tables=objects.filter(object=>object.type==='table').map(object=>object.name).sort();
  requireValue(JSON.stringify(tables)===JSON.stringify(Object.keys(columns).sort()),'SERVICE_BACKUP_DATABASE_INVALID');
  for(const [table,names]of Object.entries(columns)){
    const actual=db.prepare(`PRAGMA table_info(${table})`).all().map(column=>column.name);
    requireValue(JSON.stringify(actual)===JSON.stringify(names),'SERVICE_BACKUP_DATABASE_INVALID');
  }
}
function safeFailure(error){return error?.code?.startsWith('SERVICE_BACKUP_')?error:fail('SERVICE_BACKUP_OPERATION_FAILED');}

/** SQLite VACUUM INTO is a consistent snapshot even while another connection owns a live WAL. */
export async function backupService({dataDir,backupDir}){
  let target,created=false,db;
  try{
    const source=await directory(dataDir);target=await newDirectory(backupDir);
    requireValue(!inside(source,target)&&!inside(target,source),'SERVICE_BACKUP_PATH_INVALID');
    const sourceFile=join(source,DATABASE);await regularFile(sourceFile);
    db=new DatabaseSync(sourceFile,{readOnly:true,timeout:1000});checkDatabase(db);
    await mkdir(target,{mode:0o700});created=true;
    db.exec('PRAGMA synchronous=FULL');
    db.prepare('VACUUM INTO ?').run(join(target,DATABASE));db.close();db=undefined;
    const snapshot=join(target,DATABASE);await regularFile(snapshot);await chmod(snapshot,0o600);
    db=new DatabaseSync(snapshot,{readOnly:true,timeout:1000});checkDatabase(db);db.close();db=undefined;
    const bytes=await readFile(snapshot),createdAt=new Date().toISOString();
    const manifest={schemaVersion:1,kind:'yuanyu-account-service',createdAt,method:'sqlite-vacuum-into',database:{name:DATABASE,bytes:bytes.length,sha256:sha(bytes)},externalSecretsIncluded:false};
    await writeFile(join(target,MANIFEST),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
    return {directory:target,files:2,bytes:bytes.length,createdAt,snapshot:'consistent'};
  }catch(error){db?.close();if(created)await cleanup(target);throw safeFailure(error);}
}

/** Restore to an exclusive new directory; never revive old sessions or replay uncertain provider calls. */
export async function restoreService({backupDir,targetDir}){
  let target,created=false,db;
  try{
    const source=await directory(backupDir);target=await newDirectory(targetDir);
    requireValue(!inside(source,target)&&!inside(target,source),'SERVICE_BACKUP_PATH_INVALID');
    requireValue(JSON.stringify((await readdir(source)).sort())===JSON.stringify([DATABASE,MANIFEST].sort()),'SERVICE_BACKUP_MANIFEST_INVALID');
    const manifestFile=join(source,MANIFEST);await regularFile(manifestFile,16384);
    let manifest;try{manifest=JSON.parse(await readFile(manifestFile,'utf8'));}catch{throw fail('SERVICE_BACKUP_MANIFEST_INVALID');}
    requireValue(closed(manifest,['schemaVersion','kind','createdAt','method','database','externalSecretsIncluded'])&&manifest.schemaVersion===1&&manifest.kind==='yuanyu-account-service'&&manifest.method==='sqlite-vacuum-into'&&manifest.externalSecretsIncluded===false&&typeof manifest.createdAt==='string'&&Number.isFinite(Date.parse(manifest.createdAt))&&closed(manifest.database,['name','bytes','sha256'])&&manifest.database.name===DATABASE&&Number.isSafeInteger(manifest.database.bytes)&&manifest.database.bytes>0&&manifest.database.bytes<=MAX_BYTES&&typeof manifest.database.sha256==='string'&&/^[a-f0-9]{64}$/.test(manifest.database.sha256),'SERVICE_BACKUP_MANIFEST_INVALID');
    const sourceFile=join(source,DATABASE);await regularFile(sourceFile);
    const bytes=await readFile(sourceFile);
    requireValue(bytes.length===manifest.database.bytes&&sha(bytes)===manifest.database.sha256,'SERVICE_BACKUP_HASH_MISMATCH');
    await mkdir(target,{mode:0o700});created=true;
    const restored=join(target,DATABASE);await copyFile(sourceFile,restored,constants.COPYFILE_EXCL);await chmod(restored,0o600);
    // Validate the copied bytes too, so a source mutation between verification and copy cannot pass.
    requireValue(sha(await readFile(restored))===manifest.database.sha256,'SERVICE_BACKUP_HASH_MISMATCH');
    db=new DatabaseSync(restored,{timeout:1000});checkDatabase(db);db.exec('PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; BEGIN IMMEDIATE;');
    let sessionsRevoked,requestsUncertain;
    try{
      sessionsRevoked=Number(db.prepare('UPDATE sessions SET revoked=1 WHERE revoked<>1').run().changes);
      db.exec('DELETE FROM verification');
      requestsUncertain=Number(db.prepare("UPDATE requests SET status='uncertain',response_json=NULL,error_status=409,error_code='REQUEST_UNCERTAIN',owner_pid=NULL,owner_instance=NULL WHERE status='pending'").run().changes);
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    checkDatabase(db);db.close();db=undefined;
    return {directory:target,files:1,sessionsRevoked,requestsUncertain,requiresLogin:true};
  }catch(error){db?.close();if(created)await cleanup(target);throw safeFailure(error);}
}
