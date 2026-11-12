import {mkdir,readdir,lstat,realpath,readFile,writeFile,rename} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';import {isAbsolute,relative,resolve,join,dirname,basename,sep} from 'node:path';import {fileURLToPath} from 'node:url';
import {validateProfile} from '../model/gateway.mjs';
import {pauseRestoredMemory} from '../memory/store.mjs';
const repo=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const fail=code=>Object.assign(new Error(code),{code});const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(base,target)=>{const path=relative(base,target);return !path||path!=='..'&&!path.startsWith(`..${sep}`)&&!isAbsolute(path);};
const permitted=path=>path==='.publication-key'||/^(companies|outputs|sites|write-approvals)\//.test(path)||/^models\/[^/]+\/[^/]+\/model\.local\.json$/.test(path)||/^(demo-source|agents|memory)\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}\/state\.json$/.test(path);
async function safeDirectory(path){if(typeof path!=='string'||!isAbsolute(path)||inside(repo,resolve(path)))throw fail('BACKUP_PATH_INVALID');for(let item=resolve(path);;item=dirname(item)){try{if((await lstat(item)).isSymbolicLink())throw fail('BACKUP_SYMLINK_DENIED');}catch(error){if(error.code!=='ENOENT')throw error;}if(dirname(item)===item)break;}const suffix=[];let ancestor=resolve(path);while(true){try{const canonical=join(await realpath(ancestor),...suffix);if(inside(repo,canonical))throw fail('BACKUP_PATH_INVALID');return canonical;}catch(error){if(error.code!=='ENOENT')throw error;suffix.unshift(basename(ancestor));ancestor=dirname(ancestor);}}}
async function walk(root){const files=[];async function visit(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const file=join(dir,entry.name),path=relative(root,file).replaceAll('\\','/');if(path.split('/').length===1&&!['companies','outputs','sites','models','write-approvals','agents','demo-source','memory','.publication-key'].includes(path))continue;const stat=await lstat(file);if(stat.isSymbolicLink())throw fail('BACKUP_SYMLINK_DENIED');if(stat.isDirectory())await visit(file);else if(stat.isFile()&&permitted(path))files.push({path,file});if(files.length>1000)throw fail('BACKUP_TOO_LARGE');}}await visit(root);return files;}
/** Caller must quiesce the single-process workspace, including its agent runner. Agent state alone is included, never browser cookies, locks or external model key files. */
export async function backupWorkspace({dataDir,backupDir}) {
  const source=await realpath(await safeDirectory(dataDir)),target=await safeDirectory(backupDir);if(inside(source,target)||inside(target,source))throw fail('BACKUP_PATH_INVALID');
  const entries=await walk(source);
  for(const entry of entries.filter(item=>item.path.startsWith('models/'))){const bytes=await readFile(entry.file);if(bytes.length>16384)throw fail('BACKUP_MODEL_CONFIG_INVALID');const config=validateProfile(JSON.parse(bytes.toString('utf8')));if(typeof config.apiKeyFile==='string'&&isAbsolute(config.apiKeyFile)){const keyPath=join(await safeDirectory(dirname(config.apiKeyFile)),basename(config.apiKeyFile));if(inside(source,keyPath)&&!relative(source,keyPath).replaceAll('\\','/').startsWith('models/'))throw fail('BACKUP_KEY_PATH_CONFLICT');}}
  await mkdir(target,{recursive:false,mode:0o700});let total=0;const manifest={schemaVersion:1,sourceRoot:source,createdAt:new Date().toISOString(),platform:process.platform,credentialProtection:'os-user-bound',files:[]};
  for(const entry of entries){const bytes=await readFile(entry.file);total+=bytes.byteLength;if(total>50*1024*1024)throw fail('BACKUP_TOO_LARGE');const destination=join(target,entry.path);await mkdir(dirname(destination),{recursive:true,mode:0o700});await writeFile(destination,bytes,{flag:'wx',mode:0o600});manifest.files.push({path:entry.path,sha256:sha(bytes),bytes:bytes.length});}
  for(const entry of manifest.files)if(sha(await readFile(join(source,entry.path)))!==entry.sha256)throw fail('BACKUP_SOURCE_CHANGED');
  await writeFile(join(target,'backup-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});return {directory:target,files:manifest.files.length,bytes:total,credentialProtection:manifest.credentialProtection};
}
export async function restoreWorkspace({backupDir,targetDir}) {
  const backup=await realpath(await safeDirectory(backupDir)),target=await safeDirectory(targetDir);if(inside(backup,target)||inside(target,backup))throw fail('BACKUP_PATH_INVALID');
  const manifest=JSON.parse(await readFile(join(backup,'backup-manifest.json'),'utf8'));if(manifest.schemaVersion!==1||!isAbsolute(manifest.sourceRoot)||!Array.isArray(manifest.files)||manifest.files.length>1000||manifest.credentialProtection!=='os-user-bound')throw fail('BACKUP_MANIFEST_INVALID');
  try{await lstat(target);throw fail('RESTORE_TARGET_EXISTS');}catch(error){if(error.code!=='ENOENT')throw error;}
  const staged=[];let size=0;const seen=new Set();
  for(const entry of manifest.files){if(typeof entry.path!=='string'||!permitted(entry.path)||seen.has(entry.path)||entry.path.includes('\\')||entry.path.split('/').some(part=>['','..','.'].includes(part))||isAbsolute(entry.path))throw fail('BACKUP_MANIFEST_INVALID');seen.add(entry.path);const file=join(backup,entry.path);await safeDirectory(dirname(file));if((await lstat(file)).isSymbolicLink())throw fail('BACKUP_SYMLINK_DENIED');const bytes=await readFile(file);size+=bytes.length;if(size>50*1024*1024||bytes.length!==entry.bytes||sha(bytes)!==entry.sha256)throw fail('BACKUP_HASH_MISMATCH');staged.push({path:entry.path,bytes});}
  const staging=target+`.restoring-${randomUUID()}`;await mkdir(staging,{recursive:false,mode:0o700});
  for(const entry of staged){let bytes=entry.bytes;if(/^companies\/[^/]+\/users\/[^/]+\/state\.json$/.test(entry.path)){
      const state=JSON.parse(bytes.toString('utf8'));for(const run of state.runs||[]){if(run.artifact)for(const key of ['path','sourcePath'])if(run.artifact[key]){const original=join(await safeDirectory(dirname(resolve(run.artifact[key]))),basename(run.artifact[key]));if(!inside(manifest.sourceRoot,original))throw fail('BACKUP_ARTIFACT_INVALID');run.artifact[key]=join(target,relative(manifest.sourceRoot,original));}}bytes=Buffer.from(JSON.stringify(state,null,2)+'\n');
    }
    const file=join(staging,entry.path);await mkdir(dirname(file),{recursive:true,mode:0o700});await writeFile(file,bytes,{flag:'wx',mode:0o600});
    if(entry.path.startsWith('memory/'))await pauseRestoredMemory({file});
  }
  await rename(staging,target);return {directory:target,files:staged.length,credentialProtection:'os-user-bound',note:'凭据仍绑定原操作系统用户，跨机器或用户需重新录入。'};
}
