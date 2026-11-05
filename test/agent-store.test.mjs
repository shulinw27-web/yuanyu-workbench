import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createAgentStore,instantiateSkillRecipe } from '../src/agent/store.mjs';

const identities = {
  alice: { companyId: 'mock-acme', userId: 'alice', displayName: 'Alice', provider: 'mock' },
  bob: { companyId: 'mock-acme', userId: 'bob', displayName: 'Bob', provider: 'mock' },
  outsider: { companyId: 'mock-other', userId: 'outsider', displayName: 'Outsider', provider: 'mock' },
};
const siteBindings = [{ id: 'procurement', origin: 'http://127.0.0.1:41001', revision: 1 }];
const goal = '打开采购站点，按月份查看已审核单据，并说明未核对项。';
const recipe = [
  { tool: 'open', siteId: 'procurement' },
  { tool: 'observe', siteId: 'procurement' },
  { tool: 'fill', siteId: 'procurement', locator: { role: 'textbox', name: '月份', readOnly: true }, value: '2026-09' },
  { tool: 'click', siteId: 'procurement', locator: { role: 'button', name: '查询', readOnly: true } },
  { tool: 'observe', siteId: 'procurement' },
];
async function fixture(t) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'yuanyu-agent-store-')));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = (user = 'alice') => createAgentStore({ dataDir, identity: identities[user] });
  return { dataDir, store, alice: store(), bob: store('bob'), outsider: store('outsider') };
}
const create = (store, extra = {}) => store.createTask({ goal, siteBindings: structuredClone(siteBindings), mode: 'mock_browser', ...extra });
async function completed(store) {
  const task = await create(store);
  return store.updateTask(task.id, { status: 'completed', expectedAttempt: task.attempt, trace: structuredClone(recipe),
    steps: [{ id: 'step-read', label: '读取月份筛选页', status: 'completed', tool: 'observe', siteId: 'procurement' }],
    message: '已查看指定月份，未核对项仍需本人复查。' });
}

test('a completed browser task saves a private replay template without original pages, runs or purchase recipe', async (t) => {
  const { alice, store, dataDir } = await fixture(t);
  const task = await completed(alice);
  assert.equal(task.kind, 'browser');
  assert.equal(task.month, undefined);
  assert.equal(task.sessionId, undefined);
  assert.equal(task.status, 'completed');
  const skill = await alice.saveSkill({ taskId: task.id, name: '九月查看资料', pinned: true });
  assert.deepEqual(skill.template, { goalTemplate: goal, siteBindings, recipe });
  assert.equal(skill.recipeId, undefined);
  assert.equal(skill.kind, 'browser');
  assert.equal(skill.source.taskId, task.id);
  assert.ok(!JSON.stringify(skill).includes(task.message));
  assert.deepEqual(await store().listSkills(), [skill]);
  const repeated = await create(alice, { skillId: skill.id });
  assert.equal(repeated.skillId, skill.id);
  assert.equal(repeated.trace.length, 0, 'a new run records its actual actions rather than fabricating completed steps');
  await alice.updateTask(repeated.id, { status: 'cancelled' });
  await assert.rejects(create(alice, { skillId: skill.id, siteBindings: [{ ...siteBindings[0], revision: 2 }] }), { code: 'AGENT_BINDINGS_CHANGED' });
  const changed = await alice.setSkillPinned(skill.id, false);
  assert.equal(changed.pinned, false);
  changed.template.recipe[0].siteId = 'forged';
  assert.equal((await alice.listSkills())[0].template.recipe[0].siteId, 'procurement');
  await alice.deleteSkill(skill.id);
  assert.deepEqual(await alice.listSkills(), []);
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'agents', 'mock-acme', 'alice', 'state.json'), 'utf8'));
  assert.equal(saved.schemaVersion, 1);
  assert.equal(saved.tasks[0].kind, 'browser');
  assert.equal(saved.runs, undefined);
});

