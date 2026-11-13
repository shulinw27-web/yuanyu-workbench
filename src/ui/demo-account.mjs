// Public synthetic fixtures for the local demo account service only.
// Never read from the credential vault, never used for configured/production services.
export const DEMO_ACCOUNT = Object.freeze({
  email: 'tester@local.example.invalid',
  name: '合成测试员',
  password: 'synth-test-2026'
});
export const DEMO_SYSTEM_CREDENTIAL = Object.freeze({ username: 'demo', password: 'demo123' });

const DEMO_SYSTEM_IDS = Object.freeze(['procurement', 'warehouse']);

/** Returns fixtures only while the trusted main process reports a local synthetic demo deployment. */
export function demoAccountFor(deployment) {
  return deployment === 'local_demo' ? DEMO_ACCOUNT : null;
}
/** Prefill site credentials only for the two built-in synthetic systems. */
export function demoSystemCredentialFor(deployment, systemId) {
  return deployment === 'local_demo' && DEMO_SYSTEM_IDS.includes(systemId) ? DEMO_SYSTEM_CREDENTIAL : null;
}
