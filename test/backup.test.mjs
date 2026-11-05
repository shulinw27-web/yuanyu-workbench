import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,realpath} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {backupWorkspace,restoreWorkspace} from '../src/runtime/backup.mjs';
import { createHash } from 'node:crypto';
import { createAgentStore } from '../src/agent/store.mjs';
test('隔离备份不带浏览器缓存/外部模型密钥，恢复只写新目录并迁移产物引用',async t=>{const base=await mkdtemp(join(tmpdir(),'yuanyu-backup-test-'));t.after(()=>rm(base,{recursive:true,force:true}));const dataDir=join(base,'source'),backupDir=join(base,'backup'),targetDir=join(base,'restored');const user=join(dataDir,'companies','mock-company','users','alice'),output=join(dataDir,'outputs','mock-company','alice','report.csv');await mkdir(user,{recursive:true});await mkdir(join(dataDir,'outputs','mock-company','alice'),{recursive:true});await mkdir(join(dataDir,'electron'),{recursive:true});await writeFile(join(dataDir,'electron','cache'),'browser-cache-must-not-export');await writeFile(join(dataDir,'.publication-key'),'synthetic-key');await writeFile(output,'synthetic,csv');await writeFile(join(user,'state.json'),JSON.stringify({runs:[{id:'run-1',artifact:{path:output}}]}));const backup=await backupWorkspace({dataDir,backupDir});assert.equal(backup.files,3);assert.ok(!(await readdir(backupDir)).includes('electron'));await restoreWorkspace({backupDir,targetDir});const restored=JSON.parse(await readFile(join(targetDir,'companies','mock-company','users','alice','state.json'),'utf8'));assert.equal(restored.runs[0].artifact.path,join(await realpath(targetDir),'outputs','mock-company','alice','report.csv'));await assert.rejects(restoreWorkspace({backupDir,targetDir}),/RESTORE_TARGET_EXISTS/);assert.equal(await readFile(output,'utf8'),'synthetic,csv');});
test('备份文件损坏或路径越界时拒绝恢复，不覆盖或创建目标工作区',async t=>{const base=await mkdtemp(join(tmpdir(),'yuanyu-backup-test-'));t.after(()=>rm(base,{recursive:true,force:true}));const dataDir=join(base,'source'),backupDir=join(base,'backup');await mkdir(dataDir);await writeFile(join(dataDir,'.publication-key'),'synthetic-key');await backupWorkspace({dataDir,backupDir});await writeFile(join(backupDir,'.publication-key'),'tampered');await assert.rejects(restoreWorkspace({backupDir,targetDir:join(base,'restored')}),/BACKUP_HASH_MISMATCH/);await assert.rejects(backupWorkspace({dataDir,backupDir:join(dataDir,'nested')}),/BACKUP_PATH_INVALID/);});
test('模型目录中与配置同放的密钥文本不进入备份，错误内联密钥配置拒绝导出',async t=>{const base=await mkdtemp(join(tmpdir(),'yuanyu-backup-test-'));t.after(()=>rm(base,{recursive:true,force:true}));const dataDir=join(base,'source'),modelDir=join(dataDir,'models','mock-company','alice'),key=join(modelDir,'model-api-key.txt'),configFile=join(modelDir,'model.local.json');await mkdir(modelDir,{recursive:true});await writeFile(key,'synthetic-key-must-not-export');const config={schemaVersion:1,enabled:false,baseUrl:'https://model.example.test/v1',model:'synthetic',apiKeyFile:key,dataScope:'task_text'};await writeFile(configFile,JSON.stringify(config));const backupDir=join(base,'backup');const result=await backupWorkspace({dataDir,backupDir});assert.equal(result.files,1);assert.deepEqual(await readdir(join(backupDir,'models','mock-company','alice')),['model.local.json']);await writeFile(configFile,JSON.stringify({...config,apiKey:'must-not-export'}));await assert.rejects(backupWorkspace({dataDir,backupDir:join(base,'invalid-backup')}),/MODEL_CONFIG_INVALID/);});

