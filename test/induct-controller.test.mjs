import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createController} from '../src/controller.mjs';

async function fixture(t){
  const dataDir=await mkdtemp(join(tmpdir(),'yuanyu-induct-controller-'));
  let month='2026-09',loggedIn=false,revision=0,modelCalls=0;
  const site={id:'interactive-mock',origin:'http://127.0.0.1:15333',label:'合成记录站点',paths:['/'],entryPath:'/'};
  const page=()=>({siteId:site.id,revision:++revision,title:'合成记录',text:loggedIn?`${month} ${month==='2026-09'?'SYN-091 9087':'SYN-101 12345'}`:'请登录',elements:loggedIn?[
    {ref:`select-${revision}`,tag:'select',role:'combobox',label:'月份',credential:false,readOnly:false},
    {ref:`filter-${revision}`,tag:'button',role:'button',label:'筛选合成记录',action:'filter',credential:false,readOnly:false}
  ]:[{ref:`credential-${revision}`,tag:'input',role:'textbox',label:'密码',credential:true,readOnly:false}]});
  const browser={open:async()=>({ok:true}),observe:async()=>page(),handoff:async()=>({ok:true}),resume:async()=>page(),act:async(_site,action)=>{if(action.type==='select')month=action.value;return {ok:true};},cancel:async()=>{},close:async()=>{}};
  const inductRequesterFactory=async()=>{
    let calls=0;
    return async()=>{calls++;const args={name:'归纳月度查看',description:'选月份并筛选',steps:[
      {siteId:site.id,action:{type:'select',role:'combobox',name:'月份',value:'2026-10'}},
      {siteId:site.id,action:{type:'click',role:'button',name:'筛选合成记录'}}
    ]};return {message:{tool_calls:[{id:'m1',type:'function',function:{name:'propose_recipe',arguments:JSON.stringify(args)}}]},usage:{promptTokens:80,completionTokens:20,cachedTokens:0}};};
  };
  const systems={procurement:{id:'procurement',label:'合成采购',origin:'http://127.0.0.1:15331',url:'http://127.0.0.1:15331/'}};
  const controller=await createController({dataDir,systems,cryptoAdapter:{available:()=>false},builtinSites:[site],interactiveFactory:()=>browser,agentRequesterFactory:async()=>{throw new Error('UNEXPECTED_MODEL');},inductRequesterFactory});
  t.after(async()=>{await controller.close();await rm(dataDir,{recursive:true,force:true});});
  return {controller,site,dataDir,login:()=>{loggedIn=true;},count:()=>modelCalls};
}

test('人工示范→归纳→用户确认→保存为数据配方并本机重放，全程零真实模型',async t=>{
  const f=await fixture(t),c=f.controller;f.login();
  const demo=await c.invoke('demo.start',{goal:'按月份查看合成资料',siteIds:[f.site.id],mode:'mock_browser'});
  const select=demo.page.elements.find(element=>element.role==='combobox');
  await c.invoke('demo.act',{id:demo.taskId,siteId:f.site.id,action:{type:'select',ref:select.ref,value:'2026-10'}});
  const filter=(await c.invoke('demo.observe',{id:demo.taskId,siteId:f.site.id})).page.elements.find(element=>element.name==='筛选合成记录');
  await c.invoke('demo.act',{id:demo.taskId,siteId:f.site.id,action:{type:'click',ref:filter.ref}});
  await c.invoke('demo.finish',{id:demo.taskId,confirmed:true});

  await assert.rejects(c.invoke('agent.induct',{sourceTaskId:demo.taskId,goal:'归纳流程',consent:{}}),/INDUCTION_CONSENT_REQUIRED/);
  const induct=await c.invoke('agent.induct',{sourceTaskId:demo.taskId,goal:'归纳流程',consent:{taskText:true}});
  assert.equal(induct.status,'awaiting_confirmation');assert.equal(induct.modelRequests,1);
  const snap=await c.snapshot();assert.equal(snap.induction.candidate.verification.status,'verified');assert.equal(snap.induction.usage.promptTokens,80);

  const skill=await c.invoke('agent.induct.confirm',{name:'归纳月度查看',pinned:false});
  assert.equal(skill.name,'归纳月度查看');assert.equal(skill.template.recipe[0].tool,'open');
  assert.equal((await c.snapshot()).induction,null);
  const run=await c.invoke('agent.skill.run',{id:skill.id,mode:'mock_browser',expectedVersion:skill.version});
  await c.waitForIdle();
  const task=(await c.snapshot()).agentTasks.find(item=>item.id===run.taskId);
  assert.equal(task.status,'completed',JSON.stringify(task.error));
  await c.invoke('identity.switch',{userId:'alice'});
  const disk=await readFile(join(f.dataDir,'agents','mock-acme','alice','state.json'),'utf8');
  assert.ok(!disk.includes('SYN-101'));assert.ok(!disk.includes('select-'));
  assert.equal(f.count(),0);
});

test('归纳源必须是已完成的本人示范，身份切换后不跨身份泄露候选',async t=>{
  const f=await fixture(t),c=f.controller;f.login();
  await assert.rejects(c.invoke('agent.induct',{sourceTaskId:'missing',goal:'x',consent:{taskText:true}}),/INDUCTION_SOURCE_INVALID/);
  const demo=await c.invoke('demo.start',{goal:'查看合成资料',siteIds:[f.site.id],mode:'mock_browser'});
  await c.invoke('demo.cancel',{id:demo.taskId});
  await assert.rejects(c.invoke('agent.induct',{sourceTaskId:demo.taskId,goal:'x',consent:{taskText:true}}),/INDUCTION_SOURCE_INVALID/);
  await c.invoke('identity.switch',{userId:'bob'});
  const bob=await c.snapshot();assert.equal(bob.induction,null);assert.ok(!JSON.stringify(bob).includes('归纳月度查看'));
});
