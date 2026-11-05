import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createWorkspace } from '../src/core/index.mjs';

const systems = {
  procurement: { id: 'procurement', label: 'Mock采购', origin: 'http://127.0.0.1:41001' },
  warehouse: { id: 'warehouse', label: 'Mock仓储', origin: 'http://127.0.0.1:41002' },
};
const identities = {
  alice: { companyId: 'mock-acme', userId: 'alice', displayName: 'Alice', provider: 'mock' },
  bob: { companyId: 'mock-acme', userId: 'bob', displayName: 'Bob', provider: 'mock' },
  outsider: { companyId: 'mock-other', userId: 'outsider', displayName: 'Outsider', provider: 'mock' },
};

// Deliberately test-only: production receives Electron safeStorage, with no fallback.
function encryptedAdapter(key = randomBytes(32)) {
  return {
    available: () => true,
    encrypt(text) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return [iv, cipher.getAuthTag(), ciphertext].map((item) => item.toString('base64')).join('.');
    },
    decrypt(text) {
      const [iv, tag, ciphertext] = text.split('.').map((item) => Buffer.from(item, 'base64'));
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    },
  };
}

async function fixture(t) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'yuanyu-core-')));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const cryptoAdapter = encryptedAdapter();
  const workspace = (user = 'alice', options = {}) => createWorkspace({ dataDir, cryptoAdapter, systems,
    identity: identities[user], ...options });
  return { dataDir, cryptoAdapter, workspace, alice: workspace('alice'), bob: workspace('bob'), outsider: workspace('outsider') };
}

const summary = (month = '2026-10') => ({ month, orderCount: 3, receiptCount: 2, orderedCents: 530000,
  receivedCents: 250000, outstandingCents: 280000, unmatchedCount: 1, partialCount: 1,
  overReceivedCount: 0, excludedOrderCount: 1, ignoredReceiptCount: 0 });

async function completed(workspace, month = '2026-10', patch = {}) {
  const run = await workspace.beginRun({ month });
  return workspace.updateRun(run.id, { status: 'completed', summary: summary(month), ...patch });
}

async function published(workspace) {
  const run = await completed(workspace);
  const workflow = await workspace.saveWorkflowFromRun({ runId: run.id, name: '采购入库月报', pinned: true });
  const publication = await workspace.publishWorkflow(workflow.id);
  return { run, workflow, publication };
}

async function allFiles(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await allFiles(filename));
    else result.push(filename);
  }
  return result;
}

test('credentials encrypt both account and password; only a trusted callback receives cleartext', async (t) => {
  const { alice, dataDir, workspace } = await fixture(t);
  const username = 'synthetic-alice-account-unique-7c41';
  const password = 'synthetic-password-unique-54f7';
  const saved = await alice.saveCredential({ systemId: 'procurement', username, password });
  assert.equal(saved.usernameMasked, '••••');
  assert.equal(saved.username, '••••');
  let borrowed;
  const value = await alice.withCredential('procurement', async (credential) => {
    borrowed = credential;
    assert.deepEqual(credential, { username, password, origin: systems.procurement.origin });
    return 'trusted browser result';
  });
  assert.equal(value, 'trusted browser result');
  assert.equal(borrowed.password, '');
  assert.equal(borrowed.username, '');
  const snapshot = await alice.snapshot();
  assert.equal(snapshot.credentials[0].origin, systems.procurement.origin);
  for (const sensitive of [username, password, 'ciphertext', 'password']) assert.ok(!JSON.stringify(snapshot).includes(sensitive));
  for (const filename of await allFiles(dataDir)) {
    const bytes = await fs.readFile(filename);
    assert.ok(!bytes.includes(Buffer.from(username)), `plaintext username in ${path.basename(filename)}`);
    assert.ok(!bytes.includes(Buffer.from(password)), `plaintext password in ${path.basename(filename)}`);
  }
  const reopened = workspace('alice');
  assert.equal((await reopened.snapshot()).credentials[0].id, saved.id);
  await reopened.withCredential('procurement', (credential) => assert.equal(credential.password, password));
});

