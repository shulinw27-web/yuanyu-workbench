import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {replayRecipe,createAgentRuntime} from '../src/agent/runtime.mjs';
import {createAgentStore} from '../src/agent/store.mjs';
import {safeError} from '../src/controller.mjs';

const siteId='site-synthetic';
const error=code=>Object.assign(new Error(code),{code});
const action=(tool,name,value)=>({tool,siteId,locator:{role:tool==='click'?'button':'textbox',name,readOnly:true},...(value!==undefined?{value}:{})});
const step=action('click','查询资料');
const page=ref=>({text:'合成资料结果',elements:[{tag:'button',role:'button',label:'查询资料',ref,credential:false}]});

test('引用失效仅重读当前步并使用新ref重试一次，不重复此前成功动作，末尾读取新结果',async()=>{
  const executed=[],attempted=[],events=[],recovered=[],progress=[];let revision=0,stale=true;
  const recipe=[{tool:'open',siteId},{tool:'observe',siteId},action('fill','搜索','合成查询'),{tool:'observe',siteId},step];
  const result=await replayRecipe({recipe,check:async()=>{},onRecovery:cp=>recovered.push(cp),onProgress:cp=>progress.push(cp),browser:{
    open:async()=>{events.push('open');},
    observe:async()=>{events.push('observe');revision++;return {text:'合成资料结果 '+revision,elements:[{tag:'input',role:'textbox',label:'搜索',ref:'input-'+revision},{tag:'button',role:'button',label:'查询资料',ref:'button-'+revision}]};},
    act:async(_id,entry)=>{attempted.push(entry);if(entry.type==='click'&&stale){stale=false;throw error('STALE_REFERENCE');}events.push(entry.type);executed.push(entry.type);}
  }});
  assert.equal(result.status,'completed');assert.deepEqual(executed,['fill','click']);assert.equal(events.filter(event=>event==='open').length,1);
  assert.equal(attempted.filter(entry=>entry.type==='click').length,2);assert.notEqual(attempted[1].ref,attempted[2].ref);
  assert.deepEqual(recovered.map(cp=>cp.state),['recovering','completed']);assert.ok(recovered.every(cp=>cp.stepIndex===4&&cp.total===5&&cp.retries===1&&cp.reason==='STALE_REFERENCE'));
  assert.equal(events.at(-1),'observe','最终动作之后必须有新观察');assert.equal(progress.at(-1).tool,'observe');assert.equal(progress.at(-1).state,'completed');
  assert.ok(!JSON.stringify(progress).includes('合成资料结果'));assert.ok(!JSON.stringify(recovered).includes('button-'));
});

test('第二次引用失效明确失败，不无限重试或重复先前步骤',async()=>{
  let observed=0,acted=0;const recovery=[];
  await assert.rejects(replayRecipe({recipe:[step],check:async()=>{},onRecovery:cp=>recovery.push(cp),browser:{observe:async()=>page('ref-'+(++observed)),act:async()=>{acted++;throw error('STALE_REFERENCE');}}}),/STALE_REFERENCE/);
  assert.equal(acted,2);assert.equal(observed,2);assert.deepEqual(recovery.map(cp=>cp.state),['recovering','failed']);
});

test('业务写入、来源、授权或不确定操作错误不触发引用重试',async t=>{
  for(const code of ['WRITE_CONFIRM_REQUIRED','BROWSER_SOURCE_MISMATCH','AUTH_REQUIRED','BROWSER_OPERATION_FAILED','PROVIDER_TIMEOUT'])await t.test(code,async()=>{
    let observed=0,acted=0,recovered=0;
    await assert.rejects(replayRecipe({recipe:[step],check:async()=>{},onRecovery:()=>{recovered++;},browser:{observe:async()=>{observed++;return page('current-ref');},act:async()=>{acted++;throw error(code);}}}),cause=>cause.code===code);
    assert.equal(acted,1);assert.equal(observed,1);assert.equal(recovered,0);
  });
});

test('缺失或重复名称拒绝选择；恢复后的歧义也不能任选控件',async t=>{
  for(const count of [0,2])await t.test('matches '+count,async()=>{
    let acted=0;const progress=[];
    await assert.rejects(replayRecipe({recipe:[step],check:async()=>{},onProgress:cp=>progress.push(cp),browser:{observe:async()=>({text:'合成查询',elements:Array.from({length:count},(_,index)=>({...page('ref-'+index).elements[0]}))}),act:async()=>{acted++;}}}),/PAGE_STRUCTURE_CHANGED/);
    assert.equal(acted,0);assert.equal(progress.at(-1).reason,'PAGE_STRUCTURE_CHANGED');assert.equal(progress.at(-1).state,'failed');
  });
  let observed=0,acted=0;
  await assert.rejects(replayRecipe({recipe:[step],check:async()=>{},browser:{observe:async()=>++observed===1?page('old-ref'):{text:'合成查询',elements:[...page('first-ref').elements,...page('second-ref').elements]},act:async()=>{acted++;throw error('STALE_REFERENCE');}}}),/PAGE_STRUCTURE_CHANGED/);
  assert.equal(acted,1);
});