test('通用浏览器任务与个人技能恢复到新目录，原运行转中断且不备份锁、Cookies或keys', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'yuanyu-agent-backup-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dataDir = join(base, 'source'), backupDir = join(base, 'backup'), targetDir = join(base, 'restored');
  const identity = { companyId: 'mock-acme', userId: 'alice', displayName: 'Alice', provider: 'mock' };
  const siteBindings = [{ id: 'procurement', origin: 'http://127.0.0.1:41001', revision: 1 }];
  const source = createAgentStore({ dataDir, identity });
  const task = await source.createTask({ goal: '查看采购查询页面并说明未核对项。', mode: 'mock_browser', siteBindings });
  const trace = [{ tool: 'open', siteId: 'procurement' }, { tool: 'observe', siteId: 'procurement' }];
  await source.updateTask(task.id, { status: 'completed', trace, message: '查看完毕，仍需本人核对。' });
  const skill = await source.saveSkill({ taskId: task.id, name: '查看采购资料', pinned: true });
  const unfinished = await source.createTask({ goal: '继续查看采购查询页面。', mode: 'mock_browser', siteBindings, skillId: skill.id });
  await source.updateTask(unfinished.id, { status: 'running', trace: trace.slice(0, 1) });
  const userDirectory = join(dataDir, 'agents', 'mock-acme', 'alice');
  await mkdir(join(userDirectory, 'browser'), { recursive: true });
  await mkdir(join(userDirectory, 'keys'), { recursive: true });
  await writeFile(join(userDirectory, 'browser', 'Cookies'), 'synthetic-cookie-must-not-export');
  await writeFile(join(userDirectory, 'keys', 'model-api-key.txt'), 'synthetic-model-key-must-not-export');
  await writeFile(join(userDirectory, 'state.json.tmp'), 'incomplete-private-write-must-not-export');

  const result = await backupWorkspace({ dataDir, backupDir });
  assert.equal(result.files, 1);
  const manifest = JSON.parse(await readFile(join(backupDir, 'backup-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.files.map(file => file.path), ['agents/mock-acme/alice/state.json']);
  assert.deepEqual(await readdir(join(backupDir, 'agents', 'mock-acme', 'alice')), ['state.json']);
  assert.ok(!(await readdir(backupDir)).includes('.agent-store.lock'));
  await restoreWorkspace({ backupDir, targetDir });
  assert.ok(!(await readdir(targetDir)).includes('.agent-store.lock'));
  const restored = createAgentStore({ dataDir: targetDir, identity });
  assert.deepEqual(await restored.listSkills(), [skill]);
  const restoredTasks = await restored.listTasks();
  assert.equal(restoredTasks.find(item => item.id === task.id).status, 'completed');
  assert.equal(restoredTasks.find(item => item.id === unfinished.id).status, 'interrupted');
  assert.deepEqual(restoredTasks.find(item => item.id === unfinished.id).trace, trace.slice(0, 1));
  assert.equal((await source.listTasks()).find(item => item.id === unfinished.id).status, 'running');
  await assert.rejects(restored.updateTask(unfinished.id, { status: 'completed' }), { code: 'AGENT_TASK_TERMINAL' });
  const resumed = await restored.resumeTask(unfinished.id);
  await restored.updateTask(unfinished.id, { status: 'completed', trace, expectedAttempt: resumed.attempt });
  assert.equal((await restored.saveSkill({ taskId: unfinished.id, name: '恢复后查看' })).template.goalTemplate, unfinished.goal);
  const bob = createAgentStore({ dataDir: targetDir, identity: { ...identity, userId: 'bob', displayName: 'Bob' } });
  assert.deepEqual(await bob.listTasks(), []);
  assert.deepEqual(await bob.listSkills(), []);
  await assert.rejects(restoreWorkspace({ backupDir, targetDir }), /RESTORE_TARGET_EXISTS/);
});

test('备份清单不能借agents目录导入浏览器Cookies、密钥或额外状态文件', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'yuanyu-agent-backup-policy-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dataDir = join(base, 'source'), backupDir = join(base, 'backup');
  await mkdir(dataDir);
  await writeFile(join(dataDir, '.publication-key'), 'synthetic-key');
  await backupWorkspace({ dataDir, backupDir });
  const original = JSON.parse(await readFile(join(backupDir, 'backup-manifest.json'), 'utf8'));
  const bytes = Buffer.from('synthetic-content');
  for (const path of ['agents/mock-acme/alice/Cookies', 'agents/mock-acme/alice/keys/api-key.txt',
    'agents/mock-acme/alice/state.json.tmp', 'agents/mock-acme/alice/nested/state.json', '.agent-store.lock']) {
    const manifest = structuredClone(original);
    const file = join(backupDir, ...path.split('/'));
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, bytes);
    manifest.files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    await writeFile(join(backupDir, 'backup-manifest.json'), JSON.stringify(manifest));
    await assert.rejects(restoreWorkspace({ backupDir, targetDir: join(base, 'restored') }), /BACKUP_MANIFEST_INVALID/);
  }
  assert.ok(!(await readdir(base)).includes('restored'));
});
