import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createController,safeError} from '../src/controller.mjs';
import {createPromotionService} from '../src/service/index.mjs';
import {createProductClient} from '../src/product/client.mjs';
import {startInteractiveMockSite} from '../src/mock/interactive-fixture.mjs';
import {createInteractiveBrowser} from '../src/browser/interactive.mjs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
export async function runDemonstrationSmoke({BrowserWindow,cryptoAdapter,systems,dataDir}){
  const {ipcMain}=await import('electron');
  const fixture=await startInteractiveMockSite();
  const service=await createPromotionService({dataDir:join(dataDir,'demo-learning-service'),demo:true,monthlyTokens:100000,dailyRequests:20});
  const privateDir=join(dataDir,'demo-learning-client');
  const productClient=createProductClient({dataDir:privateDir,cryptoAdapter,baseUrl:service.url,allowLocalDemo:true});
  const windows=[],updates=[],calls=[];
  let injectStale=false,injected=0,staleFailures=0;
  function ControlledWindow(options){const win=new BrowserWindow(options);windows.push(win);return win;}
  const ui=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{preload:join(root,'src/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,offscreen:true}});
  const uiUrl=pathToFileURL(join(root,'src/ui/index.html')).href;
  let controller,stage='initialize';
  ui.webContents.on('console-message',event=>{if(event.level==='error')console.error('DEMONSTRATION renderer error:',event.message);});
  const evaluate=async code=>{try{return await ui.webContents.executeJavaScript(code,true);}catch(error){throw new Error('DEMONSTRATION_UI_SCRIPT_FAILED at '+stage,{cause:error});}};
  const until=async(check,label)=>{const deadline=Date.now()+12000;while(Date.now()<deadline){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,60));}throw new Error('DEMONSTRATION_SMOKE_TIMEOUT: '+label);};
  const waitUi=(code,label)=>until(()=>evaluate(code),label);
  const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const invoke=async(action,payload={})=>{const response=await evaluate(`window.workbench.invoke(${JSON.stringify(action)},${JSON.stringify(payload)})`);assert.equal(response.ok,true,JSON.stringify(response.error));return response.data;};
  const taskState=async(id,status)=>until(async()=>{const state=await controller.snapshot(),task=state.agentTasks.find(task=>task.id===id);if(task?.status==='failed')throw new Error('DEMONSTRATION_SMOKE_FAILED: '+JSON.stringify(task.error));return task?.status===status&&!state.busy?task:false;},status);
  const businessWindow=()=>{const matches=windows.filter(win=>!win.isDestroyed()&&win.webContents.getURL().startsWith(fixture.site.origin+'/'));assert.equal(matches.length,1);return matches[0];};
  async function humanLogin(){
    const win=businessWindow(),contents=win.webContents;
    assert.equal(new URL(contents.getURL()).origin,fixture.site.origin);
    assert.deepEqual(await contents.executeJavaScript('({node:typeof require,bridge:typeof window.workbench})'),{node:'undefined',bridge:'undefined'});
    assert.ok(!contents.getLastWebPreferences().preload);
    // Trusted test-only input is confined to this literal synthetic fixture.
    await contents.executeJavaScript(`(()=>{if(location.origin!==${JSON.stringify(fixture.site.origin)})throw Error('FIXTURE_ONLY');const form=document.querySelector('#interactive-login');form.querySelector('[name="username"]').value='demo';form.querySelector('[name="password"]').value='interactive123';document.querySelector('#login-submit').click();})()`,true);
    await until(async()=>!contents.isLoadingMainFrame()&&new URL(contents.getURL()).pathname==='/mfa'&&await contents.executeJavaScript("!!document.querySelector('#mfa-submit')"),'human MFA');
    await contents.executeJavaScript(`(()=>{if(location.origin!==${JSON.stringify(fixture.site.origin)}||location.pathname!=='/mfa')throw Error('FIXTURE_ONLY');document.querySelector('[name="otp"]').value='246810';document.querySelector('#mfa-submit').click();})()`,true);
    await until(async()=>!contents.isLoadingMainFrame()&&new URL(contents.getURL()).pathname==='/records'&&await contents.executeJavaScript("!!document.querySelector('[data-authenticated]')"),'human records');
  }
  try{
    controller=await createController({dataDir:privateDir,cryptoAdapter,systems,productClient,BrowserWindow:ControlledWindow,builtinSites:[fixture.site],browserShow:false,
      interactiveFactory:options=>{
        const browser=createInteractiveBrowser(options);
        return {...browser,act:async(siteId,action)=>{
          // Invalidate an observed reference in the real fixture DOM before the first replay action.
          // The production browser must reject it before acting; the replay layer then observes once more.
          if(injectStale&&injected===0&&action.type==='select'){
            injected++;
            await businessWindow().webContents.executeJavaScript(`(()=>{if(location.origin!==${JSON.stringify(fixture.site.origin)})throw Error('FIXTURE_ONLY');document.querySelector('select').setAttribute('data-recovery-fixture','changed')})()`);
          }
          try{return await browser.act(siteId,action);}catch(error){if(error.code==='STALE_REFERENCE')staleFailures++;throw error;}
        }};
      },onUpdate:state=>{updates.push(state);if(!ui.isDestroyed())ui.webContents.send('workbench:update',state);}});
    ipcMain.handle('workbench:invoke',async(event,action,payload)=>{
      if(event.sender!==ui.webContents||event.senderFrame!==ui.webContents.mainFrame||event.senderFrame.url!==uiUrl)return {ok:false,error:{code:'IPC_DENIED'}};
      calls.push(action);try{return {ok:true,data:await controller.invoke(action,payload)};}catch(error){return {ok:false,error:safeError(error)};}
    });
    await ui.loadURL(uiUrl);
    stage='register';const account=await invoke('auth.register',{email:'guided-desktop@example.invalid',name:'合成示范用户',password:'synthetic-demonstration-account'});
    await invoke('auth.verify',{code:account.demoVerificationCode});
    await waitUi("!document.body.classList.contains('product-locked')&&!document.querySelector('#demonstration-open').disabled",'registered UI');
    stage='open demonstration';await click('[data-view="workspace"]');await click('#demonstration-open');
    await waitUi("document.querySelector('#demonstration-dialog').open",'start dialog');
    await evaluate("document.querySelector('#demonstration-goal').value='按月份筛选合成记录并核对';document.querySelector('#demonstration-form').requestSubmit()");
    const original=await until(async()=>(await controller.snapshot()).agentTasks.find(task=>task.execution==='demonstration'),'start task');
    await waitUi("!!document.querySelector('.demonstration-handoff')&&!document.querySelector('.demonstration-handoff').disabled",'handoff UI');
    stage='handoff';await click('.demonstration-handoff');await waitUi("!!document.querySelector('.demonstration-resume')&&!document.querySelector('.demonstration-resume').disabled",'resume control');
    await humanLogin();await click('.demonstration-resume');
    await waitUi("!!document.querySelector('.demonstration-element')&&!document.querySelector('.demonstration-act').disabled",'safe controls');
    stage='select month';await evaluate("(()=>{const control=document.querySelector('.demonstration-element');control.value=[...control.options].find(option=>option.text.startsWith('月份')).value;control.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('.demonstration-value').value='2026-09';document.querySelector('.demonstration-action-form').requestSubmit()})()");
    await until(async()=>{const state=await controller.snapshot();return state.demonstration&&!state.demonstration.operationPending&&state.agentTasks.find(task=>task.id===original.id)?.trace.some(entry=>entry.tool==='select');},'record select');
    await waitUi("!document.querySelector('.demonstration-act').disabled",'next control ready');
    stage='filter records';await evaluate("(()=>{const control=document.querySelector('.demonstration-element');control.value=[...control.options].find(option=>option.text==='筛选合成记录').value;control.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('.demonstration-action-form').requestSubmit()})()");
    await until(async()=>{const state=await controller.snapshot();return state.demonstration?.canFinish&&state.demonstration.page.text.includes('SYN-091')&&state.demonstration.page.text.includes('9087')&&!state.demonstration.operationPending;},'fresh September result');
    await waitUi("!document.querySelector('.demonstration-finish').disabled",'finish available');
    await evaluate("document.querySelector('.demonstration-observation').open=true;new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    await mkdir(join(root,'output/screenshots'),{recursive:true});
    await writeFile(join(root,'output/screenshots/demonstration-recording.png'),(await ui.webContents.capturePage()).toPNG());
    stage='finish';
    await evaluate("document.querySelector('.demonstration-finish').scrollIntoView({block:'center'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    assert.equal(await evaluate("(()=>{const button=document.querySelector('.demonstration-finish'),rect=button.getBoundingClientRect();return document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)?.closest('.demonstration-finish')===button})()"),true,'完成示范按钮应能滚动到输入框上方并实际点击');
    await click('.demonstration-finish');assert.equal((await controller.snapshot()).agentTasks.find(task=>task.id===original.id).status,'running');
    await click('#confirm-action');await taskState(original.id,'completed');
    await waitUi("[...document.querySelectorAll('#active-run button')].some(button=>button.textContent==='保存为浏览器工作流'&&!button.disabled)",'save learned skill');
    stage='save skill';await evaluate("[...document.querySelectorAll('#active-run button')].find(button=>button.textContent==='保存为浏览器工作流').click();document.querySelector('#workflow-name').value='人工示范月度查询';document.querySelector('#workflow-pinned').checked=true;document.querySelector('#save-workflow-form').requestSubmit()");
    const skill=await until(async()=>(await controller.snapshot()).agentSkills.find(skill=>skill.name==='人工示范月度查询'),'save skill');
    const stepIndex=skill.template.recipe.findIndex(entry=>entry.tool==='select');assert.ok(stepIndex>=0);
    const edited=await invoke('agent.skill.edit',{id:skill.id,expectedVersion:1,parameters:[{name:'month',stepIndex,label:'查询月份',defaultValue:'2026-09'}]});
    injectStale=true;
    stage='replay';const replay=await invoke('agent.skill.run',{id:skill.id,mode:'mock_browser',expectedVersion:edited.version,values:{month:'2026-10'}});
    await until(async()=>(await controller.snapshot()).agentTasks.find(task=>task.id===replay.taskId)?.status==='awaiting_user','replay login');
    await humanLogin();await invoke('agent.resume',{id:replay.taskId});await taskState(replay.taskId,'completed');
    assert.ok(await businessWindow().webContents.executeJavaScript("document.querySelector('tbody').textContent.includes('SYN-101')&&document.querySelector('tbody').textContent.includes('12345')"));
    const state=await controller.snapshot(),disk=await readFile(join(privateDir,'agents',state.identity.companyId,state.identity.userId,'state.json'),'utf8');
    assert.equal(injected,1);assert.equal(staleFailures,1,'浏览器必须实际拒绝过期引用，再由重放层有界恢复');
    const recovered=state.agentTasks.find(task=>task.id===replay.taskId);
    assert.equal(recovered.replay.state,'completed');
    assert.ok(recovered.steps.some(step=>step.id.startsWith('recovery-')&&step.status==='completed'),'恢复尝试应记录为完成步骤');
    assert.ok(updates.some(update=>update.agentTasks.some(task=>task.id===replay.taskId&&task.replay?.state==='recovering'&&task.replay.retries===1)));
    assert.equal(state.product.usage.dailyRequestsUsed,0);assert.equal(state.product.usage.usedTokens,0);
    for(const secret of ['interactive123','246810','hidden-fixture-token','visible-token-secret','visible-query-secret'])assert.ok(!JSON.stringify(updates).includes(secret));
    for(const value of ['SYN-091','SYN-101'])assert.ok(!disk.includes(value));
    assert.ok(calls.includes('demo.start')&&calls.includes('demo.act')&&calls.includes('demo.finish')&&calls.includes('agent.skill.save'));
    console.log('PASS 受控示范与恢复：真实UI录9月→保存Skill→改10月→真实DOM变更导致旧ref拒绝→仅当前步骤重新观察重试1次→实际网页结果；未调用模型、未扣额度、未落盘网页/引用。');
  }finally{ipcMain.removeHandler('workbench:invoke');await controller?.close();ui.destroy();for(const win of windows)if(!win.isDestroyed())win.destroy();await fixture.close();await service.close();}
}

if(process.versions.electron&&resolve(process.argv[1]||'')===fileURLToPath(import.meta.url)){
  const {app,BrowserWindow,safeStorage}=await import('electron');
  const dataDir=await mkdtemp(join(tmpdir(),'yuanyu-guided-desktop-'));
  app.setPath('userData',join(dataDir,'electron'));
  app.whenReady().then(async()=>{
    const {startMockSystems}=await import('../src/mock/systems.mjs');const mocks=await startMockSystems();
    try{assert.ok(safeStorage.isEncryptionAvailable());await runDemonstrationSmoke({BrowserWindow,systems:mocks.systems,dataDir,cryptoAdapter:{available:()=>safeStorage.isEncryptionAvailable(),encrypt:text=>safeStorage.encryptString(text).toString('base64'),decrypt:text=>safeStorage.decryptString(Buffer.from(text,'base64'))}});}finally{await mocks.close();}
  }).then(()=>app.exit(0),error=>{console.error(error.stack);app.exit(1);});
}
