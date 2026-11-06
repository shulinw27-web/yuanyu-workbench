import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createController} from '../src/controller.mjs';

async function fixture(t){
  const dataDir=await mkdtemp(join(tmpdir(),'yuanyu-demo-controller-'));
  let month='2026-09',loggedIn=false,revision=0,acts=0,modelCalls=0;
  const site={id:'interactive-mock',origin:'http://127.0.0.1:15333',label:'合成记录站点',paths:['/'],entryPath:'/'};
  const page=()=>({siteId:site.id,revision:++revision,title:'合成记录',text:loggedIn?`${month} ${month==='2026-09'?'SYN-091 9087':'SYN-101 12345'}`:'请在独立窗口登录',elements:loggedIn?[
    {ref:`select-${revision}`,tag:'select',role:'combobox',type:'select-one',label:'月份',credential:false,readOnly:false,action:'select',options:[{label:'2026-09'},{label:'2026-10'}]},
    {ref:`filter-${revision}`,tag:'button',role:'button',type:'submit',label:'筛选合成记录',credential:false,readOnly:false,action:'filter'},
    {ref:`write-${revision}`,tag:'button',role:'button',type:'submit',label:'提交业务',credential:false,readOnly:false,action:'confirmation-required'}
  ]:[{ref:`credential-${revision}`,tag:'input',role:'textbox',type:'password',label:'密码',credential:true,readOnly:false}]});
  const browser={open:async()=>({mode:'automatic'}),observe:async()=>page(),handoff:async()=>({mode:'manual'}),resume:async()=>page(),act:async(_site,action)=>{acts++;if(action.type==='select')month=action.value;return {status:'acted'};},cancel:async()=>{},close:async()=>{}};
  const systems=Object.fromEntries(['procurement','warehouse'].map((id,i)=>[id,{id,label:id,origin:`http://127.0.0.1:${15331+i}`,url:`http://127.0.0.1:${15331+i}/`}]));
  const controller=await createController({dataDir,systems,cryptoAdapter:{available:()=>false},builtinSites:[site],interactiveFactory:()=>browser,agentRequesterFactory:async()=>{modelCalls++;throw new Error('UNEXPECTED_MODEL');}});
  t.after(async()=>{await controller.close();await rm(dataDir,{recursive:true,force:true});});
  return {controller,dataDir,login:()=>{loggedIn=true;},counts:()=>({acts,modelCalls}),site};
}

test('示范与任务/配置互斥，登录接管不入步骤，确认完成后可保存并参数化重放',async t=>{
  const f=await fixture(t),c=f.controller;
  const initial=await c.invoke('demo.start',{goal:'按月份查看合成资料',siteIds:[f.site.id],mode:'mock_browser'}),id=initial.taskId;
  assert.ok(id);assert.equal((await c.snapshot()).demonstration.taskId,id);
  for(const [action,payload]of [['task.plan',{text:'采购月报',month:'2026-10'}],['site.register',{}],['model.profile.save',{}],['agent.start',{goal:'读取合成记录',siteIds:[f.site.id],mode:'mock_browser'}]])await assert.rejects(c.invoke(action,payload),/BUSY/);
  await c.invoke('demo.handoff',{id,siteId:f.site.id});f.login();
  let view=await c.invoke('demo.resume',{id});
  const select=view.page.elements.find(e=>e.role==='combobox');assert.ok(select);assert.ok(!view.page.elements.some(e=>e.name==='提交业务'));
  view=await c.invoke('demo.act',{id,siteId:f.site.id,action:{type:'select',ref:select.ref,value:'2026-10'}});
  assert.ok(view.page.text.includes('SYN-101'));assert.equal(view.canFinish,true);
  await assert.rejects(c.invoke('demo.finish',{id,confirmed:false}),/DEMONSTRATION_/);
  await c.invoke('demo.finish',{id,confirmed:true});assert.equal((await c.snapshot()).demonstration,null);
  const saved=await c.invoke('agent.skill.save',{taskId:id,name:'按月份看资料',pinned:true});
  const stepIndex=saved.template.recipe.findIndex(s=>s.tool==='select');assert.ok(stepIndex>=0);
  const edited=await c.invoke('agent.skill.edit',{id:saved.id,expectedVersion:1,parameters:[{name:'month',label:'月份',stepIndex}]});
  const run=await c.invoke('agent.skill.run',{id:saved.id,mode:'mock_browser',expectedVersion:edited.version,values:{month:'2026-09'}});await c.waitForIdle();
  const state=await c.snapshot(),task=state.agentTasks.find(task=>task.id===run.taskId);assert.equal(task.status,'completed',JSON.stringify(task.error));assert.equal(task.parameterValues.month,'2026-09');assert.equal(f.counts().modelCalls,0);
  const disk=await readFile(join(f.dataDir,'agents','mock-acme','alice','state.json'),'utf8');assert.ok(!disk.includes('SYN-101'));assert.ok(!disk.includes('select-'));assert.ok(!disk.includes('credential-'));
});

test('示范不能由模型任务继续，切换身份取消原记录且不向其他成员泄露页面',async t=>{
  const f=await fixture(t),c=f.controller;f.login();
  const {taskId}=await c.invoke('demo.start',{goal:'查看合成资料',siteIds:[f.site.id],mode:'mock_browser'});
  await c.invoke('demo.handoff',{id:taskId,siteId:f.site.id});
  await assert.rejects(c.invoke('agent.resume',{id:taskId}),/BUSY|DEMONSTRATION_RESUME_REQUIRED/);
  await c.invoke('identity.switch',{userId:'bob'});
  const bob=await c.snapshot();assert.equal(bob.demonstration,null);assert.equal(bob.agentTasks.length,0);assert.ok(!JSON.stringify(bob).includes('SYN-091'));
  await c.invoke('identity.switch',{userId:'alice'});
  const task=(await c.snapshot()).agentTasks.find(task=>task.id===taskId);assert.equal(task.status,'cancelled');
  await assert.rejects(c.invoke('agent.resume',{id:taskId}),/DEMONSTRATION_RESUME_REQUIRED/);
});
