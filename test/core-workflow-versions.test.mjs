import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspace, listRecipeCatalog, validateWorkflowTemplate } from '../src/core/index.mjs';

const systems = {
  procurement: { id: 'procurement', label: 'Mock采购', origin: 'http://127.0.0.1:41001' },
  warehouse: { id: 'warehouse', label: 'Mock仓储', origin: 'http://127.0.0.1:41002' },
};
const identities = {
  alice: { companyId: 'mock-acme', userId: 'alice', displayName: 'Alice', provider: 'mock' },
  bob: { companyId: 'mock-acme', userId: 'bob', displayName: 'Bob', provider: 'mock' },
  outsider: { companyId: 'mock-other', userId: 'outsider', displayName: 'Outsider', provider: 'mock' },
};

async function fixture(t) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'yuanyu-versions-')));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const key = randomBytes(32);
  const cryptoAdapter = { available: () => true,
    encrypt(text) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64')).join('.');
    },
    decrypt(text) {
      const [iv, tag, data] = text.split('.').map((part) => Buffer.from(part, 'base64'));
      const cipher = createDecipheriv('aes-256-gcm', key, iv);
      cipher.setAuthTag(tag);
      return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8');
    } };
  const workspace = (user = 'alice') => createWorkspace({ dataDir, systems, cryptoAdapter, identity: identities[user] });
  const statePath = (user = 'alice') => path.join(dataDir, 'companies', identities[user].companyId, 'users', user, 'state.json');
  return { dataDir, workspace, statePath, alice: workspace(), bob: workspace('bob'), outsider: workspace('outsider') };
}

async function complete(workspace, workflow) {
  const run = await workspace.beginRun({ month: workflow?.parameters.month ?? '2026-10', ...(workflow ? { workflowId: workflow.id } : {}) });
  return workspace.updateRun(run.id, { status: 'completed', summary: { month: run.month, orderCount: 1 } });
}
async function initial(workspace) {
  const run = await complete(workspace);
  return workspace.saveWorkflowFromRun({ runId: run.id, name: '原采购月报', pinned: true });
}

