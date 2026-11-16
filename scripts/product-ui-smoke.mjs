import assert from 'node:assert/strict';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');

/** Renderer interaction checks with a synthetic trusted IPC bridge; real service/auth checks run separately. */
export async function runProductUISmoke({BrowserWindow}) {
  const {ipcMain}=await import('electron');
  const calls=[];
  let demonstrationCount=0,observationCount=0,finishAttempts=0;
  const demonstrationTask=()=>snapshot.agentTasks.find(task=>task.id===snapshot.demonstration?.taskId);
  const demonstrationPage=()=>({siteId:'site-synthetic',title:'合成资料查询',text:`合成结果 SYN-101 / 12345 分；外部文字 <b>只作为数据展示</b>${finishAttempts?'（已重新核对）':''}`,loginRequired:false,elements:[{ref:`demo-month-${++observationCount}`,role:'combobox',name:'查询月份',actionKinds:['select'],options:[{label:'2026-09'},{label:'2026-10'}]},{ref:`demo-query-${observationCount}`,role:'textbox',name:'合成查询关键词',actionKinds:['fill']}]});
  const errors=[];
  // 个人开源版快照：无账号服务、无推广额度、无公司目录。
  let snapshot={identity:{companyId:'personal-ui-test',userId:'user-ui-test',displayName:'测试用户',provider:'account'},credentials:[],workflows:[],runs:[],sites:[],agentSites:[],agentTasks:[],agentSkills:[],busy:false,
    model:{status:'not_configured'},
    modelProfiles:{providers:[{id:'glm',label:'智谱 GLM',baseUrl:'https://open.bigmodel.cn/api/paas/v4',docUrl:'https://docs.bigmodel.cn'},{id:'custom',label:'自定义兼容服务',baseUrl:''}],profiles:[],activeId:null},
    writeDemo:{records:[],approvals:[]}
  };
  const win=new BrowserWindow({show:false,width:1440,height:900,webPreferences:{offscreen:true,preload:join(root,'src/preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  const uiUrl=pathToFileURL(join(root,'src/ui/index.html')).href;
  ipcMain.handle('workbench:invoke',async(event,action,payload)=>{
    if(event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)return {ok:false,error:{message:'untrusted'}};
    calls.push({action,payload:structuredClone(payload)});
    if(action==='snapshot')return {ok:true,data:snapshot};
    if(action==='model.profile.save') {
      assert.equal(payload.apiKey,'synthetic-ui-key-123');
      const {apiKey,...profile}=payload;
      profile.id='profile-ui-test';profile.revision=1;profile.configured=true;
      snapshot.modelProfiles.profiles=[profile];snapshot.modelProfiles.activeId=profile.id;
      snapshot.model={status:'ready',model:profile.model,host:'open.bigmodel.cn',dataScope:profile.dataScope};
      return {ok:true,data:profile};
    }
    if(action==='model.test'){assert.deepEqual(payload,{consent:true});return {ok:true,data:{synthetic:true}};}
    if(action==='agent.skill.edit') {
      assert.equal(payload.expectedVersion,1);assert.equal(payload.name,'按月份核对');
      assert.deepEqual(payload.parameters,[{stepIndex:2,name:'month',label:'查询月份',defaultValue:'2026-09'}]);
      const skill=snapshot.agentSkills[0];skill.name=payload.name;skill.version++;skill.template.parameters=payload.parameters;
      return {ok:true,data:skill};
    }
    if(action==='agent.skill.run') {
      if(payload.id==='https-local-skill') {
        assert.equal(payload.expectedVersion,1);assert.equal(payload.mode,'compatible_browser');assert.deepEqual(payload.values,{month:'2026-10'});
        assert.equal(Object.hasOwn(payload,'consent'),false,'本机重放不能借用模型页面发送同意');
        snapshot.agentTasks=[{id:'https-local-replay',kind:'browser',skillId:payload.id,skillVersion:1,goal:'本人HTTPS查询流程',mode:payload.mode,status:'running',createdAt:new Date().toISOString(),steps:[],replay:{stepIndex:1,total:4,tool:'select',siteId:'site-https',retries:0,state:'executing'}}];snapshot.busy=true;
        return {ok:true,data:{taskId:'https-local-replay'}};
      }
      assert.equal(payload.expectedVersion,2);assert.equal(payload.mode,'mock_browser');assert.deepEqual(payload.values,{month:'2026-10'});
      return {ok:true,data:{taskId:'synthetic-replay-task'}};
    }
    if(action==='agent.resume') {
      assert.deepEqual(payload,{id:'https-local-replay'},'已保存Skill继续无需页面外发同意');
      snapshot.agentTasks[0].status='running';snapshot.agentTasks[0].replay={stepIndex:0,total:4,tool:'open',siteId:'site-https',retries:0,state:'executing'};snapshot.busy=true;
      return {ok:true,data:{taskId:'https-local-replay'}};
    }
    if(action==='demo.start') {
      assert.equal(payload.mode,'mock_browser');assert.deepEqual(payload.siteIds,['site-synthetic']);
      const task={id:`demonstration-${++demonstrationCount}`,goal:payload.goal,kind:'browser',mode:payload.mode,execution:'demonstration',status:'running',steps:[],trace:[],createdAt:new Date().toISOString()};
      snapshot.agentTasks.unshift(task);snapshot.busy=true;
      snapshot.demonstration={taskId:task.id,mode:payload.mode,status:'recording',siteIds:payload.siteIds,currentSiteId:'site-synthetic',page:{siteId:'site-synthetic',title:'合成站点登录',text:'请在独立窗口登录',loginRequired:true,elements:[]},canFinish:false,operationPending:false};
      return {ok:true,data:snapshot.demonstration};
    }
    if(action==='demo.handoff') {
      assert.deepEqual(payload,{id:snapshot.demonstration.taskId,siteId:'site-synthetic'});
      demonstrationTask().status='awaiting_user';snapshot.demonstration.status='awaiting_user';snapshot.demonstration.page=null;
      return {ok:true,data:snapshot.demonstration};
    }
    if(action==='demo.resume') {
      assert.deepEqual(payload,{id:snapshot.demonstration.taskId});
      demonstrationTask().status='running';snapshot.demonstration.status='recording';snapshot.demonstration.page=demonstrationPage();
      return {ok:true,data:snapshot.demonstration};
    }
    if(action==='demo.observe') {
      assert.deepEqual(payload,{id:snapshot.demonstration.taskId,siteId:'site-synthetic'});
      snapshot.demonstration.page=demonstrationPage();return {ok:true,data:snapshot.demonstration};
    }
    if(action==='demo.act') {
      assert.deepEqual(payload,{id:snapshot.demonstration.taskId,siteId:'site-synthetic',action:{type:'select',ref:snapshot.demonstration.page.elements[0].ref,value:'2026-10'}});
      await new Promise(resolve=>setTimeout(resolve,60));
      demonstrationTask().steps=[{id:'demo-1',label:'示范选择月份',status:'completed'}];snapshot.demonstration.page=demonstrationPage();snapshot.demonstration.canFinish=true;
      return {ok:true,data:snapshot.demonstration};
    }
    if(action==='demo.finish') {
      assert.deepEqual(payload,{id:snapshot.demonstration.taskId,confirmed:true});
      if(++finishAttempts===1){snapshot.demonstration.page=demonstrationPage();return {ok:false,error:{code:'DEMONSTRATION_RESULT_CHANGED',message:'页面结果发生变化，请核对最新页面后再次确认。'}};}
      const task=demonstrationTask();task.status='completed';task.message='已由本人核对完成受控只读示范。';snapshot.demonstration=null;snapshot.busy=false;
      return {ok:true,data:{taskId:task.id,status:'completed'}};
    }
    if(action==='demo.cancel') {
      const task=snapshot.agentTasks.find(task=>task.id===payload.id);assert.equal(task.execution,'demonstration');task.status='cancelled';snapshot.demonstration=null;snapshot.busy=false;
      return {ok:true,data:{cancelled:true}};
    }
    if(action==='agent.skill.save') {
      const task=snapshot.agentTasks.find(task=>task.id===payload.taskId);assert.equal(task.status,'completed');assert.equal(task.execution,'demonstration');assert.equal(payload.name,'人工示范的月份查询');
      const skill={id:'demonstrated-browser-skill',name:payload.name,kind:'browser',version:1,pinned:true,source:{taskId:task.id},template:{goalTemplate:task.goal,siteBindings:[{id:'site-synthetic',origin:'http://127.0.0.1:15333',revision:1}],recipe:[{tool:'open',siteId:'site-synthetic'},{tool:'observe',siteId:'site-synthetic'},{tool:'select',siteId:'site-synthetic',locator:{role:'combobox',name:'查询月份',readOnly:true},value:'2026-10'},{tool:'observe',siteId:'site-synthetic'}]}};
      snapshot.agentSkills.push(skill);return {ok:true,data:skill};
    }
    if(action==='write.demo.preview') {
      const value={id:'synthetic-approval',operation:'synthetic-note',siteId:'site-synthetic',status:'awaiting_confirmation',payload,sourceRevision:'1',expiresAt:Date.now()+300000};
      snapshot.writeDemo.approvals=[value];return {ok:true,data:{...value,fingerprint:'synthetic-confirm-fingerprint'}};
    }
    if(action==='write.demo.confirm') {
      assert.deepEqual(payload,{id:'synthetic-approval',fingerprint:'synthetic-confirm-fingerprint'});
      snapshot.writeDemo.approvals[0].status='receipt_unknown';return {ok:true,data:snapshot.writeDemo.approvals[0]};
    }
    if(action==='write.demo.inspect') {
      assert.deepEqual(payload,{id:'synthetic-approval'});
      const approval=snapshot.writeDemo.approvals[0];approval.status='completed';approval.receipt={receiptId:'synthetic-receipt',idempotencyKey:approval.id};
      snapshot.writeDemo.records=[{id:approval.id,...approval.payload,createdAt:new Date().toISOString()}];
      return {ok:true,data:approval};
    }
    return {ok:false,error:{message:'Unexpected UI action '+action}};
  });
  win.webContents.on('console-message',(_event,details)=>{if(details.level==='error')errors.push(details.message);});
  const evaluate=code=>win.webContents.executeJavaScript(code,true);
  const wait=async(code)=>{for(let i=0;i<150;i++){if(await evaluate(code))return;await new Promise(r=>setTimeout(r,20));}throw new Error('UI condition timed out: '+code);};
  const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const capture=async name=>{
    await evaluate(`document.querySelector('#toast').hidden=true`);
    await evaluate(`document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))`);
    await new Promise(resolve=>setTimeout(resolve,80));
    const frame=await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
    const encoded=frame.toPNG();assert.ok(encoded.length>1000,'Screenshot must contain rendered pixels');
    const dir=join(root,'output/screenshots');await mkdir(dir,{recursive:true});await writeFile(join(dir,name+'.png'),encoded);
  };
  try {
    await win.loadURL(uiUrl);
    await wait(`!document.querySelector('#plan-submit').disabled`);
    // 个人开源版：登录注册与公司流程入口必须从界面移除；自定义模型连接入口必须直接可见。
    assert.equal(await evaluate(`Boolean(document.querySelector('#product-entry, [data-view="company"], #view-company, #model-source-settings, #product-account-settings, #developer-contact-dialog'))`),false,'登录注册与公司流程元素不应存在');
    assert.equal(await evaluate(`Boolean(document.querySelector('#model-profiles-settings'))`),true,'自定义模型连接入口必须可见');
    assert.equal(await evaluate(`document.body.classList.contains('product-locked')`),false,'个人开源版不得出现账号锁定层');
    await click('.nav-item[data-view="settings"]');await click('#new-model-profile');
    await evaluate(`document.querySelector('#model-profile-label').value='测试模型';document.querySelector('#model-profile-model').value='test-glm';document.querySelector('#model-profile-api-key').value='synthetic-ui-key-123';document.querySelector('#model-profile-form').requestSubmit();`);
    assert.equal(await evaluate(`document.querySelector('#model-profile-api-key').value`),'');
    await wait(`!document.querySelector('#model-profile-dialog').open && document.querySelector('#model-profile-list').textContent.includes('测试模型')`);
    assert.ok(!await evaluate(`document.body.textContent.includes('synthetic-ui-key-123')`));
    assert.equal(calls.filter(c=>c.action==='model.test').length,0,'保存不能自动调用模型');
    await click('#model-test');
    assert.match(await evaluate(`document.querySelector('#confirm-message').textContent`),/费用/);
    assert.equal(calls.filter(c=>c.action==='model.test').length,0,'确认前不能发请求');
    await click('#confirm-action');
    await wait(`document.querySelector('#model-test-result').textContent.includes('合成服务连接成功')`);
    assert.equal(calls.filter(c=>c.action==='model.test').length,1);
    await evaluate(`document.querySelector('#model-profiles-settings').scrollIntoView({block:'center'})`);
    await capture('product-models');
    await evaluate(`document.querySelector('#write-demo-note').value='部分入库记录待核实';document.querySelector('#write-demo-form').requestSubmit();`);
    await wait(`document.querySelector('#write-preview-dialog').open`);
    assert.equal(calls.filter(c=>c.action==='write.demo.confirm').length,0,'预览不得提交写入');
    assert.match(await evaluate(`document.querySelector('#write-preview-note').textContent`),/部分入库记录待核实/);
    await capture('product-write-preview');
    await click('#write-preview-confirm');
    await wait(`!document.querySelector('#write-preview-dialog').open && document.querySelector('#write-demo-records button')`);
    assert.equal(calls.filter(c=>c.action==='write.demo.confirm').length,1);
    assert.match(await evaluate(`document.querySelector('#write-demo-records').textContent`),/回执待核对/);
    await click('#write-demo-records button');
    await wait(`document.querySelector('#write-demo-records').textContent.includes('synthetic-receipt')`);
    assert.equal(calls.filter(c=>c.action==='write.demo.confirm').length,1,'未知回执只能核对，不得重新提交');
    assert.equal(calls.filter(c=>c.action==='write.demo.inspect').length,1);
    snapshot.agentSites=[{id:'site-synthetic',label:'合成测试站点',origin:'http://127.0.0.1:15333',revision:1,builtin:true}];
    snapshot.agentSkills=[{id:'synthetic-browser-skill',name:'按月份查询',version:1,pinned:true,kind:'browser',template:{goalTemplate:'读取合成记录',siteBindings:[{id:'site-synthetic',origin:'http://127.0.0.1:15333',revision:1}],recipe:[{tool:'open',siteId:'site-synthetic'},{tool:'observe',siteId:'site-synthetic'},{tool:'select',siteId:'site-synthetic',locator:{role:'combobox',name:'月份',readOnly:true},value:'2026-09'},{tool:'observe',siteId:'site-synthetic'}]}}];
    win.webContents.send('workbench:update',snapshot);
    await click('.nav-item[data-view="workflows"]');
    await evaluate(`[...document.querySelectorAll('#workflow-list button')].find(button=>button.textContent==='编辑参数').click()`);
    await wait(`document.querySelector('#agent-edit-dialog').open`);
    assert.equal(await evaluate(`document.querySelectorAll('#agent-parameter-editor .agent-parameter-row').length`),1);
    await evaluate(`document.querySelector('#agent-edit-name').value='按月份核对';document.querySelector('.agent-parameter-enabled').click();document.querySelector('#agent-param-2-name').value='month';document.querySelector('#agent-param-2-label').value='查询月份';`);
    await capture('product-skill-edit');
    await evaluate(`document.querySelector('#agent-edit-form').requestSubmit()`);
    await wait(`!document.querySelector('#agent-edit-dialog').open && document.querySelector('#workflow-list').textContent.includes('1 个运行参数')`);
    assert.equal(calls.filter(c=>c.action==='agent.skill.edit').length,1);
    await evaluate(`[...document.querySelectorAll('#workflow-list button')].find(button=>button.textContent.includes('运行浏览器流程')).click()`);
    await wait(`document.querySelector('#agent-run-dialog').open`);
    await evaluate(`document.querySelector('#agent-run-param-0').value='2026-10';document.querySelector('#agent-run-form').requestSubmit()`);
    assert.equal(calls.filter(c=>c.action==='agent.skill.run').length,0,'填写运行参数不能执行');
    assert.match(await evaluate(`document.querySelector('#task-plan').textContent`),/month：2026-10/);
    await capture('product-skill-parameters');
    await evaluate(`[...document.querySelectorAll('#task-plan button')].find(button=>button.textContent==='确认执行').click()`);
    await wait(`document.querySelector('#task-plan').hidden`);
    assert.equal(calls.filter(c=>c.action==='agent.skill.run').length,1);
    const configuredModel=structuredClone(snapshot.model);
    snapshot.model={status:'not_configured',mode:'compatible',dataScope:'task_text'};
    snapshot.agentSites.push({id:'site-https',label:'本人HTTPS查询站点',origin:'https://synthetic-business.example.invalid',revision:1,builtin:false});
    snapshot.agentSkills.push({id:'https-local-skill',name:'本人HTTPS只读查询',kind:'browser',version:1,pinned:false,source:{taskId:'synthetic-verified-source'},template:{goalTemplate:'本人HTTPS查询流程',siteBindings:[{id:'site-https',origin:'https://synthetic-business.example.invalid',revision:1}],recipe:[{tool:'open',siteId:'site-https'},{tool:'select',siteId:'site-https',locator:{role:'combobox',name:'查询月份',readOnly:true},value:'2026-09'},{tool:'click',siteId:'site-https',locator:{role:'button',name:'筛选',readOnly:true}},{tool:'observe',siteId:'site-https'}],parameters:[{name:'month',label:'查询月份',stepIndex:1,defaultValue:'2026-09'}]}});
    win.webContents.send('workbench:update',snapshot);
    await click('.nav-item[data-view="workflows"]');
    await evaluate(`[...document.querySelectorAll('#workflow-list article')].find(card=>card.querySelector('h3')?.textContent==='本人HTTPS只读查询').querySelector('button.button.primary').click()`);
    await wait(`document.querySelector('#agent-run-dialog').open`);
    await evaluate(`document.querySelector('#agent-run-param-0').value='2026-10';document.querySelector('#agent-run-form').requestSubmit()`);
    await wait(`!document.querySelector('#task-plan').hidden && document.querySelector('#task-plan').textContent.includes('本机只读重放')`);
    assert.match(await evaluate(`document.querySelector('#task-plan').textContent`),/不发送模型/);
    assert.equal(await evaluate(`document.querySelector('#browser-model-mode-option').disabled`),true,'未配置模型时新模型浏览器任务仍不可用');
    assert.equal(await evaluate(`document.querySelector('#model-consent-row').hidden && document.querySelector('#page-consent-row').hidden`),true);
    await evaluate(`[...document.querySelectorAll('#task-plan button')].find(button=>button.textContent==='确认执行').click()`);
    await wait(`document.querySelector('#active-run .replay-status')?.textContent.includes('第 2 / 4 步')`);
    const replayTask=snapshot.agentTasks[0];
    replayTask.replay={...replayTask.replay,state:'recovering',retries:1,reason:'STALE_REFERENCE'};win.webContents.send('workbench:update',snapshot);
    await wait(`document.querySelector('#active-run .replay-recovery-note')?.textContent.includes('最多刷新一次')`);
    assert.match(await evaluate(`document.querySelector('#active-run .replay-recovery-note').textContent`),/之前成功的步骤不会在本轮重复/);
    replayTask.steps=[{id:'recovery-1-1',label:'页面引用变化，已重新观察并恢复当前步骤',status:'completed',tool:'select',siteId:'site-https'}];replayTask.replay={stepIndex:2,total:4,tool:'click',siteId:'site-https',retries:0,state:'executing'};
    win.webContents.send('workbench:update',snapshot);
    await wait(`document.querySelector('#active-run .replay-recovered')?.textContent.includes('1 个步骤')`);
    await evaluate(`document.querySelector('#active-run .replay-status').scrollIntoView({block:'center'})`);await capture('product-replay-recovery');
    for(const [width,height]of [[1920,1080],[1440,900],[1366,768],[1024,768],[780,640],[390,844]]){
      win.setContentSize(width,height);await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),true,`replay recovery overflow at ${width}`);
    }
    win.setContentSize(1440,900);
    replayTask.status='completed';replayTask.replay={...replayTask.replay,stepIndex:3,tool:'observe',state:'completed'};snapshot.busy=false;win.webContents.send('workbench:update',snapshot);
    await wait(`document.querySelector('#active-run .replay-progress')?.value===4`);
    replayTask.status='failed';replayTask.error={code:'PAGE_STRUCTURE_CHANGED',message:'页面控件无法唯一匹配'};replayTask.replay={...replayTask.replay,stepIndex:2,tool:'click',state:'failed',reason:'PAGE_STRUCTURE_CHANGED'};win.webContents.send('workbench:update',snapshot);
    await wait(`document.querySelector('#active-run .replay-review-note')?.textContent.includes('多个同名控件')`);
    const replayCalls=calls.filter(call=>call.action==='agent.skill.run').length;
    await click('#active-run .replay-review-run');await wait(`document.querySelector('#agent-run-dialog').open`);
    assert.equal(calls.filter(call=>call.action==='agent.skill.run').length,replayCalls,'检查重新运行入口不能直接执行');await click('#agent-run-dialog .close-dialog');
    replayTask.status='awaiting_user';delete replayTask.error;replayTask.replay={...replayTask.replay,state:'awaiting_user',reason:'LOGIN_REQUIRED'};win.webContents.send('workbench:update',snapshot);
    await wait(`document.querySelector('#active-run').textContent.includes('继续会从头执行已确认的只读步骤')`);
    assert.equal(await evaluate(`document.querySelector('#active-run').textContent.includes('继续会再次按已选择范围发送')`),false);
    await evaluate(`[...document.querySelectorAll('#active-run button')].find(button=>button.textContent==='继续任务').click()`);
    await wait(`document.querySelector('#active-run .replay-status')?.textContent.includes('第 1 / 4 步')`);
    assert.equal(calls.filter(call=>call.action==='agent.resume').length,1);assert.equal(calls.filter(call=>call.action==='model.test').length,1);
    // 账号宿主撤权兼容：界面必须锁定并清空运行内容，防止误操作。
    win.webContents.send('workbench:update',{...snapshot,identity:null,product:{mode:'personal',authenticated:false},agentTasks:[],agentSkills:[],busy:false});
    await wait(`document.body.classList.contains('product-locked') && document.querySelector('.replay-status')===null`);
    const {product:_revoked,...restored}=snapshot;
    snapshot=structuredClone(restored);snapshot.model=configuredModel;snapshot.agentTasks=[];snapshot.busy=false;
    win.webContents.send('workbench:update',snapshot);await wait(`!document.body.classList.contains('product-locked')`);
    const startDemonstration=async()=>{
      await click('.nav-item[data-view="workspace"]');await click('#demonstration-open');
      await wait(`document.querySelector('#demonstration-dialog').open`);
      const previous=calls.filter(call=>call.action==='demo.start').length;
      await evaluate(`document.querySelector('#demonstration-goal').value='按月份查看合成资料';`);
      assert.equal(calls.filter(call=>call.action==='demo.start').length,previous,'打开示范确认框不得执行');
      await evaluate(`document.querySelector('#demonstration-form').requestSubmit()`);
      await wait(`!document.querySelector('#demonstration-dialog').open && document.querySelector('#active-run .demonstration-panel') && !document.querySelector('#active-run .demonstration-handoff').disabled`);
    };
    await startDemonstration();
    assert.equal(await evaluate(`document.querySelector('#active-run .demonstration-finish').disabled`),true,'登录页不能完成示范');
    assert.equal(await evaluate(`document.querySelector('#active-run .demonstration-action-form')===null`),true,'登录页不能提供查询输入');
    assert.equal(await evaluate(`document.querySelector('#plan-submit').disabled`),true,'示范持有执行范围，不允许另起任务');
    await click('#active-run .demonstration-handoff');
    await wait(`document.querySelector('#active-run .demonstration-resume') && !document.querySelector('#active-run .demonstration-resume').disabled`);
    assert.equal(await evaluate(`document.querySelector('#active-run .demonstration-observe').disabled`),true);
    await click('#active-run .demonstration-resume');
    await wait(`document.querySelector('#active-run .demonstration-act') && !document.querySelector('#active-run .demonstration-act').disabled`);
    assert.equal(snapshot.busy,true,'主进程示范busy不应锁死示范面板');
    assert.equal(await evaluate(`document.querySelectorAll('#active-run .demonstration-element option').length`),2);
    assert.equal(await evaluate(`document.querySelector('#active-run .demonstration-observation b')===null`),true,'不可信页面文字不得注入HTML');
    await evaluate(`document.querySelector('#active-run .demonstration-value').value='2026-10';document.querySelector('#active-run .demonstration-action-form').requestSubmit()`);
    assert.equal(await evaluate(`document.querySelector('#active-run .demonstration-act').disabled`),true,'动作期间拒绝重复点击');
    await wait(`document.querySelector('#active-run .demonstration-finish') && !document.querySelector('#active-run .demonstration-finish').disabled`);
    assert.equal(calls.filter(call=>call.action==='demo.act').length,1);
    const usedRef=calls.find(call=>call.action==='demo.act').payload.action.ref;
    assert.notEqual(await evaluate(`document.querySelector('#active-run .demonstration-element').value`),usedRef,'动作后必须使用新引用');
    await click('#active-run .demonstration-observe');
    await wait(`!document.querySelector('#active-run .demonstration-observe').disabled`);
    await evaluate(`document.querySelector('#active-run .demonstration-panel').scrollIntoView({block:'center'})`);
    await capture('product-demonstration-recording');
    for(const [width,height]of [[1920,1080],[1440,900],[1366,768],[1024,768],[780,640],[390,844]]){
      win.setContentSize(width,height);await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),true,`demonstration overflow at ${width}`);
      assert.equal(await evaluate(`document.querySelector('#active-run .demonstration-panel').getBoundingClientRect().right<=innerWidth`),true);
    }
    win.setContentSize(1440,900);
    await click('#active-run .demonstration-finish');
    assert.equal(calls.filter(call=>call.action==='demo.finish').length,0,'完成示范必须二次确认');
    await click('#confirm-action');
    await wait(`document.querySelector('#toast').textContent.includes('页面结果发生变化') && !document.querySelector('#active-run .demonstration-finish').disabled`);
    assert.equal(snapshot.agentTasks[0].status,'running','页面变化不能冒充完成');
    assert.equal(await evaluate(`[...document.querySelectorAll('#active-run button')].some(button=>button.textContent==='保存为浏览器工作流')`),false);
    await click('#active-run .demonstration-finish');await click('#confirm-action');
    await wait(`[...document.querySelectorAll('#active-run button')].some(button=>button.textContent==='保存为浏览器工作流')`);
    await capture('product-demonstration-completed');
    await evaluate(`[...document.querySelectorAll('#active-run button')].find(button=>button.textContent==='保存为浏览器工作流').click();document.querySelector('#workflow-name').value='人工示范的月份查询';document.querySelector('#save-workflow-form').requestSubmit();`);
    await wait(`!document.querySelector('#save-dialog').open && document.querySelector('#quick-workflows').textContent.includes('人工示范的月份查询')`);
    assert.equal(calls.filter(call=>call.action==='agent.skill.save').length,1);
    assert.equal(calls.filter(call=>call.action==='model.test').length,1,'人工示范不得新增模型连接调用');
    await startDemonstration();
    await evaluate(`[...document.querySelectorAll('#active-run button')].find(button=>button.textContent==='取消任务').click()`);
    await wait(`document.querySelector('#active-run').textContent.includes('已取消')`);
    assert.equal(calls.filter(call=>call.action==='demo.cancel').length,1);
    await startDemonstration();
    snapshot.agentTasks[0].status='interrupted';snapshot.busy=false;snapshot.demonstration=null;win.webContents.send('workbench:update',snapshot);
    await wait(`document.querySelector('#active-run').textContent.includes('重启后不会恢复旧页面引用')`);
    assert.equal(await evaluate(`[...document.querySelectorAll('#active-run button')].some(button=>/继续任务|继续示范/.test(button.textContent))`),false,'中断示范不允许普通模型继续入口');
    assert.equal(await evaluate(`[...document.querySelectorAll('#active-run button')].some(button=>button.textContent==='取消任务')`),false,'中断示范保留原记录，不显示无效取消入口');
    await evaluate(`[...document.querySelectorAll('#active-run button')].find(button=>button.textContent==='重新示范').click()`);
    await wait(`document.querySelector('#demonstration-dialog').open`);
    assert.equal(await evaluate(`document.querySelector('#demonstration-goal').value`),'按月份查看合成资料');
    await click('#demonstration-dialog .close-dialog');
    assert.equal(calls.filter(call=>call.action==='agent.resume').length,1,'中断示范不能新增普通模型继续调用');
    await click('.nav-item[data-view="settings"]');
    for(const [width,height] of [[1920,1080],[1440,900],[1366,768],[1024,768],[780,640],[390,844]]) {
      win.setContentSize(width,height);
      await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      assert.equal(await evaluate(`document.documentElement.scrollWidth<=window.innerWidth`),true,`settings overflow at ${width}`);
      assert.equal(await evaluate(`document.querySelector('#model-profile-list').getBoundingClientRect().right<=window.innerWidth`),true);
    }
    win.setContentSize(1440,900);
    // 撤权清理回归：锁定时必须清空示范私有内容与输入。
    await startDemonstration();await click('#active-run .demonstration-handoff');
    await wait(`document.querySelector('#active-run .demonstration-resume') && !document.querySelector('#active-run .demonstration-resume').disabled`);
    await click('#active-run .demonstration-resume');
    await wait(`document.querySelector('#active-run .demonstration-element') && !document.querySelector('#active-run .demonstration-element').disabled`);
    await evaluate(`const control=document.querySelector('#active-run .demonstration-element');control.selectedIndex=1;control.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#active-run .demonstration-value').value='旧身份私有查询';`);
    win.webContents.send('workbench:update',{...snapshot,identity:null,product:{mode:'personal',authenticated:false},busy:false,demonstration:null,agentTasks:[],agentSkills:[]});
    await wait(`document.body.classList.contains('product-locked') && document.querySelector('.demonstration-panel')===null`);
    assert.equal(await evaluate(`document.body.textContent.includes('旧身份私有查询')`),false);
    assert.equal(await evaluate(`document.querySelector('#demonstration-goal').value`),'');
    assert.equal(errors.length,0,errors.join('\n'));
    console.log('SMOKE personal UI: 个人开源版入口收敛（无登录注册/公司流程元素）、自定义模型连接与费用确认、合成写入与参数化、受控人工示范、无模型HTTPS Skill/有限引用恢复进度/登录从头重放/页面异常检查/撤权清理与 6 档布局通过（合成 IPC）。');
  } finally {ipcMain.removeHandler('workbench:invoke');win.destroy();}
}

if(process.versions.electron&&resolve(process.argv[1]||'')===fileURLToPath(import.meta.url)) {
  const {app,BrowserWindow}=await import('electron');
  app.setPath('userData',await mkdtemp(join(tmpdir(),'yuanyu-product-ui-')));
  app.whenReady().then(()=>runProductUISmoke({BrowserWindow})).then(()=>app.exit(0),error=>{console.error(error.stack);app.exit(1);});
}
