import {cp,mkdir,readdir,readFile,writeFile,lstat} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {join,dirname,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const applicationFiles=['src','scripts','docs','README.md','package.json'];
const deploymentExamples=new Set(['service.example.json','Caddyfile.example','yuanyu.service.example']);
async function approvedDeployFiles(projectDir){
  const directory=join(projectDir,'deploy');let info;try{info=await lstat(directory);}catch(error){if(error.code==='ENOENT')return [];throw error;}
  if(!info.isDirectory()||info.isSymbolicLink())throw new Error('PACKAGE_SYMLINK_DENIED');
  const names=await readdir(directory);
  for(const name of names){if(!deploymentExamples.has(name))throw new Error('PACKAGE_DEPLOY_FILE_DENIED');const stat=await lstat(join(directory,name));if(!stat.isFile()||stat.isSymbolicLink())throw new Error('PACKAGE_SYMLINK_DENIED');}
  return names;
}
async function files(dir){const result=[];for(const entry of await readdir(dir,{withFileTypes:true})){const file=join(dir,entry.name);if((await lstat(file)).isSymbolicLink())throw new Error('PACKAGE_SYMLINK_DENIED');if(entry.isDirectory())result.push(...await files(file));else result.push(file);}return result;}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function verifyPackage(directory){const appRoot=join(directory,'resources','app'),manifest=JSON.parse(await readFile(join(appRoot,'package-manifest.json'),'utf8'));if(manifest.schemaVersion!==1 || manifest.signature!=='unsigned-development' || !Array.isArray(manifest.files))throw new Error('PACKAGE_MANIFEST_INVALID');for(const entry of manifest.files){const target=resolve(appRoot,entry.path),rel=relative(appRoot,target);if(!rel || rel.startsWith('..') || isAbsolute(rel) || (await lstat(target)).isSymbolicLink() || sha(await readFile(target))!==entry.sha256)throw new Error('PACKAGE_HASH_MISMATCH');}return {version:manifest.version,files:manifest.files.length,signature:manifest.signature};}
export async function buildPortable({projectDir=root,electronDist=join(root,'node_modules','electron','dist'),outputDir=join(root,'output','portable')}={}) {
  const deployFiles=await approvedDeployFiles(projectDir);
  const pkg=JSON.parse(await readFile(join(projectDir,'package.json'),'utf8'));const target=join(outputDir,`YuanyuWorkbench-${pkg.version}-${process.platform}-${process.arch}-${randomUUID().slice(0,8)}`);
  await mkdir(outputDir,{recursive:true});await cp(electronDist,target,{recursive:true,force:false,errorOnExist:true});
  const appRoot=join(target,'resources','app');await mkdir(appRoot,{recursive:true});
  for(const name of applicationFiles)await cp(join(projectDir,name),join(appRoot,name),{recursive:true,force:false,errorOnExist:true});
  for(const name of ['LICENSE','NOTICE']){let info;try{info=await lstat(join(projectDir,name));}catch(error){if(error.code==='ENOENT')continue;throw error;}if(!info.isFile()||info.isSymbolicLink())throw new Error('PACKAGE_SYMLINK_DENIED');await cp(join(projectDir,name),join(appRoot,name),{force:false,errorOnExist:true});}
  if(deployFiles.length){await mkdir(join(appRoot,'deploy'));for(const name of deployFiles)await cp(join(projectDir,'deploy',name),join(appRoot,'deploy',name),{force:false,errorOnExist:true});}
  const manifest={schemaVersion:1,product:'元域个人工作台',version:pkg.version,signature:'unsigned-development',createdAt:new Date().toISOString(),files:[]};
  for(const file of await files(appRoot))manifest.files.push({path:relative(appRoot,file).replaceAll('\\','/'),sha256:sha(await readFile(file))});
  if(manifest.files.some(entry=>/(?:^|\/)(?:data|node_modules|output|\.git|credentials)|\.local\.json$|\.key$/i.test(entry.path)))throw new Error('PACKAGE_PRIVATE_FILE_DENIED');
  await writeFile(join(appRoot,'package-manifest.json'),JSON.stringify(manifest,null,2)+'\n');await verifyPackage(target);
  return {directory:target,executable:join(target,process.platform==='win32'?'electron.exe':'electron'),files:manifest.files.length,signature:manifest.signature};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{const result=await buildPortable();await writeFile(join(root,'output','portable-latest.json'),JSON.stringify(result,null,2)+'\n');console.log(`便携开发版已生成：${result.directory}\n校验${result.files}个应用文件，未包含账号和运行数据；尚未做产品签名。`);}catch(error){console.error(error.code || error.message);process.exitCode=1;}
}
