import {readFile,realpath,lstat} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {homedir} from 'node:os';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {backupService,restoreService} from '../src/service/backup.mjs';
import {resetAccountPassword,readAdminPassword} from '../src/service/account-admin.mjs';

const ROOT=resolve(fileURLToPath(new URL('..',import.meta.url)));
const fail=code=>Object.assign(new Error(code),{code});
const outside=file=>{const offset=relative(ROOT,file);return !!offset&&(isAbsolute(offset)||offset==='..'||offset.startsWith('..'+sep));};
const number=(value,max)=>{if(!/^(?:0|[1-9]\d*)$/.test(value??''))throw fail('ADMIN_ARGUMENT_INVALID');const parsed=Number(value);if(!Number.isSafeInteger(parsed)||parsed>max)throw fail('ADMIN_ARGUMENT_INVALID');return parsed;};
const commands=new Set(['list','verify','disable','enable','revoke','quota','budget','backup','restore','reset-password']);
async function noLinks(path,code){for(let current=resolve(path);;current=dirname(current)){if((await lstat(current)).isSymbolicLink())throw fail(code);if(dirname(current)===current)break;}}

/** Local machine operator only: no HTTP listener, provider construction or key access. */
export async function runServiceAdmin(args,{env=process.env,passwordInput}={}){
  const [command,...values]=args;
  if(!commands.has(command)||values.length!==({list:0,verify:1,disable:1,enable:1,revoke:1,quota:2,budget:1,backup:1,restore:2,'reset-password':1}[command]))throw fail('ADMIN_ARGUMENT_INVALID');
  if(command==='restore')return restoreService({backupDir:values[0],targetDir:values[1]});
  let config={};
  if(env.YUANYU_PROMOTION_CONFIG){
    if(!isAbsolute(env.YUANYU_PROMOTION_CONFIG))throw fail('ADMIN_CONFIG_INVALID');
    await noLinks(env.YUANYU_PROMOTION_CONFIG,'ADMIN_CONFIG_INVALID');
    const target=await realpath(env.YUANYU_PROMOTION_CONFIG),info=await lstat(target);
    if(!outside(target)||!info.isFile()||info.size>16_384)throw fail('ADMIN_CONFIG_INVALID');
    config=JSON.parse(await readFile(target,'utf8'));
    if(!config||typeof config!=='object'||Array.isArray(config))throw fail('ADMIN_CONFIG_INVALID');
  }
  const specified=config.dataDir||env.YUANYU_PROMOTION_DATA_DIR||join(env.LOCALAPPDATA||homedir(),'YuanyuWorkbench','promotion-service');
  if(typeof specified!=='string'||!isAbsolute(specified)||!outside(resolve(specified)))throw fail('ADMIN_PATH_INVALID');
  await noLinks(specified,'ADMIN_PATH_INVALID');
  if((await lstat(specified)).isSymbolicLink())throw fail('ADMIN_PATH_INVALID');
  const root=await realpath(specified),file=join(root,'promotion.sqlite');
  if(!outside(root)||!(await lstat(root)).isDirectory()||(await lstat(file)).isSymbolicLink()||!(await lstat(file)).isFile())throw fail('ADMIN_PATH_INVALID');
  if(command==='backup')return backupService({dataDir:specified,backupDir:values[0]});
  if(command==='reset-password')return resetAccountPassword({dataDir:specified,email:values[0],password:passwordInput??await readAdminPassword()});
  const db=new DatabaseSync(file,{readOnly:command==='list',timeout:1000});
  const publicAccount=row=>({id:row.id,email:row.email,name:row.display_name,verified:row.verified===1,enabled:row.enabled===1});
  try{
    db.exec('PRAGMA busy_timeout=1000');
    if(command==='list')return {accounts:db.prepare('SELECT id,email,display_name,verified,enabled FROM accounts ORDER BY created_at,id').all().map(publicAccount)};
    db.exec('BEGIN IMMEDIATE');
    try{
      let result;
      if(command==='quota'||command==='budget'){
        const setting=command==='quota'?'quota':'budget';
        const value=command==='quota'?{monthlyTokens:number(values[0],1_000_000_000),dailyRequests:number(values[1],100_000)}:number(values[0],1_000_000_000);
        if(db.prepare('UPDATE service_settings SET value=? WHERE setting_key=?').run(JSON.stringify(value),setting).changes!==1)throw fail('ADMIN_DATABASE_INVALID');
        if(command==='budget')db.prepare("INSERT INTO service_settings(setting_key,value) VALUES('budget_explicit','true') ON CONFLICT(setting_key) DO UPDATE SET value=excluded.value").run();
        result={updated:setting,value};
      }else{
        if(typeof values[0]!=='string'||values[0].length>254||!values[0].includes('@'))throw fail('ADMIN_ARGUMENT_INVALID');
        const account=db.prepare('SELECT id,email,display_name,verified,enabled FROM accounts WHERE email=?').get(values[0].toLowerCase());
        if(!account)throw fail('ADMIN_ACCOUNT_NOT_FOUND');
        if(command==='verify'){
          db.prepare('UPDATE accounts SET verified=1 WHERE id=?').run(account.id);db.prepare('DELETE FROM verification WHERE account_id=?').run(account.id);
        }else if(command==='disable'||command==='enable')db.prepare('UPDATE accounts SET enabled=? WHERE id=?').run(command==='enable'?1:0,account.id);
        if(command==='disable'||command==='revoke')db.prepare('UPDATE sessions SET revoked=1 WHERE account_id=?').run(account.id);
        result={updated:command,account:publicAccount(db.prepare('SELECT id,email,display_name,verified,enabled FROM accounts WHERE id=?').get(account.id))};
      }
      db.exec('COMMIT');return result;
    }catch(cause){db.exec('ROLLBACK');throw cause;}
  }finally{db.close();}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{process.stdout.write(JSON.stringify(await runServiceAdmin(process.argv.slice(2)),null,2)+'\n');}
  catch(cause){process.stderr.write((/^(?:ADMIN_|SERVICE_BACKUP_)[A-Z_]+$/.test(cause.code??'')?cause.code:'ADMIN_OPERATION_FAILED')+'\n用法：node scripts/service-admin.mjs list | verify <邮箱> | disable <邮箱> | enable <邮箱> | revoke <邮箱> | quota <月token> <日次数> | budget <全局月token> | backup <新备份目录> | restore <备份目录> <新数据目录> | reset-password <邮箱>（密码由标准输入两次提供，不写在命令行）\n');process.exitCode=1;}
}