test('company import shares only the template and requires each person’s own credentials', async (t) => {
  const { alice, bob, outsider } = await fixture(t);
  await alice.saveCredential({ systemId: 'procurement', username: 'synthetic-owner-account', password: 'synthetic-owner-password' });
  const { run, workflow, publication } = await published(alice);
  assert.deepEqual(Object.keys(publication.template).sort(), ['name', 'parameters', 'recipeId', 'version']);
  assert.equal(publication.publisher.userId, 'alice');
  assert.equal(publication.companyId, 'mock-acme');
  assert.equal((await bob.snapshot()).shared.length, 1);
  assert.equal((await outsider.snapshot()).shared.length, 0);
  const imported = await bob.importWorkflow(publication.id);
  assert.notEqual(imported.id, workflow.id);
  assert.equal(imported.verified, false);
  assert.equal(imported.source.publication.publisher.userId, 'alice');
  const bobSnapshot = await bob.snapshot();
  assert.deepEqual(bobSnapshot.credentials, []);
  assert.deepEqual(bobSnapshot.runs, []);
  assert.ok(!JSON.stringify(bobSnapshot).includes(run.id));
  assert.ok(!JSON.stringify(bobSnapshot).includes('synthetic-owner'));
  await assert.rejects(bob.withCredential('procurement', () => assert.fail('must not borrow alice credential')), { code: 'CREDENTIAL_REQUIRED' });
  await assert.rejects(bob.publishWorkflow(imported.id), { code: 'UNVERIFIED_WORKFLOW' });
  await bob.saveCredential({ systemId: 'procurement', username: 'synthetic-bob-account', password: 'synthetic-bob-password' });
  await bob.withCredential('procurement', (credential) => {
    assert.equal(credential.username, 'synthetic-bob-account');
    assert.equal(credential.password, 'synthetic-bob-password');
  });
  const bobRun = await bob.beginRun({ month: '2026-09', workflowId: imported.id });
  await bob.updateRun(bobRun.id, { status: 'completed', summary: summary('2026-09') });
  assert.equal((await bob.snapshot()).workflows[0].verified, true);
  assert.equal((await bob.publishWorkflow(imported.id)).publisher.userId, 'bob');
  assert.equal((await alice.snapshot()).runs.length, 1);
});

test('cross-company, cross-user and forged identity actions fail without modifying owner state', async (t) => {
  const { alice, bob, outsider, workspace } = await fixture(t);
  const credential = await alice.saveCredential({ systemId: 'warehouse', username: 'owner-warehouse-unique', password: 'owner-password-unique' });
  const { run, workflow, publication } = await published(alice);
  await assert.rejects(outsider.importWorkflow(publication.id), { code: 'NOT_FOUND' });
  await assert.rejects(outsider.revokePublication(publication.id), { code: 'NOT_FOUND' });
  await assert.rejects(bob.revokePublication(publication.id), { code: 'FORBIDDEN' });
  await assert.rejects(bob.deleteCredential(credential.id), { code: 'NOT_FOUND' });
  await assert.rejects(bob.setPinned(workflow.id, false), { code: 'NOT_FOUND' });
  await assert.rejects(bob.deleteWorkflow(workflow.id), { code: 'NOT_FOUND' });
  await assert.rejects(bob.publishWorkflow(workflow.id), { code: 'NOT_FOUND' });
  await assert.rejects(bob.saveWorkflowFromRun({ runId: run.id, name: 'stolen' }), { code: 'NOT_FOUND' });
  await assert.rejects(bob.updateRun(run.id, { status: 'failed' }), { code: 'NOT_FOUND' });
  assert.throws(() => workspace('alice', { identity: { ...identities.alice, companyId: 'mock-other' } }), { code: 'INVALID_IDENTITY' });
  assert.equal((await alice.snapshot()).credentials.length, 1);
  assert.equal((await alice.snapshot()).shared.length, 1);
});

test('deleting credentials withdraws future use, and deleting a workflow withdraws its company publication', async (t) => {
  const { alice, bob } = await fixture(t);
  const first = await alice.saveCredential({ systemId: 'procurement', username: 'initial-owner-account', password: 'initial-owner-password' });
  const replacement = await alice.saveCredential({ systemId: 'procurement', username: 'replacement-owner-account', password: 'replacement-owner-password' });
  assert.equal(first.id, replacement.id);
  assert.equal((await alice.snapshot()).credentials.length, 1);
  await alice.deleteCredential(first.id);
  await assert.rejects(alice.withCredential('procurement', () => assert.fail('deleted credential must not be used')), { code: 'CREDENTIAL_REQUIRED' });
  assert.deepEqual((await alice.snapshot()).credentials, []);
  const { workflow, publication } = await published(alice);
  await alice.deleteWorkflow(workflow.id);
  assert.deepEqual((await alice.snapshot()).workflows, []);
  assert.deepEqual((await bob.snapshot()).shared, []);
  await assert.rejects(bob.importWorkflow(publication.id), { code: 'NOT_FOUND' });
});

