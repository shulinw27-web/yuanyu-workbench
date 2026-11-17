import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, mkdtemp,realpath,rm } from 'node:fs/promises';
import {tmpdir} from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { createController } from '../src/controller.mjs';
import { createBrowserDriver } from '../src/browser/driver.mjs';
import {backupWorkspace,restoreWorkspace} from '../src/runtime/backup.mjs';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const samplePassword='demo123';
const action=async(controller,name,payload)=>controller.invoke(name,payload);
async function diskFiles(dir){const out=[];for(const e of await readdir(dir,{withFileTypes:true})){if(e.name==='electron')continue;const p=join(dir,e.name);if(e.isDirectory())out.push(...await diskFiles(p));else out.push(p);}return out;}

export async function runDesktopSmoke({BrowserWindow,cryptoAdapter,systems,dataDir}) {
  console.log('SMOKE: validating OS encryption and persisted workspace');
  assert.ok(await cryptoAdapter.available(),'本机系统加密必须可用');
  const probe=createBrowserDriver({BrowserWindow,systems,show:false});
  try {const reading=await probe.readSystem('procurement',{month:'2026-10',credential:{username:'demo',password:samplePassword,origin:systems.procurement.origin}});assert.equal(reading.rows.length,4);}catch(error){console.error('SMOKE browser diagnostic:',error.code,error.stage,error.message);throw error;}finally{await probe.close();}
  let controller=await createController({dataDir,cryptoAdapter,systems,BrowserWindow,browserShow:false});
  const updates=[];
  try {
    await assert.rejects(action(controller,'task.run',{month:'2026-10'}),/PLAN_REQUIRED/);
    for(const systemId of ['procurement','warehouse'])await action(controller,'credential.save',{systemId,username:'demo',password:samplePassword});
    assert.equal((await controller.snapshot()).credentials.length,2);
    // Recreate the workspace/controller to prove persisted credentials are usable, not an in-memory cache.
    await controller.close();
    controller=await createController({dataDir,cryptoAdapter,systems,BrowserWindow,browserShow:false,onUpdate:s=>updates.push(s)});
    await action(controller,'task.plan',{text:'整理2026年10月采购月报',month:'2026-10'});
    const first=await action(controller,'task.run',{month:'2026-10'});await controller.waitForIdle();
    console.log('SMOKE: first browser run returned');
    let state=await controller.snapshot();let run=state.runs.find(r=>r.id===first.runId);
    assert.equal(run.status,'completed',JSON.stringify(run.error));
    assert.equal(run.summary.orderCount,3);assert.equal(run.summary.orderedCents,530000);
    assert.equal(run.summary.receivedCents,250000);assert.equal(run.summary.unmatchedCount,1);assert.equal(run.summary.partialCount,1);
    const csv=await readFile(run.artifact.path,'utf8');assert.ok(csv.includes('PO-202610-003'));
    const source=await readFile(run.artifact.sourcePath,'utf8');assert.ok(source.includes(systems.procurement.origin));
    const workflow=await action(controller,'workflow.save',{runId:first.runId,name:'采购月报',pinned:true});
    assert.ok(workflow.id);
    await action(controller,'task.plan',{text:'运行采购月报',month:'2026-09',workflowId:workflow.id});
    const repeated=await action(controller,'workflow.run',{month:'2026-09',workflowId:workflow.id});await controller.waitForIdle();
    run=(await controller.snapshot()).runs.find(r=>r.id===repeated.runId);
    assert.equal(run.status,'completed',JSON.stringify(run.error));assert.equal(run.summary.orderedCents,342222);
    assert.notEqual(run.artifact.path,state.runs[0]?.artifact?.path);
    const publication=await action(controller,'workflow.publish',{id:workflow.id});
    assert.ok(!JSON.stringify(publication).includes('PO-202610'));
    assert.ok(!JSON.stringify(publication).includes(samplePassword));
    await action(controller,'identity.switch',{userId:'outsider'});
    assert.equal((await controller.snapshot()).shared.length,0);
    await assert.rejects(action(controller,'workflow.import',{publicationId:publication.id}));
    await action(controller,'identity.switch',{userId:'bob'});
    state=await controller.snapshot();assert.equal(state.credentials.length,0);assert.equal(state.shared.length,1);
    const imported=await action(controller,'workflow.import',{publicationId:publication.id});
    await action(controller,'task.plan',{text:'运行采购月报',month:'2026-10',workflowId:imported.id});
    const denied=await action(controller,'workflow.run',{month:'2026-10',workflowId:imported.id});await controller.waitForIdle();
    assert.equal((await controller.snapshot()).runs.find(r=>r.id===denied.runId).status,'failed');
    for(const systemId of ['procurement','warehouse'])await action(controller,'credential.save',{systemId,username:'demo',password:samplePassword});
    await action(controller,'task.plan',{text:'运行采购月报',month:'2026-10',workflowId:imported.id});
    const bob=await action(controller,'workflow.run',{month:'2026-10',workflowId:imported.id});await controller.waitForIdle();
    assert.equal((await controller.snapshot()).runs.find(r=>r.id===bob.runId).status,'completed');
    // Cancellation must stay terminal; late browser completion cannot replace it.
    await action(controller,'task.plan',{text:'采购月报',month:'2026-10'});
    const cancelled=await action(controller,'task.run',{month:'2026-10'});
    await action(controller,'run.cancel');await controller.waitForIdle();
    assert.equal((await controller.snapshot()).runs.find(r=>r.id===cancelled.runId).status,'cancelled');
    await action(controller,'identity.switch',{userId:'alice'});
    await action(controller,'workflow.revoke',{id:publication.id});
    await action(controller,'identity.switch',{userId:'bob'});
    assert.equal((await controller.snapshot()).shared.length,0);
    const bad=createBrowserDriver({BrowserWindow,systems,show:false});
    await assert.rejects(bad.readSystem('procurement',{month:'2026-10',credential:{username:'demo',password:'wrong',origin:systems.procurement.origin}}));await bad.close();
    for(const f of await diskFiles(dataDir))assert.ok(!(await readFile(f)).includes(Buffer.from(samplePassword)),`明文凭据不得落盘：${f}`);
    assert.ok(!JSON.stringify(updates).includes(samplePassword),'更新事件不得包含密码');
    console.log('PASS Electron：系统加密、持久重开、双网页真实读取、10月/9月核对、个人Skill、同公司独立凭据、跨公司拒绝、撤回、取消、错误登录。');
  } finally {await controller.close();}
  const recoveryRoot=await mkdtemp(join(tmpdir(),'yuanyu-recovery-')),backupDir=join(recoveryRoot,'backup'),targetDir=join(recoveryRoot,'restored');
  await backupWorkspace({dataDir,backupDir});await restoreWorkspace({backupDir,targetDir});
  const recovered=await createController({dataDir:await realpath(targetDir),cryptoAdapter,systems,BrowserWindow,browserShow:false});
  try {
    const state=await recovered.snapshot();assert.equal(state.credentials.length,2);assert.ok(state.workflows.some(w=>w.name==='采购月报'));
    const canonicalTarget=await realpath(targetDir);assert.ok(state.runs.some(r=>r.artifact?.path.startsWith(canonicalTarget)));
    await recovered.invoke('task.plan',{text:'采购月报',month:'2026-10'});const result=await recovered.invoke('task.run',{month:'2026-10'});await recovered.waitForIdle();
    const run=(await recovered.snapshot()).runs.find(r=>r.id===result.runId);assert.equal(run.status,'completed');assert.equal(run.summary.orderedCents,530000);
    console.log('PASS 恢复：隔离备份校验→新目录恢复→同OS用户原密文可用→真实双网页重新执行；不覆盖原工作区。');
  }finally{await recovered.close();}
  // Render the real workbench preload bridge and inspect responsive geometry.
  const {ipcMain}=await import('electron');
  const ui=new BrowserWindow({show:false,width:1440,height:940,webPreferences:{preload:join(root,'src','preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  ui.webContents.on('console-message',(_e,level,message)=>{if(level>=3)console.error('UI渲染器错误：',message);});
  const uiController=await createController({dataDir,cryptoAdapter,systems,BrowserWindow,browserShow:false,onUpdate:s=>{if(!ui.isDestroyed())ui.webContents.send('workbench:update',s);}});
  const uiUrl=pathToFileURL(join(root,'src','ui','index.html')).href;
  ipcMain.handle('workbench:invoke',async(event,name,payload)=>{
    if(event.sender!==ui.webContents || event.senderFrame!==ui.webContents.mainFrame || event.senderFrame.url!==uiUrl)return {ok:false,error:{code:'IPC_DENIED',message:'请求来源不受信任。'}};
    try{return {ok:true,data:await uiController.invoke(name,payload)};}catch(error){return {ok:false,error:{code:error.code || error.message,message:'测试请求未完成。'}};}
  });
  async function until(expression){for(let i=0;i<100;i++){if(await ui.webContents.executeJavaScript(expression))return;await new Promise(r=>setTimeout(r,100));}throw new Error('UI_CONDITION_TIMEOUT');}
  const runUi=async code=>{let result;try{result=await ui.webContents.executeJavaScript(`(()=>{try{${code};return {ok:true};}catch(error){return {testError:error.message};}})()`);}catch(error){throw new Error(`UI执行被拒绝：${code.slice(0,110)}：${error.message}`);}if(result?.testError)throw new Error(`UI交互失败：${code.slice(0,90)}：${result.testError}`);return result;};
  try {
    await ui.loadFile(join(root,'src','ui','index.html'));
    await until(`document.querySelector('#identity-avatar').textContent==='林' && !document.querySelector('#plan-submit').disabled`);
    const oldRuns=(await uiController.snapshot()).runs.length;
    await runUi(`document.querySelector('#task-input').value='整理2026年10月采购月报';document.querySelector('#task-month').value='2026-10';document.querySelector('#task-form').requestSubmit();`);
    await until(`!document.querySelector('#task-plan').hidden && [...document.querySelectorAll('#task-plan button')].some(b=>b.textContent==='确认执行' && !b.disabled)`);
    await runUi(`[...document.querySelectorAll('#task-plan button')].find(b=>b.textContent==='确认执行').click()`);
    for(let i=0;i<100;i++){const state=await uiController.snapshot();if(state.runs.length>oldRuns && state.runs[0].status!=='running')break;await new Promise(r=>setTimeout(r,100));}
    const uiState=await uiController.snapshot();assert.ok(uiState.runs.length>oldRuns,'UI必须实际创建新的运行，不能复用旧成功记录');
    const uiResult=uiState.runs[0];assert.equal(uiResult.status,'completed',JSON.stringify(uiResult.error));
    assert.equal(uiResult.summary.orderedCents,530000);assert.ok((await readFile(uiResult.artifact.path,'utf8')).includes('PO-202610-003'));
    await until(`document.querySelector('#task-plan').hidden && !document.querySelector('#plan-submit').disabled && document.querySelector('#active-run')?.textContent.includes(${JSON.stringify(uiResult.artifact.name)}) && [...document.querySelectorAll('#active-run button')].some(b=>b.textContent==='保存为工作流')`);
    await runUi(`[...document.querySelectorAll('#active-run button')].find(b=>b.textContent==='保存为工作流').click();document.querySelector('#workflow-name').value='界面回归月报';document.querySelector('#save-workflow-form').requestSubmit();`);
    await until(`!document.querySelector('#save-dialog').open && document.querySelector('#quick-workflows').textContent.includes('界面回归月报')`);
    // 个人开源版：公司流程与登录注册入口必须从界面移除；Mock共享能力仅保留在受控IPC层。
    await until(`!document.querySelector('[data-view="company"]') && !document.querySelector('#view-company') && !document.querySelector('#product-entry') && !document.querySelector('#model-source-settings') && !document.querySelector('#product-account-settings')`);
    await uiController.invoke('workflow.publish',{id:(await uiController.snapshot()).workflows.find(w=>w.name==='界面回归月报').id});
    assert.ok((await uiController.snapshot()).shared.some(p=>p.template.name==='界面回归月报'),'受控IPC层Mock发布仍可用');
    // 项目：界面创建空项目（真实建目录并设为当前）→ 删除记录只移除登记、不删用户文件夹。
    const projectRoot=join(tmpdir(),`yuanyu-ui-project-${Date.now()}`);
    await runUi(`document.querySelector('[data-view="projects"]').click()`);
    await runUi(`document.querySelector('#project-create-name').value='界面回归项目';document.querySelector('#project-create-root').value=${JSON.stringify(projectRoot)};document.querySelector('#project-create-form').requestSubmit();`);
    await until(`[...document.querySelectorAll('#project-list article')].some(c=>c.textContent.includes('界面回归项目') && c.textContent.includes('当前项目') && c.textContent.includes('新建空目录'))`);
    assert.ok((await uiController.snapshot()).projects.projects.some(p=>p.name==='界面回归项目'&&p.origin==='empty'));
    await runUi(`const card=[...document.querySelectorAll('#project-list article')].find(c=>c.textContent.includes('界面回归项目'));[...card.querySelectorAll('button')].find(b=>b.textContent==='删除记录').click();`);
    await runUi(`document.querySelector('#confirm-action').click();`);
    await until(`document.querySelectorAll('#project-list article').length===0`);
    assert.equal((await uiController.snapshot()).projects.projects.length,0);
    await readdir(projectRoot);
    await rm(projectRoot,{recursive:true,force:true});
    // 多模态附件：界面添加图片与文本附件（视频被拒绝），chips 可移除。
    await runUi(`document.querySelector('[data-view="workspace"]').click()`);
    await runUi(`const dt=new DataTransfer();dt.items.add(new File([new Uint8Array([137,80,78,71])],'回归截图.png',{type:'image/png'}));dt.items.add(new File(['SYN-091 参考'],'核对笔记.txt',{type:'text/plain'}));dt.items.add(new File(['video'],'录像.mp4',{type:'video/mp4'}));const input=document.querySelector('#attachment-input');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));`);
    await until(`document.querySelectorAll('#attachment-list .attachment-chip').length===2 && document.querySelectorAll('#attachment-list .attachment-chip')[0].textContent.includes('回归截图.png')`);
    await runUi(`[...document.querySelectorAll('#attachment-list .attachment-remove')][0].click();`);
    await until(`document.querySelectorAll('#attachment-list .attachment-chip').length===1 && document.querySelector('#attachment-list').textContent.includes('核对笔记.txt')`);
    await runUi(`document.querySelector('#attachment-list .attachment-remove').click();`);
    await until(`document.querySelector('#attachment-list').hidden`);
    await runUi(`const picker=document.querySelector('#identity-select');picker.value='bob';picker.dispatchEvent(new Event('change',{bubbles:true}));`);
    await until(`document.querySelector('#identity-avatar').textContent==='陈' && !document.querySelector('#identity-select').disabled`);
    assert.ok((await uiController.snapshot()).workflows.every(w=>w.name!=='界面回归月报'),'跨身份工作流必须隔离');
    await runUi(`const picker=document.querySelector('#identity-select');picker.value='alice';picker.dispatchEvent(new Event('change',{bubbles:true}));`);
    await until(`document.querySelector('#identity-avatar').textContent==='林' && !document.querySelector('#identity-select').disabled`);
    await runUi(`const picker=document.querySelector('#identity-select');picker.value='alice';picker.dispatchEvent(new Event('change',{bubbles:true}));`);
    await until(`document.querySelector('#identity-avatar').textContent==='林' && !document.querySelector('#identity-select').disabled`);
    await runUi(`document.querySelector('[data-view="workspace"]').click();const card=[...document.querySelectorAll('#quick-workflows article')].find(c=>c.querySelector('h3')?.textContent==='界面回归月报');card.querySelector('button').click();document.querySelector('#workflow-month').value='2026-09';document.querySelector('#workflow-run-form').requestSubmit();`);
    await until(`!document.querySelector('#task-plan').hidden && [...document.querySelectorAll('#task-plan button')].some(b=>b.textContent==='确认执行' && !b.disabled)`);
    const previousCount=(await uiController.snapshot()).runs.length;
    await runUi(`[...document.querySelectorAll('#task-plan button')].find(b=>b.textContent==='确认执行').click()`);
    for(let i=0;i<100;i++){const value=await uiController.snapshot();if(value.runs.length>previousCount && value.runs[0].status!=='running')break;await new Promise(r=>setTimeout(r,100));}
    const replay=await uiController.snapshot();assert.ok(replay.runs.length>previousCount);assert.equal(replay.runs[0].status,'completed');assert.equal(replay.runs[0].summary.orderedCents,342222);
    await until(`document.querySelector('#task-plan').hidden && !document.querySelector('#plan-submit').disabled && document.querySelector('#active-run')?.textContent.includes(${JSON.stringify(replay.runs[0].artifact.name)})`);
    // New lifecycle controls must operate on real core revisions, not only render buttons.
    await runUi(`document.querySelector('[data-view="workflows"]').click();const card=[...document.querySelectorAll('#workflow-list article')].find(c=>c.querySelector('h3').textContent==='界面回归月报');[...card.querySelectorAll('button')].find(b=>b.textContent==='编辑').click();document.querySelector('#edit-workflow-name').value='界面回归月报-修订';document.querySelector('#edit-workflow-description').value='合成规则说明';document.querySelector('#edit-workflow-month').value='2026-09';document.querySelector('#edit-workflow-form').requestSubmit();`);
    await until(`!document.querySelector('#edit-workflow-dialog').open && document.querySelector('#workflow-list').textContent.includes('界面回归月报-修订')`);
    let edited=(await uiController.snapshot()).workflows.find(w=>w.name==='界面回归月报-修订');assert.equal(edited.version,2);assert.equal(edited.verified,false);assert.equal((await uiController.snapshot()).shared.length,0);
    await runUi(`const card=[...document.querySelectorAll('#workflow-list article')].find(c=>c.querySelector('h3').textContent==='界面回归月报-修订');[...card.querySelectorAll('button')].find(b=>b.textContent==='停用').click();`);
    await until(`[...document.querySelectorAll('#workflow-list article')].some(c=>c.querySelector('h3').textContent==='界面回归月报-修订' && c.textContent.includes('已停用') && [...c.querySelectorAll('button')].find(b=>b.textContent.includes('运行流程'))?.disabled)`);
    await assert.rejects(uiController.invoke('task.plan',{text:'采购月报',month:'2026-10',workflowId:edited.id}),/WORKFLOW_DISABLED/);
    await runUi(`const card=[...document.querySelectorAll('#workflow-list article')].find(c=>c.querySelector('h3').textContent==='界面回归月报-修订');[...card.querySelectorAll('button')].find(b=>b.textContent==='启用').click();`);
    await until(`[...document.querySelectorAll('#workflow-list article')].some(c=>c.querySelector('h3').textContent==='界面回归月报-修订' && [...c.querySelectorAll('button')].some(b=>b.textContent==='停用' && !b.disabled))`);
    await runUi(`const card=[...document.querySelectorAll('#workflow-list article')].find(c=>c.querySelector('h3').textContent==='界面回归月报-修订');[...card.querySelectorAll('button')].find(b=>b.textContent==='版本历史').click();`);
    await until(`document.querySelector('#workflow-versions-dialog').open && document.querySelectorAll('#workflow-versions-list .version-row').length>=4`);
    await runUi(`const row=[...document.querySelectorAll('#workflow-versions-list .version-row')].find(r=>r.querySelector('strong').textContent.startsWith('v1 '));row.querySelector('button').click();document.querySelector('#confirm-action').click();`);
    await until(`!document.querySelector('#confirm-dialog').open && [...document.querySelectorAll('#workflow-list h3')].some(h=>h.textContent==='界面回归月报') && !document.querySelector('#identity-select').disabled`);
    const restored=(await uiController.snapshot()).workflows.find(w=>w.id===edited.id);assert.equal(restored.version,5);assert.equal(restored.parameters.month,'2026-10');assert.equal(restored.verified,false);
    // Site configuration is persisted without making any external website request.
    await runUi(`document.querySelector('[data-view="accounts"]').click();document.querySelector('#register-site').click();document.querySelector('#site-label').value='合成HTTPS配置（不连接）';document.querySelector('#site-url').value='https://fixture.example.invalid/';document.querySelector('#site-paths').value='/' + String.fromCharCode(10) + '/login';document.querySelector('#site-form').requestSubmit();`);
    await until(`!document.querySelector('#site-dialog').open && document.querySelector('#controlled-site-list').textContent.includes('合成HTTPS配置')`);
    assert.equal((await uiController.snapshot()).sites.length,1);
    await runUi(`document.querySelector('[data-view="settings"]').click();document.querySelector('#theme-select').value='dark';document.querySelector('#theme-select').dispatchEvent(new Event('change'));`);
    assert.equal(await ui.webContents.executeJavaScript(`document.documentElement.dataset.theme`),'dark');
    assert.equal(await ui.webContents.executeJavaScript(`document.querySelector('#model-mode-option').disabled`),true);
    await runUi(`document.querySelector('[data-view="workspace"]').click()`);
    const geometry=await ui.webContents.executeJavaScript(`({title:document.title,width:document.documentElement.scrollWidth,viewport:innerWidth,bridge:typeof window.workbench?.invoke})`);
    assert.equal(geometry.bridge,'function');assert.ok(geometry.title.includes('元域'));
    assert.ok(geometry.width<=geometry.viewport+2,'桌面布局不能水平溢出');
    await mkdir(join(root,'output','screenshots'),{recursive:true});
    const {writeFile}=await import('node:fs/promises');
    await writeFile(join(root,'output','screenshots','workbench-1440.png'),(await ui.webContents.capturePage()).toPNG());
    ui.setSize(1024,768);await new Promise(r=>setTimeout(r,150));
    const narrow=await ui.webContents.executeJavaScript(`({width:document.documentElement.scrollWidth,viewport:innerWidth})`);
    assert.ok(narrow.width<=narrow.viewport+2,'1024宽布局不能水平溢出');
    await writeFile(join(root,'output','screenshots','workbench-1024.png'),(await ui.webContents.capturePage()).toPNG());
    ui.setSize(1920,1080);await new Promise(r=>setTimeout(r,100));assert.ok(await ui.webContents.executeJavaScript(`document.documentElement.scrollWidth<=innerWidth+2`));
    await writeFile(join(root,'output','screenshots','workbench-1920-dark.png'),(await ui.webContents.capturePage()).toPNG());
    await runUi(`document.querySelector('#theme-select').value='light';document.querySelector('#theme-select').dispatchEvent(new Event('change'));`);
    ui.setSize(1366,768);await new Promise(r=>setTimeout(r,100));assert.ok(await ui.webContents.executeJavaScript(`document.documentElement.scrollWidth<=innerWidth+2`));
    await writeFile(join(root,'output','screenshots','workbench-1366-light.png'),(await ui.webContents.capturePage()).toPNG());
    console.log('PASS UI：真实页面计划确认→执行→文件→保存→IPC发布校验→身份隔离→首页换月复用；隔离preload、1440和1024宽度无水平溢出；截图已保存。');
    console.log('PASS UI增强：编辑v2→停用v3→启用v4→恢复v5、撤旧发布、站点注册、模型未配置禁用、深浅主题及1920/1366布局；登录注册与公司流程入口已按个人开源版移除；项目创建空目录与删除记录不删文件；多模态附件chips（视频拒绝）回归通过。');
  } finally {ipcMain.removeHandler('workbench:invoke');await uiController.close();ui.destroy();}
}
