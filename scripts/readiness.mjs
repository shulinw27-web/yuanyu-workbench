import {lstat,realpath,readFile,access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute,relative,resolve,dirname,basename,join,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSponsoredProvider} from '../src/service/provider.mjs';

const ROOT=resolve(fileURLToPath(new URL('..',import.meta.url)));
const within=(base,file)=>{const path=relative(base,file);return !path||!isAbsolute(path)&&path!=='..'&&!path.startsWith('..'+sep);};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const closed=(value,fields)=>plain(value)&&Object.keys(value).every(key=>fields.includes(key));
const privatePermissions=info=>process.platform==='win32'||(info.mode&0o077)===0;
const readablePermissions=info=>process.platform==='win32'||(info.mode&0o400)!==0;
const placeholder=host=>{const value=host.replace(/\.$/,'');return /(?:^|\.)(?:invalid|test|localhost|example|local|internal|lan)$/.test(value)||/^(?:.*\.)?example\.(?:com|net|org)$/.test(value);};
const messageCode='CONFIGURATION_ONLY_NOT_LIVE_VERIFIED';

// Resolve only filesystem metadata; never open the provider key. Missing data directories are not created.
async function inspectPath(file,{existing=false,kind='file',maxBytes=4096,minBytes=1,privateFile=true}={}){
  if(typeof file!=='string'||!isAbsolute(file)||within(ROOT,resolve(file)))return false;
  let current=resolve(file),suffix=[];
  while(true){
    try{
      const info=await lstat(current);
      if(info.isSymbolicLink())return false;
      if(!suffix.length){
        if(kind==='file'&&(!info.isFile()||info.size<minBytes||info.size>maxBytes))return false;
        if(kind==='directory'&&!info.isDirectory())return false;
        if(privateFile&&(!privatePermissions(info)||!readablePermissions(info)))return false;
        await access(current,kind==='file'?constants.R_OK:constants.R_OK|constants.W_OK|constants.X_OK);
      }else{
        if(existing||!info.isDirectory())return false;
        await access(current,constants.W_OK|constants.X_OK);
      }
      const canonical=join(await realpath(current),...suffix);
      if(within(ROOT,canonical))return false;
      // A link in any existing parent is rejected even when its target is otherwise outside the repository.
      for(let parent=dirname(current);;parent=dirname(parent)){
        const ancestor=await lstat(parent);if(ancestor.isSymbolicLink())return false;
        if(dirname(parent)===parent)break;
      }
      return true;
    }catch(error){
      if(error.code!=='ENOENT')return false;
      if(existing||kind==='file')return false;
      if(dirname(current)===current)return false;
      suffix.unshift(basename(current));current=dirname(current);
    }
  }
}
function publicOrigin(value){
  try{
    const url=new URL(value);
    return url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/'
      &&url.hostname.includes('.')&&!placeholder(url.hostname)&&!/^\d+(?:\.\d+){3}$/.test(url.hostname)&&!url.hostname.includes(':');
  }catch{return false;}
}
function providerConfiguration(config){
  try{
    if(config.models!==undefined)return false;
    createSponsoredProvider({providers:config.providers}); // This constructor validates metadata, not keys or connections.
    return config.providers.every(provider=>!placeholder(new URL(provider.baseUrl).hostname)&&!/^(?:YOUR[-_]|CHANGE[-_]?ME|REPLACE[-_])/i.test(provider.model));
  }catch{return false;}
}

/** Read-only deployment checks. A successful result makes no DNS, TLS, identity or inference claim. */
export async function inspectReadiness({configFile,publicUrl}={}){
  const checks=[];
  const check=(code,ok)=>{checks.push({code,ok:ok===true});return ok===true;};
  const finish=()=>({ready:checks.every(item=>item.ok),checks,noticeCode:messageCode,
    manualChecks:['DNS_TLS_AND_FIREWALL','SERVICE_ACCOUNT_AND_FILE_ACLS','ACCOUNT_VERIFICATION_PROCESS','BACKUP_AND_RESTORE_DRILL','REAL_MODEL_CONNECTION_AND_BUDGET']});
  check('NODE24_RUNTIME',Number(process.versions.node.split('.')[0])>=24);
  let sqlite;try{sqlite=await import('node:sqlite');}catch{}
  check('SQLITE_RUNTIME',typeof sqlite?.DatabaseSync==='function');
  check('PUBLIC_HTTPS_ORIGIN',publicOrigin(publicUrl));
  const safe=await inspectPath(configFile,{existing:true,kind:'file',maxBytes:16_384});
  if(!check('CONFIG_FILE_SAFE',safe))return finish();
  let config;
  try{config=JSON.parse(await readFile(configFile,'utf8'));}catch{check('CONFIG_JSON_VALID',false);return finish();}
  if(!check('CONFIG_SCHEMA',closed(config,['dataDir','host','port','demo','monthlyTokens','dailyRequests','globalMonthlyTokens','developer','models','providers'])))return finish();
  check('PRODUCTION_MODE',config.demo===false);
  check('LOOPBACK_BINDING',['127.0.0.1','::1'].includes(config.host)&&Number.isInteger(config.port)&&config.port>=1024&&config.port<=65535);
  check('PRIVATE_DATA_DIRECTORY',await inspectPath(config.dataDir,{kind:'directory'}));
  check('PERSONAL_QUOTA',Number.isSafeInteger(config.monthlyTokens)&&config.monthlyTokens>0&&config.monthlyTokens<=1_000_000_000
    &&Number.isSafeInteger(config.dailyRequests)&&config.dailyRequests>0&&config.dailyRequests<=100_000);
  check('PROMOTION_BUDGET',Number.isSafeInteger(config.globalMonthlyTokens)&&config.globalMonthlyTokens>0&&config.globalMonthlyTokens<=1_000_000_000);
  const developer=config.developer;
  check('DEVELOPER_CONTACT',closed(developer,['name','contact','contactType'])&&typeof developer.name==='string'&&developer.name.trim().length>0&&developer.name.length<=100
    &&typeof developer.contact==='string'&&developer.contact.trim().length>0&&developer.contact.length<=500&&developer.contactType==='wechat');
  const providers=providerConfiguration(config);
  check('PROVIDER_CONFIGURATION',providers);
  if(providers){
    const states=await Promise.all(config.providers.map(provider=>inspectPath(provider.apiKeyFile,{existing:true,kind:'file',minBytes:8,maxBytes:4096})));
    check('PROVIDER_KEY_FILES',states.every(Boolean));
  }
  return finish();
}

export async function runReadiness(args){
  if(args.length!==4||args[0]!=='--config'||args[2]!=='--public-url')return {exitCode:2,result:{ready:false,checks:[{code:'ARGUMENT_INVALID',ok:false}],noticeCode:messageCode}};
  const result=await inspectReadiness({configFile:args[1],publicUrl:args[3]});return {exitCode:result.ready?0:1,result};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const {exitCode,result}=await runReadiness(process.argv.slice(2));process.stdout.write(JSON.stringify(result,null,2)+'\n');process.exitCode=exitCode;}
  catch{process.stdout.write(JSON.stringify({ready:false,checks:[{code:'READINESS_FAILED',ok:false}],noticeCode:messageCode})+'\n');process.exitCode=1;}
}
