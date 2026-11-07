import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {inspectReadiness,runReadiness} from '../scripts/readiness.mjs';

const repository=resolve(fileURLToPath(new URL('..',import.meta.url)));
const publicUrl='https://accounts.yuanyu-deployment.com';
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'yuanyu-readiness-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const keyFile=join(root,'not-a-valid-key.bin'),configFile=join(root,'service.json'),dataDir=join(root,'planned','data');
  // Deliberately not a parseable API key: readiness must inspect metadata only.
  await writeFile(keyFile,Buffer.alloc(16),{mode:0o600});
  const config={dataDir,host:'127.0.0.1',port:15334,demo:false,monthlyTokens:100000,dailyRequests:20,globalMonthlyTokens:1000000,
    developer:{name:'开发者',contactType:'wechat',contact:'synthetic-wechat'},
    providers:[{id:'synthetic-model',label:'测试模型',baseUrl:'https://api.provider-company.com/v1',model:'synthetic-model',apiKeyFile:keyFile}]};
  const save=async(value=config)=>writeFile(configFile,JSON.stringify(value),{mode:0o600});await save();
  return {root,keyFile,configFile,dataDir,config,save};
}

test('预检只验证配置和文件元数据，不联网/读密钥值/创建数据目录',async t=>{
  const f=await fixture(t);let networkCalls=0;const original=globalThis.fetch;
  globalThis.fetch=async()=>{networkCalls++;throw new Error('NETWORK_MUST_NOT_BE_USED');};t.after(()=>{globalThis.fetch=original;});
  const result=await inspectReadiness({configFile:f.configFile,publicUrl});
  assert.equal(result.ready,true,JSON.stringify(result));assert.equal(result.noticeCode,'CONFIGURATION_ONLY_NOT_LIVE_VERIFIED');assert.equal(networkCalls,0);
  assert.equal(result.checks.find(check=>check.code==='NODE24_RUNTIME').ok,true);assert.equal(result.checks.find(check=>check.code==='SQLITE_RUNTIME').ok,true);
  assert.deepEqual(await readFile(f.keyFile),Buffer.alloc(16));
  await assert.rejects(readFile(join(f.dataDir,'promotion.sqlite')),error=>error.code==='ENOENT');
  const rendered=JSON.stringify(result);for(const value of [f.root,'synthetic-wechat','synthetic-model','provider-company'])assert.ok(!rendered.includes(value));
  assert.ok(result.manualChecks.includes('DNS_TLS_AND_FIREWALL'));
});

test('演示模式、公开监听、零预算、模型占位和任意字段不能通过生产预检',async t=>{
  const f=await fixture(t);
  const variants=[
    [{...f.config,demo:true},'PRODUCTION_MODE'],
    [{...f.config,host:'0.0.0.0'},'LOOPBACK_BINDING'],
    [{...f.config,globalMonthlyTokens:0},'PROMOTION_BUDGET'],
    [{...f.config,dailyRequests:0},'PERSONAL_QUOTA'],
    [{...f.config,inlineApiKey:'must-not-output'},'CONFIG_SCHEMA'],
    [{...f.config,models:[{id:'synthetic',label:'synthetic'}]},'PROVIDER_CONFIGURATION'],
    [{...f.config,providers:[{...f.config.providers[0],baseUrl:'https://YOUR-PROVIDER.invalid/v1'}]},'PROVIDER_CONFIGURATION'],
    [{...f.config,providers:[{...f.config.providers[0],model:'YOUR-MODEL-ID'}]},'PROVIDER_CONFIGURATION'],
    [{...f.config,providers:[{...f.config.providers[0],apiKey:'must-not-output'}]},'PROVIDER_CONFIGURATION']
  ];
  for(const [config,code] of variants){await f.save(config);const result=await inspectReadiness({configFile:f.configFile,publicUrl});assert.equal(result.ready,false);assert.equal(result.checks.find(check=>check.code===code)?.ok,false,code);assert.ok(!JSON.stringify(result).includes('must-not-output'));}
  await f.save();
  for(const url of ['http://accounts.yuanyu-deployment.com','https://localhost','https://127.0.0.1','https://[::1]','https://accounts.example.invalid','https://accounts.example.invalid.','https://accounts.local','https://accounts.yuanyu-deployment.com/path','https://name:secret@accounts.yuanyu-deployment.com','https://accounts.yuanyu-deployment.com/?secret=1']){
    const result=await inspectReadiness({configFile:f.configFile,publicUrl:url});assert.equal(result.ready,false);assert.equal(result.checks.find(check=>check.code==='PUBLIC_HTTPS_ORIGIN')?.ok,false,url);
  }
});

