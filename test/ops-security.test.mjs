import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {runServiceAdmin} from '../scripts/service-admin.mjs';
import {resetAccountPassword} from '../src/service/account-admin.mjs';
import {buildPortable} from '../scripts/pack.mjs';

const password='synthetic-ops-replacement-password',email='ops-security@example.invalid';
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'yuanyu-ops-security-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const real=join(root,'real'),dataDir=join(real,'data');await mkdir(dataDir,{recursive:true});
  const file=join(dataDir,'promotion.sqlite'),db=new DatabaseSync(file);
  db.exec('CREATE TABLE accounts(id TEXT PRIMARY KEY,email TEXT,salt TEXT,password_hash TEXT,enabled INTEGER,verified INTEGER);CREATE TABLE sessions(account_id TEXT,revoked INTEGER);CREATE TABLE verification(account_id TEXT);CREATE TABLE quota(account_id TEXT,used INTEGER,reserved INTEGER);');
  db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,?)').run('synthetic-ops',email,'unchanged-salt','unchanged-hash',1,0);
  db.prepare('INSERT INTO sessions VALUES(?,?)').run('synthetic-ops',0);db.prepare('INSERT INTO quota VALUES(?,?,?)').run('synthetic-ops',123,456);db.close();
  const alias=join(root,'alias');
  try{await symlink(real,alias,process.platform==='win32'?'junction':'dir');}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('OS account cannot create path-link test fixture');return null;}throw error;}
  const original=()=>{const value=new DatabaseSync(file,{readOnly:true});try{return value.prepare('SELECT password_hash FROM accounts').get().password_hash;}finally{value.close();}};
  return {root,real,dataDir,alias,original};
}

test('admin接线不能在canonicalize之后丢失dataDir父目录链接信息',async t=>{
  const f=await fixture(t);if(!f)return;
  const aliasDir=join(f.alias,'data');
  await assert.rejects(resetAccountPassword({dataDir:aliasDir,email,password}),/ADMIN_PATH_INVALID/);
  await assert.rejects(runServiceAdmin(['reset-password',email],{env:{YUANYU_PROMOTION_DATA_DIR:aliasDir},passwordInput:password}),/ADMIN_PATH_INVALID/);
  assert.equal(f.original(),'unchanged-hash');
});

test('admin配置经链接祖先访问也必须在读取前拒绝',async t=>{
  const f=await fixture(t);if(!f)return;
  await writeFile(join(f.real,'service.json'),JSON.stringify({dataDir:f.dataDir}));
  await assert.rejects(runServiceAdmin(['reset-password',email],{env:{YUANYU_PROMOTION_CONFIG:join(f.alias,'service.json')},passwordInput:password}),/ADMIN_(?:CONFIG|PATH)_INVALID/);
  assert.equal(f.original(),'unchanged-hash');
});

test('便携包只带部署样例，不复制deploy中误放的实际运营配置',async t=>{
  const root=await mkdtemp(join(tmpdir(),'yuanyu-deploy-package-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const projectDir=join(root,'project'),electronDist=join(root,'runtime'),outputDir=join(root,'out');
  for(const dir of ['src','scripts','docs','deploy'])await mkdir(join(projectDir,dir),{recursive:true});await mkdir(electronDist);
  await writeFile(join(electronDist,'electron.exe'),'synthetic runtime');await writeFile(join(projectDir,'README.md'),'synthetic package');await writeFile(join(projectDir,'package.json'),JSON.stringify({name:'synthetic',version:'0.1.0'}));
  await writeFile(join(projectDir,'src','main.mjs'),'// synthetic entry');
  await writeFile(join(projectDir,'deploy','service.example.json'),'{}');
  await writeFile(join(projectDir,'deploy','service.json'),'{"apiKey":"synthetic-server-secret-must-not-package"}');
  let result;
  try{result=await buildPortable({projectDir,electronDist,outputDir});}
  catch(error){assert.match(error.message,/PACKAGE_(?:PRIVATE_FILE_DENIED|DEPLOY_FILE_DENIED)/);return;}
  await assert.rejects(access(join(result.directory,'resources','app','deploy','service.json')),error=>error.code==='ENOENT');
  assert.equal(await readFile(join(result.directory,'resources','app','deploy','service.example.json'),'utf8'),'{}');
});