test('tasks, skill reuse and pin/delete stay isolated across people and companies; forged Mock identity fails', async (t) => {
  const { dataDir, alice, bob, outsider } = await fixture(t);
  const task = await completed(alice);
  const skill = await alice.saveSkill({ taskId: task.id, name: '本人查看', pinned: false });
  for (const foreign of [bob, outsider]) {
    assert.deepEqual(await foreign.listTasks(), []);
    assert.deepEqual(await foreign.listSkills(), []);
    await assert.rejects(foreign.updateTask(task.id, { status: 'cancelled' }), { code: 'AGENT_TASK_NOT_FOUND' });
    await assert.rejects(foreign.resumeTask(task.id), { code: 'AGENT_TASK_NOT_FOUND' });
    await assert.rejects(foreign.saveSkill({ taskId: task.id, name: '窃取' }), { code: 'AGENT_TASK_NOT_FOUND' });
    await assert.rejects(create(foreign, { skillId: skill.id }), { code: 'AGENT_SKILL_NOT_FOUND' });
    await assert.rejects(foreign.setSkillPinned(skill.id, true), { code: 'AGENT_SKILL_NOT_FOUND' });
    await assert.rejects(foreign.deleteSkill(skill.id), { code: 'AGENT_SKILL_NOT_FOUND' });
  }
  assert.throws(() => createAgentStore({ dataDir, identity: { ...identities.alice, companyId: 'mock-other' } }), { code: 'INVALID_IDENTITY' });
  assert.throws(() => createAgentStore({ dataDir, identity: { ...identities.alice, userId: 'constructor' } }), { code: 'INVALID_IDENTITY' });
  assert.equal((await alice.listSkills()).length, 1);
  assert.equal((await alice.listTasks()).length, 1);
});

test('handoff and failed work require explicit resume; cancellation and completion reject late updates and resume', async (t) => {
  const { alice, store } = await fixture(t);
  const task = await create(alice);
  assert.equal((await store().listTasks())[0].status, 'running', 'same-process construction must not interrupt its own work');
  const awaiting = await alice.updateTask(task.id, { status: 'awaiting_user', awaitingSiteId: 'procurement', trace: recipe.slice(0, 2) });
  assert.equal(awaiting.awaitingSiteId, 'procurement');
  await assert.rejects(alice.updateTask(task.id, { status: 'running' }), { code: 'AGENT_TASK_RESUME_REQUIRED' });
  await assert.rejects(alice.updateTask(task.id, { status: 'completed' }), { code: 'AGENT_TASK_RESUME_REQUIRED' });
  const resumed = await alice.resumeTask(task.id);
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.awaitingSiteId, undefined);
  assert.equal(resumed.attempt, 2);
  await assert.rejects(alice.updateTask(task.id, { status: 'completed', expectedAttempt: 1 }), { code: 'AGENT_TASK_STALE' });
  await alice.updateTask(task.id, { status: 'failed', expectedAttempt: 2, error: { code: 'PAGE_CHANGED', message: '页面结构变化，请重新观察。' } });
  await assert.rejects(alice.updateTask(task.id, { status: 'completed' }), { code: 'AGENT_TASK_TERMINAL' });
  const retry = await alice.resumeTask(task.id);
  assert.equal(retry.attempt, 3);
  assert.equal(retry.error, undefined);
  await alice.updateTask(task.id, { status: 'cancelled', expectedAttempt: 3 });
  await assert.rejects(alice.updateTask(task.id, { status: 'completed' }), { code: 'AGENT_TASK_TERMINAL' });
  await assert.rejects(alice.resumeTask(task.id), { code: 'AGENT_TASK_NOT_RESUMABLE' });
  await assert.rejects(alice.saveSkill({ taskId: task.id, name: '取消不能保存' }), { code: 'AGENT_TASK_NOT_COMPLETED' });
  const done = await completed(alice);
  await assert.rejects(alice.resumeTask(done.id), { code: 'AGENT_TASK_NOT_RESUMABLE' });
  await assert.rejects(alice.updateTask(done.id, { status: 'running' }), { code: 'AGENT_TASK_TERMINAL' });
});