test('配置和密钥路径、大小、可读性及仓库边界逐项校验',async t=>{
  const f=await fixture(t);
  assert.equal((await inspectReadiness({configFile:join(repository,'package.json'),publicUrl})).ready,false);
  await f.save({...f.config,dataDir:join(repository,'data')});let result=await inspectReadiness({configFile:f.configFile,publicUrl});assert.equal(result.checks.find(check=>check.code==='PRIVATE_DATA_DIRECTORY').ok,false);
  await f.save({...f.config,providers:[{...f.config.providers[0],apiKeyFile:join(repository,'package.json')}]});result=await inspectReadiness({configFile:f.configFile,publicUrl});assert.equal(result.checks.find(check=>check.code==='PROVIDER_CONFIGURATION').ok,false);
  await f.save();await writeFile(f.keyFile,Buffer.alloc(4097));result=await inspectReadiness({configFile:f.configFile,publicUrl});assert.equal(result.checks.find(check=>check.code==='PROVIDER_KEY_FILES').ok,false);
  await writeFile(f.keyFile,Buffer.alloc(1));result=await inspectReadiness({configFile:f.configFile,publicUrl});assert.equal(result.checks.find(check=>check.code==='PROVIDER_KEY_FILES').ok,false);
  await writeFile(f.configFile,'not-json');result=await inspectReadiness({configFile:f.configFile,publicUrl});assert.equal(result.ready,false);assert.equal(result.checks.at(-1).code,'CONFIG_JSON_VALID');
});

test('符号链接或链接祖先不能让配置/密钥绕过预检',async t=>{
  const f=await fixture(t),linked=join(f.root,'linked');
  try{await symlink(f.root,linked,process.platform==='win32'?'junction':'dir');}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('OS account cannot create test links');return;}throw error;}
  let result=await inspectReadiness({configFile:join(linked,'service.json'),publicUrl});assert.equal(result.ready,false);assert.equal(result.checks.find(check=>check.code==='CONFIG_FILE_SAFE').ok,false);
  await f.save({...f.config,providers:[{...f.config.providers[0],apiKeyFile:join(linked,'not-a-valid-key.bin')}]});result=await inspectReadiness({configFile:f.configFile,publicUrl});assert.equal(result.checks.find(check=>check.code==='PROVIDER_KEY_FILES').ok,false);
});

test('CLI有明确退出码且只输出安全报告，默认部署样例不会授权真实额度',async t=>{
  const f=await fixture(t),script=join(repository,'scripts','readiness.mjs');
  assert.equal((await runReadiness([])).exitCode,2);
  let command=spawnSync(process.execPath,[script,'--config',f.configFile,'--public-url',publicUrl],{encoding:'utf8'});assert.equal(command.status,0,command.stderr);assert.equal(JSON.parse(command.stdout).ready,true);assert.ok(!command.stdout.includes(f.root));
  await f.save({...f.config,globalMonthlyTokens:0});command=spawnSync(process.execPath,[script,'--config',f.configFile,'--public-url',publicUrl],{encoding:'utf8'});assert.equal(command.status,1);assert.equal(JSON.parse(command.stdout).ready,false);
  const sample=JSON.parse(await readFile(join(repository,'deploy','service.example.json'),'utf8'));assert.equal(sample.demo,false);assert.equal(sample.globalMonthlyTokens,0);assert.equal(sample.monthlyTokens,100000);assert.equal(sample.dailyRequests,20);assert.equal(sample.providers[0].apiKey,undefined);
});

test('POSIX配置与密钥需要仅owner访问，Windows ACL留作明确人工项',async t=>{
  const f=await fixture(t);
  if(process.platform==='win32'){const result=await inspectReadiness({configFile:f.configFile,publicUrl});assert.ok(result.manualChecks.includes('SERVICE_ACCOUNT_AND_FILE_ACLS'));return;}
  await chmod(f.keyFile,0o644);let result=await inspectReadiness({configFile:f.configFile,publicUrl});assert.equal(result.checks.find(check=>check.code==='PROVIDER_KEY_FILES').ok,false);
  await chmod(f.keyFile,0o600);await chmod(f.configFile,0o644);result=await inspectReadiness({configFile:f.configFile,publicUrl});assert.equal(result.checks.find(check=>check.code==='CONFIG_FILE_SAFE').ok,false);
});

test('重复预检不会启动服务、重置已用/预留额度或修改运营数据库',async t=>{
  const f=await fixture(t);await mkdir(f.dataDir,{recursive:true,mode:0o700});await chmod(f.dataDir,0o700);
  const file=join(f.dataDir,'promotion.sqlite'),db=new DatabaseSync(file);
  try{
    db.exec('CREATE TABLE quota(account_id TEXT,used INTEGER,reserved INTEGER);CREATE TABLE service_settings(setting_key TEXT,value TEXT);');
    db.prepare('INSERT INTO quota VALUES(?,?,?)').run('synthetic-readiness-account',321,654);
    db.prepare('INSERT INTO service_settings VALUES(?,?)').run('budget','0');
    const before=await readFile(file);
    for(let pass=0;pass<2;pass++)assert.equal((await inspectReadiness({configFile:f.configFile,publicUrl})).ready,true);
    assert.deepEqual(await readFile(file),before);
    assert.deepEqual({...db.prepare('SELECT used,reserved FROM quota').get()},{used:321,reserved:654});
    assert.equal(db.prepare('SELECT value FROM service_settings WHERE setting_key=?').get('budget').value,'0');
  }finally{db.close();}
});