test('edit, verify, republish and restore create immutable versions and independent fixed company copies', async (t) => {
  const { alice, bob } = await fixture(t);
  const workflow = await initial(alice);
  const firstHistory = await alice.workflowVersions(workflow.id);
  const firstPublication = await alice.publishWorkflow(workflow.id);
  const firstCopy = await bob.importWorkflow(firstPublication.id);

  const edited = await alice.editWorkflow({ id: workflow.id, expectedVersion: 1, name: '九月采购核对', description: '保留待核实项，生成业务草稿。', month: '2026-09' });
  assert.equal(edited.version, 2);
  assert.equal(edited.verified, false);
  assert.equal(edited.verifiedAt, undefined);
  assert.equal(edited.enabled, true);
  assert.equal(edited.pinned, true);
  assert.deepEqual((await alice.workflowVersions(workflow.id)).at(-1), firstHistory[0]);
  assert.deepEqual((await bob.snapshot()).shared, []);
  await assert.rejects(bob.importWorkflow(firstPublication.id), { code: 'NOT_FOUND' });
  await assert.rejects(alice.publishWorkflow(workflow.id), { code: 'UNVERIFIED_WORKFLOW' });
  const editedRun = await complete(alice, edited);
  assert.equal(editedRun.month, '2026-09');
  assert.equal(editedRun.workflowVersion, 2);
  assert.equal((await alice.snapshot()).workflows[0].verified, true);
  const secondPublication = await alice.publishWorkflow(workflow.id);
  assert.notEqual(secondPublication.id, firstPublication.id);
  assert.equal(secondPublication.workflowVersion, 2);
  assert.equal(secondPublication.template.parameters.month, '2026-09');
  assert.equal(secondPublication.template.description, edited.description);
  const secondCopy = await bob.importWorkflow(secondPublication.id);
  assert.equal(secondCopy.version, 1);
  assert.equal(secondCopy.source.publication.workflowVersion, 2);
  assert.equal(secondCopy.verified, false);
  assert.deepEqual((await bob.snapshot()).credentials, []);
  await assert.rejects(bob.withCredential('procurement', () => assert.fail('must use own credential')), { code: 'CREDENTIAL_REQUIRED' });

  const beforeRestore = await alice.workflowVersions(workflow.id);
  const restored = await alice.restoreWorkflow({ id: workflow.id, version: 1, expectedVersion: 2 });
  assert.equal(restored.version, 3);
  assert.equal(restored.name, workflow.name);
  assert.equal(restored.description, '');
  assert.equal(restored.parameters.month, '2026-10');
  assert.equal(restored.verified, false);
  assert.equal((await alice.workflowVersions(workflow.id))[0].restoredFrom, 1);
  assert.deepEqual((await alice.workflowVersions(workflow.id)).slice(1), beforeRestore);
  await assert.rejects(bob.importWorkflow(secondPublication.id), { code: 'NOT_FOUND' });
  const copySnapshot = await bob.snapshot();
  assert.equal(copySnapshot.workflows.find((entry) => entry.id === firstCopy.id).parameters.month, '2026-10');
  assert.equal(copySnapshot.workflows.find((entry) => entry.id === secondCopy.id).parameters.month, '2026-09');
  await assert.rejects(alice.publishWorkflow(workflow.id), { code: 'UNVERIFIED_WORKFLOW' });
  assert.equal((await complete(alice, restored)).workflowVersion, 3);
  const thirdPublication = await alice.publishWorkflow(workflow.id);
  assert.equal(thirdPublication.workflowVersion, 3);
  assert.equal((await bob.snapshot()).shared.length, 1);
  assert.deepEqual(await alice.publishWorkflow(workflow.id), thirdPublication);
  const history = await alice.workflowVersions(workflow.id);
  history[0].parameters.month = '2020-01';
  assert.equal((await alice.workflowVersions(workflow.id))[0].parameters.month, '2026-10');
});

