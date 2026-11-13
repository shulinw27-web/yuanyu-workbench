import test from 'node:test';
import assert from 'node:assert/strict';
import {DEMO_ACCOUNT,DEMO_SYSTEM_CREDENTIAL,demoAccountFor,demoSystemCredentialFor} from '../src/ui/demo-account.mjs';

test('测试账号只在本机合成演示部署可用，正式服务一律不预填',()=>{
  assert.equal(demoAccountFor('local_demo'),DEMO_ACCOUNT);
  for(const deployment of ['configured','unconfigured','enterprise',undefined,null,''])assert.equal(demoAccountFor(deployment),null);
  assert.equal(demoSystemCredentialFor('local_demo','procurement'),DEMO_SYSTEM_CREDENTIAL);
  assert.equal(demoSystemCredentialFor('local_demo','warehouse'),DEMO_SYSTEM_CREDENTIAL);
  assert.equal(demoSystemCredentialFor('configured','procurement'),null);
  assert.equal(demoSystemCredentialFor('local_demo','custom-site'),null);
  assert.equal(demoSystemCredentialFor('local_demo',undefined),null);
});

test('测试账号是固定公开合成数据，不含真实凭据或业务内容',()=>{
  assert.equal(Object.isFrozen(DEMO_ACCOUNT),true);
  assert.equal(Object.isFrozen(DEMO_SYSTEM_CREDENTIAL),true);
  assert.deepEqual(Object.keys(DEMO_ACCOUNT).sort(),['email','name','password']);
  assert.match(DEMO_ACCOUNT.email,/^[a-z]+@[a-z.]+\.invalid$/);
  assert.ok(DEMO_ACCOUNT.password.length>=12&&DEMO_ACCOUNT.password.length<=256);
  assert.equal(DEMO_ACCOUNT.password,DEMO_ACCOUNT.password.trim());
  assert.equal(DEMO_SYSTEM_CREDENTIAL.username,'demo');
  assert.equal(DEMO_SYSTEM_CREDENTIAL.password,'demo123');
  for(const value of Object.values({...DEMO_ACCOUNT,...DEMO_SYSTEM_CREDENTIAL}))assert.ok(!/[\r\n<>]/.test(value));
});
