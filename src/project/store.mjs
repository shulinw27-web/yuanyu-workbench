import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {isAccountIdentity} from '../core/identity.mjs';

const REPOSITORY=path.resolve(fileURLToPath(new URL('../..',import.meta.url)));
const MAX_BYTES=2_000_000,LOCKS=new Set();let queue=Promise.resolve();
const MAX_PROJECTS=200;
const ORIGINS=new Set(['empty','folder']);
const inside=(base,target)=>{const relative=path.relative(base,target);return !relative||!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith(`..${path.sep}`);};
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
function projectError(code){const error=new Error(code);error.code=code;return error;}
const assert=(condition,code)=>{if(!condition)throw projectError(code);};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function fields(value,allowed){assert(plain(value)&&Object.keys(value).every(key=>allowed.includes(key)),'PROJECT_INPUT_INVALID');}
function string(value,max=200,min=1){assert(typeof value==='string'&&value.length>=min&&value.length<=max&&!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value),'PROJECT_INPUT_INVALID');return value;}
function name(value){const result=string(value,100).trim();assert(result.length>0,'PROJECT_INPUT_INVALID');return result;}
/** 路径安全：绝对路径、仓库外、链路无符号链接，并返回规范化后的真实路径（允许尚不存在的末段）。 */
async function safeRoot(input){
  assert(typeof input==='string'&&path.isAbsolute(input)&&!inside(REPOSITORY,path.resolve(input)),'PROJECT_UNSAFE_PATH');
  for(let current=path.resolve(input);;current=path.dirname(current)){try{assert(!(await fs.lstat(current)).isSymbolicLink(),'PROJECT_UNSAFE_PATH');}catch(error){if(error.code!=='ENOENT')throw error;}if(path.dirname(current)===current)break;}
  const suffix=[];let ancestor=path.resolve(input);
  while(true){try{const result=path.join(await fs.realpath(ancestor),...suffix);assert(!inside(REPOSITORY,result),'PROJECT_UNSAFE_PATH');return result;}catch(error){if(error.code!=='ENOENT')throw error;suffix.unshift(path.basename(ancestor));ancestor=path.dirname(ancestor);}}
}
async function readState(file){try{const stat=await fs.lstat(file);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=MAX_BYTES,'PROJECT_UNSAFE_PATH');return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;if(error.code==='PROJECT_UNSAFE_PATH')throw error;throw projectError('PROJECT_STORE_INVALID');}}
function validateProject(project){
  try{
    fields(project,['id','name','root','origin','createdAt','updatedAt','lastOpenedAt']);
    assert(typeof project.id==='string'&&project.id.length>=16&&project.id.length<=64,'PROJECT_STORE_INVALID');
    name(project.name);string(project.root,2000);
    assert(path.isAbsolute(project.root)&&!inside(REPOSITORY,path.resolve(project.root)),'PROJECT_STORE_INVALID');
    assert(ORIGINS.has(project.origin),'PROJECT_STORE_INVALID');
    assert(iso(project.createdAt)&&iso(project.updatedAt)&&(project.lastOpenedAt===null||iso(project.lastOpenedAt)),'PROJECT_STORE_INVALID');
  }catch(error){if(error.code==='PROJECT_INPUT_INVALID'||error.code==='PROJECT_UNSAFE_PATH')throw projectError('PROJECT_STORE_INVALID');throw error;}
}
function validateState(state,owner){
  try{
    fields(state,['schemaVersion','companyId','userId','revision','projects','currentId']);
    assert(state.schemaVersion===1&&state.companyId===owner.companyId&&state.userId===owner.userId,'PROJECT_STORE_INVALID');
    assert(Number.isSafeInteger(state.revision)&&state.revision>=1,'PROJECT_STORE_INVALID');
    assert(Array.isArray(state.projects)&&state.projects.length<=MAX_PROJECTS,'PROJECT_STORE_INVALID');
    const roots=new Set();
    for(const project of state.projects){validateProject(project);assert(!roots.has(project.root),'PROJECT_STORE_INVALID');roots.add(project.root);}
    assert(state.currentId===null||state.projects.some(project=>project.id===state.currentId),'PROJECT_STORE_INVALID');
    assert(new Set(state.projects.map(project=>project.id)).size===state.projects.length,'PROJECT_STORE_INVALID');
  }catch{throw projectError('PROJECT_STORE_INVALID');}
}
async function atomicWrite(file,state){const encoded=JSON.stringify(state,null,2)+'\n';assert(Buffer.byteLength(encoded)<=MAX_BYTES,'PROJECT_LIMIT');const temporary=path.join(path.dirname(file),`.project-${randomUUID()}.tmp`);let handle;try{handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(encoded);await handle.sync();await handle.close();handle=null;await fs.rename(temporary,file);}finally{await handle?.close().catch(()=>{});await fs.rm(temporary,{force:true}).catch(()=>{});}}
const lockHolderImage=pid=>{try{const listing=spawnSync('tasklist',['/FI',`PID eq ${pid}`,'/FO','CSV','/NH'],{encoding:'utf8',timeout:5000});return listing.stdout?.trim().split(/\r?\n/)[0]?.match(/^"([^"]+)"/)?.[1]?.toLowerCase()??'';}catch{return '';}};
/** 存活校验：pid 存活时在 Windows 上比对映像名，防止退出进程的 PID 被系统进程复用造成永久假锁。 */
const holderAlive=async lock=>{
  let alive=true;try{process.kill(lock.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;}
  if(!alive)return false;if(process.platform!=='win32')return true;
  const expected=(typeof lock.image==='string'&&lock.image.trim()!==''?lock.image:path.basename(process.execPath)).toLowerCase();
  const observed=lockHolderImage(lock.pid);return observed===''||observed===expected;
};
async function writableRoot(root){await fs.mkdir(root,{recursive:true,mode:0o700});await safeRoot(root);const key=process.platform==='win32'?root.toLowerCase():root;if(LOCKS.has(key))return;const lock=path.join(root,'.project-store.lock'),previous=await readState(lock);if(previous){assert(Number.isSafeInteger(previous.pid)&&previous.pid>0,'PROJECT_LOCKED');assert(!await holderAlive(previous),'PROJECT_LOCKED');await fs.rm(lock);}let handle;try{handle=await fs.open(lock,'wx',0o600);await handle.writeFile(JSON.stringify({pid:process.pid,image:path.basename(process.execPath)}));await handle.sync();LOCKS.add(key);}catch(error){if(error.code==='EEXIST')throw projectError('PROJECT_LOCKED');throw error;}finally{await handle?.close();}}

/** 项目记录只保存目录登记信息；删除项目从不触碰用户文件。仅可信主进程可调用。 */
export function createProjectStore({dataDir,identity,now=Date.now}={}){
  assert(typeof dataDir==='string'&&path.isAbsolute(dataDir)&&!inside(REPOSITORY,path.resolve(dataDir)),'PROJECT_UNSAFE_PATH');
  const mock={alice:'mock-acme',bob:'mock-acme',outsider:'mock-other'};
  assert(isAccountIdentity(identity)||identity?.provider==='mock'&&Object.hasOwn(mock,identity.userId)&&mock[identity.userId]===identity.companyId,'PROJECT_IDENTITY_INVALID');
  const owner={companyId:string(identity.companyId,100),userId:string(identity.userId,100)};
  assert(typeof now==='function','PROJECT_INPUT_INVALID');
  const timestamp=()=>{const value=now();assert(Number.isFinite(value)&&value>=0,'PROJECT_INPUT_INVALID');return value;};
  const operation=callback=>{const pending=queue.then(async()=>{
    const root=await safeRoot(dataDir),file=path.join(root,'projects',owner.companyId,owner.userId,'state.json');
    const state=await readState(file)??{schemaVersion:1,...owner,revision:1,projects:[],currentId:null};
    validateState(state,owner);
    const commit=async()=>{await writableRoot(root);await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});state.revision++;validateState(state,owner);await atomicWrite(file,state);};
    return callback(state,commit);
  });queue=pending.catch(()=>{});return pending;};
  const find=(state,id)=>{assert(typeof id==='string','PROJECT_INPUT_INVALID');const project=state.projects.find(entry=>entry.id===id);assert(project,'PROJECT_NOT_FOUND');return project;};
  const cas=(state,revision)=>assert(Number.isSafeInteger(revision)&&state.revision===revision,'PROJECT_VERSION_CONFLICT');
  const casOptional=(state,revision)=>{if(revision!==undefined)cas(state,revision);};
  const view=project=>({...project});
  const addProject=(state,record)=>{
    assert(!state.projects.some(entry=>entry.root===record.root),'PROJECT_DUPLICATE');
    assert(state.projects.length<MAX_PROJECTS,'PROJECT_LIMIT');
    state.projects.push(record);
  };
  return Object.freeze({
    snapshot:()=>operation(state=>({revision:state.revision,projects:state.projects.map(view),currentId:state.currentId})),
    getRevision:()=>operation(state=>state.revision),
    createEmpty(input){return operation(async(state,commit)=>{
      fields(input,['name','root','expectedRevision']);casOptional(state,input.expectedRevision);
      const projectName=name(input.name),root=await safeRoot(string(input.root,2000));
      let occupied=false;try{occupied=(await fs.readdir(root)).length>0;}catch(error){if(error.code!=='ENOENT')throw error;}
      assert(!occupied,'PROJECT_DIRECTORY_NOT_EMPTY');
      const at=new Date(timestamp()).toISOString();
      const record={id:randomUUID(),name:projectName,root,origin:'empty',createdAt:at,updatedAt:at,lastOpenedAt:at};
      addProject(state,record);
      await fs.mkdir(root,{recursive:true});
      assert(await fs.realpath(root)===root,'PROJECT_UNSAFE_PATH');
      state.currentId=record.id;
      await commit();return view(record);
    });},
    importFolder(input){return operation(async(state,commit)=>{
      fields(input,['name','root','expectedRevision']);casOptional(state,input.expectedRevision);
      const root=await safeRoot(string(input.root,2000));
      const stat=await fs.stat(root).catch(error=>{if(error.code==='ENOENT')throw projectError('PROJECT_DIRECTORY_MISSING');throw error;});
      assert(stat.isDirectory(),'PROJECT_DIRECTORY_MISSING');
      assert(await fs.realpath(root)===root,'PROJECT_UNSAFE_PATH');
      const projectName=input.name===undefined?path.basename(root):name(input.name);
      const at=new Date(timestamp()).toISOString();
      const record={id:randomUUID(),name:projectName,root,origin:'folder',createdAt:at,updatedAt:at,lastOpenedAt:at};
      addProject(state,record);state.currentId=record.id;
      await commit();return view(record);
    });},
    rename(input){return operation(async(state,commit)=>{
      fields(input,['id','name','expectedRevision']);cas(state,input.expectedRevision);
      const project=find(state,input.id);
      const projectName=name(input.name);
      if(project.name!==projectName){project.name=projectName;project.updatedAt=new Date(timestamp()).toISOString();await commit();}
      return view(project);
    });},
    setCurrent(input){return operation(async(state,commit)=>{
      fields(input,['id','expectedRevision']);cas(state,input.expectedRevision);
      if(input.id===null){if(state.currentId!==null){state.currentId=null;await commit();}return {currentId:null};}
      const project=find(state,input.id);
      project.lastOpenedAt=new Date(timestamp()).toISOString();
      if(state.currentId!==project.id)state.currentId=project.id;
      await commit();return {currentId:project.id};
    });},
    remove(input){return operation(async(state,commit)=>{
      fields(input,['id','expectedRevision']);cas(state,input.expectedRevision);
      const project=find(state,input.id);
      state.projects=state.projects.filter(entry=>entry.id!==project.id);
      if(state.currentId===project.id)state.currentId=null;
      await commit();return {deleted:true,id:project.id,revision:state.revision};
    });},
  });
}