test('restart interrupts abandoned running tasks, keeps safe trace and resumes only with user action', async (t) => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'yuanyu-agent-restart-')));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const moduleURL = new URL('../src/agent/store.mjs', import.meta.url).href;
  const config = { dataDir, identity: identities.alice };
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {createAgentStore} from ${JSON.stringify(moduleURL)};const s=createAgentStore(${JSON.stringify(config)});const t=await s.createTask(${JSON.stringify({goal,siteBindings,mode:'mock_browser'})});await s.updateTask(t.id,{status:'running',trace:${JSON.stringify(recipe.slice(0,2))}});process.stdout.write(t.id);`], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const reopened = createAgentStore(config);
  const tasks = await reopened.listTasks();
  assert.equal(tasks[0].id, child.stdout);
  assert.equal(tasks[0].status, 'interrupted');
  assert.deepEqual(tasks[0].trace, recipe.slice(0, 2));
  await assert.rejects(reopened.updateTask(child.stdout, { status: 'completed' }), { code: 'AGENT_TASK_TERMINAL' });
  const resumed = await reopened.resumeTask(child.stdout);
  assert.equal(resumed.attempt, 2);
  assert.equal(resumed.status, 'running');
  assert.equal((await createAgentStore(config).listTasks())[0].status, 'running');
  await reopened.updateTask(child.stdout, { status: 'completed', expectedAttempt: 2, trace: recipe });
  assert.equal((await reopened.saveSkill({ taskId: child.stdout, name: '恢复后的查看' })).template.recipe.length, 5);
});

test('trace rejects dynamic refs, credentials, raw pages, scripts, write locators and foreign sites without changing task', async (t) => {
  const { alice, dataDir } = await fixture(t);
  const task = await create(alice);
  for (const unsafe of [
    { tool: 'observe', siteId: 'procurement', rawPage: '<html>forged</html>' },
    { tool: 'open', siteId: 'procurement', url: 'https://attacker.invalid/' },
    { tool: 'evaluate', siteId: 'procurement', script: 'process.exit()' },
    { tool: 'click', siteId: 'procurement', ref: 'r-dynamic' },
    { tool: 'observe', siteId: 'unbound' },
    { tool: 'click', siteId: 'procurement', locator: { role: 'button', name: '提交审批', readOnly: true } },
    { tool: 'fill', siteId: 'procurement', locator: { role: 'textbox', name: '密码', readOnly: true }, value: 'synthetic-secret-must-not-persist' },
    { tool: 'fill', siteId: 'procurement', locator: { role: 'textbox', name: '月份', readOnly: true }, value: 'password=synthetic-secret-must-not-persist' },
    { tool: 'click', siteId: 'procurement', locator: { role: 'button', name: '查询', readOnly: false } },
    { tool: 'select', siteId: 'procurement', locator: { role: 'textbox', name: '月份', readOnly: true }, value: '2026-09' },
  ]) await assert.rejects(alice.updateTask(task.id, { status: 'running', trace: [unsafe] }));
  await assert.rejects(alice.updateTask(task.id, { status: 'running', message: 'password=synthetic-secret-must-not-persist' }), { code: 'AGENT_SENSITIVE_DATA' });
  await assert.rejects(alice.updateTask(task.id, { status: 'running', steps: [{ label: '观察', status: 'running', rows: [] }] }));
  assert.deepEqual((await alice.listTasks())[0].trace, []);
  const contents = await fs.readFile(path.join(dataDir, 'agents', 'mock-acme', 'alice', 'state.json'), 'utf8');
  assert.ok(!contents.includes('synthetic-secret-must-not-persist'));
  await alice.updateTask(task.id, { status: 'completed' });
  await assert.rejects(alice.saveSkill({ taskId: task.id, name: '无步骤' }), { code: 'AGENT_TRACE_REQUIRED' });
});

test('closed site bindings and repository paths reject injection; root queue serializes instances and live process locks', async (t) => {
  const { dataDir, alice, store } = await fixture(t);
  for (const entry of [
    { ...siteBindings[0], username: 'forged' },
    { ...siteBindings[0], origin: 'https://user:pass@enterprise.invalid' },
    { ...siteBindings[0], origin: 'https://enterprise.invalid/path' },
    { ...siteBindings[0], revision: 0 },
  ]) await assert.rejects(create(alice, { siteBindings: [entry] }));
  await assert.rejects(create(alice, { mode: 'compatible_browser' }), { code: 'AGENT_BINDINGS_INVALID' });
  assert.throws(() => createAgentStore({ dataDir: path.resolve('var'), identity: identities.alice }), { code: 'AGENT_UNSAFE_PATH' });
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => create(store())));
  assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.ok(results.filter((entry) => entry.status === 'rejected').every((entry) => entry.reason.code === 'AGENT_TASK_ACTIVE'));
  const task = (await alice.listTasks())[0];
  await Promise.all(Array.from({ length: 8 }, (_, index) => store().updateTask(task.id, { status: 'running', message: `进度 ${index}` })));
  assert.equal((await alice.listTasks())[0].message, '进度 7');
  const moduleURL = new URL('../src/agent/store.mjs', import.meta.url).href;
  const config = JSON.stringify({ dataDir, identity: identities.alice });
  const otherProcess = spawnSync(process.execPath, ['--input-type=module', '-e', `import {createAgentStore} from ${JSON.stringify(moduleURL)};try{await createAgentStore(${config}).listTasks();process.exitCode=1;}catch(error){process.stdout.write(error.code);}`], { encoding: 'utf8' });
  assert.equal(otherProcess.status, 0, otherProcess.stderr);
  assert.equal(otherProcess.stdout, 'AGENT_STORE_LOCKED');
  const files = await fs.readdir(path.join(dataDir, 'agents', 'mock-acme', 'alice'));
  assert.ok(files.every((file) => !file.endsWith('.tmp')));
  await alice.updateTask(task.id, { status: 'cancelled' });
  const httpsTask = await create(alice, { mode: 'compatible_browser', siteBindings: [{ id: 'site-reports', origin: 'https://reports.example.test', revision: 2 }] });
  assert.equal(httpsTask.mode, 'compatible_browser');
});

test('已验证浏览器步骤可人工定义参数并按修订CAS修改，不能注入recipe或定位器',async t=>{
  const {alice,bob,store}=await fixture(t),source=await completed(alice),skill=await alice.saveSkill({taskId:source.id,name:'原始查询'});
  const definition={name:'month',stepIndex:2,label:'查询月份'};
  const edited=await alice.editSkill({id:skill.id,expectedVersion:1,name:'按月查看',parameters:[definition]});
  assert.equal(edited.version,2);assert.equal(edited.name,'按月查看');assert.equal(edited.template.parameters[0].defaultValue,'2026-09');
  assert.deepEqual(edited.template.recipe,recipe,'参数化不会改写已验证原步骤或来源');
  assert.equal(instantiateSkillRecipe(edited,{month:'2026-10'})[2].value,'2026-10');assert.equal(edited.template.recipe[2].value,'2026-09');
  await assert.rejects(bob.editSkill({id:skill.id,expectedVersion:2,name:'窃取'}),{code:'AGENT_SKILL_NOT_FOUND'});
  await assert.rejects(alice.editSkill({id:skill.id,expectedVersion:1,name:'旧版本'}),{code:'AGENT_SKILL_VERSION_CHANGED'});
  for(const parameters of [
    [{...definition,stepIndex:3}],[{...definition,stepIndex:-1}],[{...definition,stepIndex:999}],
    [definition,{...definition,name:'another'}],[definition,{...definition,stepIndex:0}],
    [{...definition,name:'constructor'}],[{...definition,name:'__proto__'}],[{...definition,defaultValue:'password=synthetic-secret'}],
    [{...definition,locator:{role:'button',name:'删除'}}],
  ])await assert.rejects(alice.editSkill({id:skill.id,expectedVersion:2,parameters}));
  await assert.rejects(alice.editSkill({id:skill.id,expectedVersion:2,recipe:[]}),{code:'AGENT_INPUT_INVALID'});
  assert.equal((await store().listSkills())[0].version,2);
  const changes=await Promise.allSettled([alice.editSkill({id:skill.id,expectedVersion:2,name:'修订A'}),store().editSkill({id:skill.id,expectedVersion:2,name:'修订B'})]);
  assert.equal(changes.filter(item=>item.status==='fulfilled').length,1);assert.equal((await alice.listSkills())[0].version,3);
});

test('运行参数持久化并绑定修订，修改模板后旧暂停任务不能套新版本，旧v1兼容读取',async t=>{
  const {alice}=await fixture(t),source=await completed(alice),skill=await alice.saveSkill({taskId:source.id,name:'查询'});
  await alice.editSkill({id:skill.id,expectedVersion:1,parameters:[{name:'month',stepIndex:2,label:'月份',defaultValue:'2026-10'}]});
  const run=await create(alice,{skillId:skill.id,skillVersion:2,values:{month:'2026-09'}});
  assert.equal(run.skillVersion,2);assert.deepEqual(run.parameterValues,{month:'2026-09'});
  await alice.updateTask(run.id,{status:'awaiting_user',awaitingSiteId:'procurement'});
  const resumed=await alice.resumeTask(run.id);assert.deepEqual(resumed.parameterValues,{month:'2026-09'});
  await alice.updateTask(run.id,{status:'awaiting_user',awaitingSiteId:'procurement'});
  await alice.editSkill({id:skill.id,expectedVersion:2,name:'新修订'});
  await assert.rejects(alice.resumeTask(run.id),{code:'AGENT_SKILL_VERSION_CHANGED'});
  await alice.updateTask(run.id,{status:'cancelled'});
  await assert.rejects(create(alice,{skillId:skill.id,skillVersion:2}),{code:'AGENT_SKILL_VERSION_CHANGED'});
  await assert.rejects(create(alice,{skillId:skill.id,values:{unknown:'anything'}}),{code:'AGENT_INPUT_INVALID'});
  await assert.rejects(create(alice,{skillId:skill.id,values:{month:'Bearer synthetic-secret-value'}}),{code:'AGENT_SENSITIVE_DATA'});
  assert.equal((await alice.listTasks()).length,2,'无效参数不会建立可执行运行');
});