test('author revocation prevents new imports while an already imported personal copy stays independent', async (t) => {
  const { alice, bob } = await fixture(t);
  const { publication } = await published(alice);
  const personal = await bob.importWorkflow(publication.id);
  await alice.revokePublication(publication.id);
  await assert.rejects(bob.importWorkflow(publication.id), { code: 'NOT_FOUND' });
  assert.equal((await bob.snapshot()).workflows[0].id, personal.id);
  assert.equal((await bob.snapshot()).workflows[0].verified, false);
});

test('crypto unavailability, encryption failure and decrypt failure all fail closed', async (t) => {
  const { dataDir, alice, workspace } = await fixture(t);
  const username = 'crypto-failure-account-unique';
  const password = 'crypto-failure-password-unique';
  const locked = workspace('alice', { cryptoAdapter: { available: () => false } });
  await assert.rejects(locked.saveCredential({ systemId: 'procurement', username, password }), { code: 'CRYPTO_UNAVAILABLE' });
  const identityCipher = workspace('alice', { cryptoAdapter: { available: () => true, encrypt: (value) => value, decrypt: (value) => value } });
  await assert.rejects(identityCipher.saveCredential({ systemId: 'procurement', username, password }), { code: 'CRYPTO_FAILED' });
  assert.deepEqual((await alice.snapshot()).credentials, []);
  await alice.saveCredential({ systemId: 'procurement', username, password });
  await assert.rejects(locked.withCredential('procurement', () => assert.fail('locked credential callback')), { code: 'CRYPTO_UNAVAILABLE' });
  const wrongKey = workspace('alice', { cryptoAdapter: encryptedAdapter() });
  await assert.rejects(wrongKey.withCredential('procurement', () => assert.fail('wrong-key callback')), { code: 'CRYPTO_FAILED' });
  for (const filename of await allFiles(dataDir)) {
    const content = await fs.readFile(filename);
    assert.ok(!content.includes(Buffer.from(username)));
    assert.ok(!content.includes(Buffer.from(password)));
  }
});

test('credential origin changes require rebinding, and moving ciphertext to another user does not grant access', async (t) => {
  const { dataDir, alice, bob, workspace } = await fixture(t);
  await alice.saveCredential({ systemId: 'procurement', username: 'origin-bound-owner-account', password: 'origin-bound-owner-password' });
  const changedSystems = { ...systems, procurement: { ...systems.procurement, origin: 'http://127.0.0.1:41003' } };
  const changed = workspace('alice', { systems: changedSystems });
  assert.equal((await changed.snapshot()).credentials[0].needsRebind, true);
  await assert.rejects(changed.withCredential('procurement', () => assert.fail('must not fill a new origin')), { code: 'CREDENTIAL_ORIGIN_MISMATCH' });
  await changed.saveCredential({ systemId: 'procurement', username: 'rebound-owner-account', password: 'rebound-owner-password' });
  await changed.withCredential('procurement', (credential) => assert.equal(credential.origin, changedSystems.procurement.origin));
  await assert.rejects(alice.withCredential('procurement', () => assert.fail('old origin has no authority')), { code: 'CREDENTIAL_ORIGIN_MISMATCH' });

  await bob.snapshot();
  const ownerPath = path.join(dataDir, 'companies', 'mock-acme', 'users', 'alice', 'state.json');
  const bobPath = path.join(dataDir, 'companies', 'mock-acme', 'users', 'bob', 'state.json');
  const ownerState = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
  // A corrupted private file may contain another person's encrypted blob. The encrypted
  // identity/origin bindings must still refuse to reveal it, even with the same OS key.
  await fs.writeFile(bobPath, JSON.stringify({ schemaVersion: 1, companyId: 'mock-acme', userId: 'bob',
    credentials: ownerState.credentials, workflows: [], runs: [] }));
  const bobAtNewOrigin = workspace('bob', { systems: changedSystems });
  await assert.rejects(bobAtNewOrigin.withCredential('procurement', () => assert.fail('copied ciphertext must not grant owner authority')), { code: 'CRYPTO_FAILED' });
});

