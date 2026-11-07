import {DatabaseSync} from 'node:sqlite';
import {lstat,realpath} from 'node:fs/promises';
import {randomBytes,scrypt} from 'node:crypto';
import {promisify} from 'node:util';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';

const repository=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const derive=promisify(scrypt);
const fail=code=>Object.assign(new Error(code),{code});
const inside=(base,target)=>{const path=relative(base,target);return !path||!isAbsolute(path)&&path!=='..'&&!path.startsWith('..'+sep);};

/** A local operator must verify the person's identity out of band before using this tool. */
export async function resetAccountPassword({dataDir,email,password}){
  if(typeof dataDir!=='string'||!isAbsolute(dataDir)||inside(repository,resolve(dataDir)))throw fail('ADMIN_PATH_INVALID');
  if(typeof email!=='string'||email.length>254||!email.includes('@'))throw fail('ADMIN_ARGUMENT_INVALID');
  if(typeof password!=='string'||password.length<12||password.length>128||/[\u0000-\u001f\u007f]/.test(password))throw fail('ADMIN_PASSWORD_INVALID');
  for(let current=resolve(dataDir);;current=dirname(current)){if((await lstat(current)).isSymbolicLink())throw fail('ADMIN_PATH_INVALID');if(dirname(current)===current)break;}
  const root=await realpath(dataDir),file=join(root,'promotion.sqlite');
  if(inside(await realpath(repository),root)||!(await lstat(root)).isDirectory())throw fail('ADMIN_PATH_INVALID');
  const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw fail('ADMIN_PATH_INVALID');
  const db=new DatabaseSync(file,{timeout:1000});let derived;
  try{
    db.exec('PRAGMA busy_timeout=1000');
    const account=db.prepare('SELECT id,salt,password_hash FROM accounts WHERE email=?').get(email.toLowerCase());
    if(!account)throw fail('ADMIN_ACCOUNT_NOT_FOUND');
    const salt=randomBytes(24).toString('hex');
    derived=await derive(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});password='';
    db.exec('BEGIN IMMEDIATE');
    try{
      const changed=db.prepare('UPDATE accounts SET salt=?,password_hash=? WHERE id=? AND salt=? AND password_hash=?').run(salt,derived.toString('hex'),account.id,account.salt,account.password_hash);
      if(changed.changes!==1)throw fail('ADMIN_ACCOUNT_CHANGED');
      const sessions=db.prepare('UPDATE sessions SET revoked=1 WHERE account_id=? AND revoked=0').run(account.id).changes;
      db.prepare('DELETE FROM verification WHERE account_id=?').run(account.id);
      const state=db.prepare('SELECT enabled,verified FROM accounts WHERE id=?').get(account.id);
      db.exec('COMMIT');
      return {updated:'password',requiresLogin:true,sessionsRevoked:Number(sessions),enabled:state.enabled===1,verified:state.verified===1};
    }catch(error){db.exec('ROLLBACK');throw error;}
  }catch(error){if(/^ADMIN_[A-Z_]+$/.test(error.code??''))throw error;throw fail('ADMIN_OPERATION_FAILED');}
  finally{password='';derived?.fill(0);db.close();}
}

/** Passwords never belong in argv, environment variables, stdout or a config file. */
export async function readAdminPassword({input=process.stdin,output=process.stderr}={}){
  let first,second;
  if(input.isTTY){
    const muted=new Writable({write(_chunk,_encoding,callback){callback();}});
    const reader=createInterface({input,output:muted,terminal:true});
    try{output.write('新密码（至少12位，输入不回显）：');first=await reader.question('');output.write('\n再次输入：');second=await reader.question('');output.write('\n');}
    finally{reader.close();muted.end();}
  }else{
    const chunks=[];let size=0;
    for await(const chunk of input){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>4096)throw fail('ADMIN_PASSWORD_INPUT_INVALID');chunks.push(bytes);}
    const lines=Buffer.concat(chunks).toString('utf8').replaceAll('\r\n','\n').replace(/\n$/,'').split('\n');
    if(lines.length!==2)throw fail('ADMIN_PASSWORD_INPUT_INVALID');[first,second]=lines;
  }
  if(first!==second)throw fail('ADMIN_PASSWORD_MISMATCH');
  if(typeof first!=='string'||first.length<12||first.length>128||/[\u0000-\u001f\u007f]/.test(first))throw fail('ADMIN_PASSWORD_INVALID');
  return first;
}