test('revision CAS serializes concurrent edits and rejects stale, foreign and executable changes', async (t) => {
  const { alice, bob, outsider, workspace } = await fixture(t);
  const workflow = await initial(alice);
  const results = await Promise.allSettled([
    alice.editWorkflow({ id: workflow.id, expectedVersion: 1, name: '第一编辑' }),
    workspace().editWorkflow({ id: workflow.id, expectedVersion: 1, month: '2026-09' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'VERSION_CONFLICT');
  const current = (await alice.snapshot()).workflows[0];
  for (const action of [
    () => alice.editWorkflow({ id: workflow.id, expectedVersion: 1, name: '过期编辑' }),
    () => alice.restoreWorkflow({ id: workflow.id, expectedVersion: 1, version: 1 }),
    () => alice.setWorkflowEnabled({ id: workflow.id, expectedVersion: 1, enabled: false }),
  ]) await assert.rejects(action(), { code: 'VERSION_CONFLICT' });
  for (const payload of [ { steps: [{ script: 'process.exit()' }] }, { recipeId: 'arbitrary-js' },
    { parameters: { month: '2026-09' } }, { password: 'forbidden' }, { name: '   ' }, { month: '2026-13' } ]) {
    await assert.rejects(alice.editWorkflow({ id: workflow.id, expectedVersion: 2, ...payload }));
  }
  await assert.rejects(alice.editWorkflow({ id: workflow.id, name: '缺少CAS' }), { code: 'INVALID_INPUT' });
  await assert.rejects(alice.restoreWorkflow({ id: workflow.id, expectedVersion: 2, version: 999 }), { code: 'NOT_FOUND' });
  for (const foreign of [bob, outsider]) {
    await assert.rejects(foreign.workflowVersions(workflow.id), { code: 'NOT_FOUND' });
    await assert.rejects(foreign.editWorkflow({ id: workflow.id, expectedVersion: 2, name: '窃取' }), { code: 'NOT_FOUND' });
    await assert.rejects(foreign.restoreWorkflow({ id: workflow.id, expectedVersion: 2, version: 1 }), { code: 'NOT_FOUND' });
    await assert.rejects(foreign.setWorkflowEnabled({ id: workflow.id, expectedVersion: 2, enabled: false }), { code: 'NOT_FOUND' });
  }
  assert.deepEqual((await alice.snapshot()).workflows[0], current);
  assert.equal((await alice.workflowVersions(workflow.id)).length, 2);
});

test('disable withdraws publication, blocks runs and requires a fresh revision run after enable', async (t) => {
  const { alice, bob } = await fixture(t);
  const workflow = await initial(alice);
  const publication = await alice.publishWorkflow(workflow.id);
  const copy = await bob.importWorkflow(publication.id);
  const inFlight = await alice.beginRun({ month: '2026-10', workflowId: workflow.id });
  const disabled = await alice.setWorkflowEnabled({ id: workflow.id, expectedVersion: 1, enabled: false });
  assert.equal(disabled.version, 2);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.verified, false);
  await assert.rejects(alice.beginRun({ month: '2026-10', workflowId: workflow.id }), { code: 'WORKFLOW_DISABLED' });
  await assert.rejects(alice.publishWorkflow(workflow.id), { code: 'WORKFLOW_DISABLED' });
  await assert.rejects(bob.importWorkflow(publication.id), { code: 'NOT_FOUND' });
  const enabled = await alice.setWorkflowEnabled({ id: workflow.id, expectedVersion: 2, enabled: true });
  assert.equal(enabled.version, 3);
  await alice.updateRun(inFlight.id, { status: 'completed' });
  assert.equal((await alice.snapshot()).workflows[0].verified, false, 'completion before disable cannot verify new revision');
  await assert.rejects(alice.publishWorkflow(workflow.id), { code: 'UNVERIFIED_WORKFLOW' });
  await complete(alice, enabled);
  const nextPublication = await alice.publishWorkflow(workflow.id);
  assert.equal(nextPublication.workflowVersion, 3);
  assert.equal((await bob.snapshot()).workflows.find((entry) => entry.id === copy.id).enabled, true);
  const disabledAgain = await alice.setWorkflowEnabled({ id: workflow.id, expectedVersion: 3, enabled: false });
  const restored = await alice.restoreWorkflow({ id: workflow.id, expectedVersion: disabledAgain.version, version: 1 });
  assert.equal(restored.enabled, false, 'restoring content does not silently enable a disabled workflow');
  await assert.rejects(alice.beginRun({ month: '2026-10', workflowId: workflow.id }), { code: 'WORKFLOW_DISABLED' });
});

test('a run of an earlier edited revision cannot verify the new revision', async (t) => {
  const { alice } = await fixture(t);
  const workflow = await initial(alice);
  const run = await alice.beginRun({ month: '2026-10', workflowId: workflow.id });
  const edited = await alice.editWorkflow({ id: workflow.id, expectedVersion: 1, month: '2026-09' });
  await alice.updateRun(run.id, { status: 'completed' });
  assert.equal((await alice.snapshot()).workflows[0].verified, false);
  await complete(alice, edited);
  assert.equal((await alice.publishWorkflow(workflow.id)).workflowVersion, 2);
});

test('schema 1 migrates atomically without losing credentials, verification or old signed publications', async (t) => {
  const { dataDir, alice, bob, workspace, statePath } = await fixture(t);
  await alice.saveCredential({ systemId: 'procurement', username: 'synthetic-migration-owner', password: 'synthetic-migration-password' });
  const workflow = await initial(alice);
  const publication = await alice.publishWorkflow(workflow.id);
  const imported = await bob.importWorkflow(publication.id);
  await complete(bob, imported);
  const key = await fs.readFile(path.join(dataDir, '.publication-key'));
  const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((entry) => `${JSON.stringify(entry)}:${canonical(value[entry])}`).join(',')}}` : JSON.stringify(value);
  const legacyPublication = structuredClone(publication);
  delete legacyPublication.workflowVersion;
  delete legacyPublication.signature;
  legacyPublication.signature = createHmac('sha256', key).update(canonical(legacyPublication)).digest('hex');
  await fs.writeFile(path.join(dataDir, 'companies', 'mock-acme', 'publications.json'), JSON.stringify({ schemaVersion: 1, companyId: 'mock-acme', publications: [legacyPublication] }));
  for (const user of ['alice', 'bob']) {
    const state = JSON.parse(await fs.readFile(statePath(user), 'utf8'));
    state.schemaVersion = 1;
    delete state.workflowVersions;
    for (const entry of state.workflows) {
      delete entry.description;
      delete entry.enabled;
      if (entry.source.kind === 'company-template') entry.source.publication = legacyPublication;
    }
    for (const entry of state.runs) delete entry.workflowVersion;
    await fs.writeFile(statePath(user), JSON.stringify(state));
  }
  const reopened = workspace();
  const migrated = await reopened.snapshot();
  assert.equal(migrated.workflows[0].enabled, true);
  assert.equal(migrated.workflows[0].description, '');
  assert.equal(migrated.workflows[0].verified, true);
  await reopened.withCredential('procurement', (credential) => assert.equal(credential.username, 'synthetic-migration-owner'));
  assert.equal((await reopened.workflowVersions(workflow.id))[0].change, 'migrated');
  assert.equal(JSON.parse(await fs.readFile(statePath(), 'utf8')).schemaVersion, 2);
  assert.equal((await workspace('bob').snapshot()).workflows[0].verified, true);
  assert.equal((await bob.importWorkflow(legacyPublication.id)).enabled, true);
  await reopened.editWorkflow({ id: workflow.id, expectedVersion: 1, month: '2026-09' });
  assert.equal((await bob.snapshot()).shared.length, 0);
});

test('candidate template schema and signed import reject steps, credentials and unknown recipes', async (t) => {
  const { alice, bob, dataDir } = await fixture(t);
  const catalog = listRecipeCatalog();
  assert.equal(catalog[0].mode, 'preset_mock');
  catalog[0].parameters.month.default = '2020-01';
  assert.equal((await alice.recipeCatalog())[0].parameters.month.default, '2026-10');
  const candidate = { name: '候选月报', description: '说明仅作描述', recipeId: 'purchase-monthly', parameters: { month: '2026-09' } };
  assert.equal(validateWorkflowTemplate(candidate).parameters.month, '2026-09');
  for (const extra of [ { steps: [] }, { script: 'return process.env' }, { credentials: { username: 'owner' } },
    { source: { kind: 'completed-run', runId: 'forged' } }, { recipeId: 'run-js' }, { parameters: { month: '2026-09', password: 'forged' } } ]) {
    assert.throws(() => validateWorkflowTemplate({ ...candidate, ...extra }));
  }
  const workflow = await initial(alice);
  const publication = await alice.publishWorkflow(workflow.id);
  const filename = path.join(dataDir, 'companies', 'mock-acme', 'publications.json');
  const original = await fs.readFile(filename, 'utf8');
  for (const extra of [ { steps: [{ tool: 'shell', script: 'forged' }] }, { credentials: { password: 'forged' } } ]) {
    const stored = JSON.parse(original);
    Object.assign(stored.publications[0].template, extra);
    await fs.writeFile(filename, JSON.stringify(stored));
    await assert.rejects(bob.importWorkflow(publication.id), { code: 'INVALID_PUBLICATION' });
  }
  await fs.writeFile(filename, original);
  const copy = await bob.importWorkflow(publication.id);
  assert.equal(copy.verified, false);
  assert.deepEqual((await bob.snapshot()).runs, []);
});