test('恢复遇到登录页交给人工，不重试凭据操作或冒充完成',async()=>{
  let observed=0,acted=0,handedOff=0;const progress=[];
  const result=await replayRecipe({recipe:[step],check:async()=>{},onProgress:cp=>progress.push(cp),browser:{
    observe:async()=>++observed===1?page('old-ref'):{text:'需登录',elements:[{tag:'input',label:'密码',credential:true,ref:'secret-input'}]},
    act:async()=>{acted++;throw error('STALE_REFERENCE');},handoff:async()=>{handedOff++;}
  }});
  assert.equal(result.status,'awaiting_user');assert.equal(acted,1);assert.equal(handedOff,1);assert.equal(progress.at(-1).reason,'LOGIN_REQUIRED');
});

test('刷新引用期间取消或撤权不会执行第二次动作',async t=>{
  for(const revoked of [false,true])await t.test(revoked?'撤权':'取消',async()=>{
    const abort=new AbortController();let valid=true,observed=0,acted=0;
    await assert.rejects(replayRecipe({recipe:[step],signal:abort.signal,check:async()=>{if(!valid)throw error('AGENT_CONTEXT_CHANGED');},browser:{
      observe:async()=>{if(++observed===2){if(revoked)valid=false;else abort.abort();}return page('ref-'+observed);},
      act:async()=>{acted++;throw error('STALE_REFERENCE');}
    }}),cause=>cause.code===(revoked?'AGENT_CONTEXT_CHANGED':'CANCELLED'));
    assert.equal(acted,1);
  });
});

test('最终动作后必须重新读取，若最后读取变成登录页不能完成',async()=>{
  let changed=false,handedOff=0;
  const result=await replayRecipe({recipe:[step],check:async()=>{},browser:{
    observe:async()=>changed?{text:'登录已失效',elements:[{credential:true}]}:page('before-action'),
    act:async()=>{changed=true;},handoff:async()=>{handedOff++;}
  }});
  assert.equal(result.status,'awaiting_user');assert.equal(handedOff,1);
});

test('保存的HTTPS Skill无需配置模型或模型发送同意，登录后继续仍不会调用模型',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'yuanyu-https-replay-'));let logged=false,revision=0,modelCalls=0,stale=true;
  const binding={id:siteId,origin:'https://synthetic.example.invalid',revision:1};
  const store=createAgentStore({dataDir,identity:{companyId:'mock-acme',userId:'alice',displayName:'合成用户',provider:'mock'}});
  const source=await store.createTask({goal:'查看合成查询结果',mode:'compatible_browser',siteBindings:[binding]});
  await store.updateTask(source.id,{status:'completed',trace:[{tool:'open',siteId},{tool:'observe',siteId},step,{tool:'observe',siteId}]});
  const skill=await store.saveSkill({taskId:source.id,name:'本人的合成查询'});
  const browser={open:async()=>({}),resume:async()=>({}),observe:async()=>logged?page('ref-'+(++revision)):{text:'需登录',elements:[{credential:true}]},handoff:async()=>({}),act:async()=>{if(stale){stale=false;throw error('STALE_REFERENCE');}},cancel:async()=>{}};
  const runtime=createAgentRuntime({store,getSites:async()=>[{...binding,builtin:false}],getBrowser:async()=>browser,isCurrent:()=>true,safeError,requesterFactory:async()=>{modelCalls++;throw Error('UNEXPECTED_MODEL');}});
  t.after(async()=>{await runtime.cancel();await rm(dataDir,{recursive:true,force:true});});
  const started=await runtime.runSkill({id:skill.id,mode:'compatible_browser'});await runtime.waitForIdle();
  assert.equal((await store.listTasks()).find(task=>task.id===started.taskId).status,'awaiting_user');
  logged=true;await runtime.resume({id:started.taskId});await runtime.waitForIdle();
  let completed=(await store.listTasks()).find(task=>task.id===started.taskId);
  assert.equal(completed.status,'awaiting_review',JSON.stringify(completed.error));assert.equal(modelCalls,0);
  await runtime.confirmResult({id:completed.id,confirmed:true,expectedAttempt:completed.attempt});
  completed=(await store.listTasks()).find(task=>task.id===started.taskId);assert.equal(completed.status,'completed');assert.equal(completed.verification.status,'user_confirmed');assert.equal(modelCalls,0);
  assert.equal(completed.replay.state,'completed');assert.ok(completed.steps.some(entry=>entry.id==='recovery-2-1'&&entry.status==='completed'));
  const disk=await readFile(join(dataDir,'agents','mock-acme','alice','state.json'),'utf8');assert.ok(!disk.includes('current-ref'));assert.ok(!disk.includes('合成资料结果'));assert.ok(!disk.includes('"ref"'));
});