test('run state transitions reject stale completion after cancellation and cannot create a skill before completion', async (t) => {
  const { alice } = await fixture(t);
  const run = await alice.beginRun({ month: '2026-10' });
  await assert.rejects(alice.beginRun({ month: '2026-09' }), { code: 'RUN_ACTIVE' });
  await assert.rejects(alice.saveWorkflowFromRun({ runId: run.id, name: 'too early' }), { code: 'RUN_NOT_COMPLETED' });
  await assert.rejects(alice.updateRun(run.id, { status: 'invented' }), { code: 'INVALID_TRANSITION' });
  await assert.rejects(alice.updateRun(run.id, { status: 'running', error: 'not terminal' }), { code: 'INVALID_TRANSITION' });
  await assert.rejects(alice.updateRun(run.id, { steps: [{ label: 'unsafe', status: 'completed', password: 'forbidden' }] }), { code: 'INVALID_INPUT' });
  await assert.rejects(alice.updateRun(run.id, { summary: { month: '2026-10', rows: [] } }), { code: 'INVALID_INPUT' });
  await alice.updateRun(run.id, { status: 'cancelled', error: { code: 'CANCELLED', message: '用户取消。' } });
  await assert.rejects(alice.updateRun(run.id, { status: 'completed', summary: summary() }), { code: 'INVALID_TRANSITION' });
  await assert.rejects(alice.updateRun(run.id, { steps: [] }), { code: 'INVALID_TRANSITION' });
  await assert.rejects(alice.saveWorkflowFromRun({ runId: run.id, name: 'cancelled' }), { code: 'RUN_NOT_COMPLETED' });
  assert.equal((await alice.snapshot()).runs[0].status, 'cancelled');
  await assert.rejects(alice.beginRun({ month: '2026-13' }), { code: 'INVALID_MONTH' });
  await assert.rejects(alice.beginRun({ month: '../../2026-10' }), { code: 'INVALID_MONTH' });
});

test('artifact metadata is verified against the current identity output folder and carries no file content into templates', async (t) => {
  const { dataDir, alice, bob } = await fixture(t);
  const output = path.join(dataDir, 'outputs', 'mock-acme', 'alice');
  await fs.mkdir(output, { recursive: true });
  const csvPath = path.join(output, 'report.csv');
  const sourcePath = path.join(output, 'report.sources.json');
  const body = 'order_id,amount_cents\nSYNTHETIC_001,530000\n';
  await fs.writeFile(csvPath, body);
  await fs.writeFile(sourcePath, JSON.stringify({ mode: 'synthetic' }));
  const artifact = { path: csvPath, name: 'report.csv', mime: 'text/csv', bytes: Buffer.byteLength(body),
    sha256: createHash('sha256').update(body).digest('hex'), sourcePath };
  const run = await alice.beginRun({ month: '2026-10' });
  await assert.rejects(alice.updateRun(run.id, { status: 'completed', artifact: { ...artifact, path: path.join(dataDir, '.publication-key') } }), { code: 'UNSAFE_ARTIFACT' });
  await assert.rejects(alice.updateRun(run.id, { status: 'completed', artifact: { ...artifact, sha256: '0'.repeat(64) } }), { code: 'UNSAFE_ARTIFACT' });
  const result = await alice.updateRun(run.id, { status: 'completed', artifact, summary: summary() });
  assert.deepEqual(result.artifact, artifact);
  assert.ok(!JSON.stringify(result).includes(body));
  const workflow = await alice.saveWorkflowFromRun({ runId: run.id, name: 'verified artifact' });
  const publication = await alice.publishWorkflow(workflow.id);
  assert.ok(!JSON.stringify(publication).includes(csvPath));
  assert.ok(!JSON.stringify(publication).includes('SYNTHETIC_001'));
  const bobRun = await bob.beginRun({ month: '2026-10' });
  await assert.rejects(bob.updateRun(bobRun.id, { status: 'completed', artifact }), { code: 'UNSAFE_ARTIFACT' });
});

test('publication signatures reject template version drift and forged publisher identity', async (t) => {
  const { dataDir, alice, bob } = await fixture(t);
  const { publication } = await published(alice);
  const filename = path.join(dataDir, 'companies', 'mock-acme', 'publications.json');
  const original = await fs.readFile(filename, 'utf8');
  for (const mutate of [
    (entry) => { entry.template.version = 2; },
    (entry) => { entry.publisher.userId = 'bob'; },
    (entry) => { entry.template.parameters.month = '2026-09'; },
    (entry) => { entry.companyId = 'mock-other'; },
    (entry) => { entry.template.credentials = { password: 'forged' }; },
  ]) {
    const stored = JSON.parse(original);
    mutate(stored.publications[0]);
    await fs.writeFile(filename, JSON.stringify(stored));
    await assert.rejects(bob.importWorkflow(publication.id), { code: 'INVALID_PUBLICATION' });
  }
  await fs.writeFile(filename, original);
  assert.equal((await bob.importWorkflow(publication.id)).version, 1);
});

test('single-process instances serialize updates, preserve every workflow and do not leave temp files', async (t) => {
  const { dataDir, alice, workspace } = await fixture(t);
  const run = await completed(alice);
  const instances = Array.from({ length: 15 }, () => workspace('alice'));
  const workflows = await Promise.all(instances.map((instance, index) => instance.saveWorkflowFromRun({ runId: run.id, name: `synthetic-${index}`, pinned: index % 2 === 0 })));
  assert.equal(new Set(workflows.map((workflow) => workflow.id)).size, 15);
  const snapshot = await alice.snapshot();
  assert.equal(snapshot.workflows.length, 15);
  assert.equal(snapshot.workflows.filter((workflow) => workflow.pinned).length, 8);
  await Promise.all(workflows.map((workflow, index) => instances[index].setPinned(workflow.id, false)));
  assert.ok((await alice.snapshot()).workflows.every((workflow) => !workflow.pinned));
  assert.ok((await allFiles(dataDir)).every((filename) => !filename.endsWith('.tmp')));
});

test('unapproved origins and repository-local data paths are rejected', async (t) => {
  const { alice, workspace } = await fixture(t);
  await assert.rejects(alice.saveCredential({ systemId: 'unlisted', username: 'synthetic', password: 'synthetic' }), { code: 'UNKNOWN_SYSTEM' });
  await assert.rejects(alice.saveCredential({ systemId: 'procurement', username: 'synthetic', password: 'synthetic', origin: 'https://evil.invalid' }), { code: 'INVALID_INPUT' });
  assert.throws(() => workspace('alice', { systems: { procurement: { ...systems.procurement, origin: 'https://example.invalid/login' } } }), { code: 'INVALID_SYSTEM' });
  assert.throws(() => createWorkspace({ dataDir: path.resolve('var'), identity: identities.alice, systems }), { code: 'UNSAFE_PATH' });
});

test('another live process cannot open a data directory, and restart converts abandoned running work to INTERRUPTED', async (t) => {
  const { dataDir, alice } = await fixture(t);
  await alice.snapshot();
  const moduleURL = new URL('../src/core/index.mjs', import.meta.url).href;
  const config = JSON.stringify({ dataDir, systems, identity: identities.alice });
  const locked = spawnSync(process.execPath, ['--input-type=module', '-e', `import {createWorkspace} from ${JSON.stringify(moduleURL)}; try { await createWorkspace(${config}).snapshot(); process.exitCode=1; } catch(e) { process.stdout.write(e.code); }`], { encoding: 'utf8' });
  assert.equal(locked.status, 0, locked.stderr);
  assert.equal(locked.stdout, 'WORKSPACE_LOCKED');

  const abandonedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuanyu-core-restart-'));
  t.after(() => fs.rm(abandonedDir, { recursive: true, force: true }));
  const abandonedConfig = JSON.stringify({ dataDir: abandonedDir, systems, identity: identities.alice });
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {createWorkspace} from ${JSON.stringify(moduleURL)}; const w=createWorkspace(${abandonedConfig}); const r=await w.beginRun({month:'2026-10'}); process.stdout.write(r.id);`], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const reopened = createWorkspace({ dataDir: abandonedDir, systems, identity: identities.alice, cryptoAdapter: encryptedAdapter() });
  const snapshot = await reopened.snapshot();
  assert.equal(snapshot.runs[0].id, child.stdout);
  assert.equal(snapshot.runs[0].status, 'failed');
  assert.equal(snapshot.runs[0].error.code, 'INTERRUPTED');
  await assert.rejects(reopened.updateRun(child.stdout, { status: 'completed' }), { code: 'INVALID_TRANSITION' });
  assert.equal((await reopened.beginRun({ month: '2026-09' })).status, 'running');
});
