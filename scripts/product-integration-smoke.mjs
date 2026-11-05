import assert from 'node:assert/strict';
import {join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import {createController,safeError} from '../src/controller.mjs';
import {createProductClient} from '../src/product/client.mjs';
import {createPromotionService} from '../src/service/index.mjs';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
/** Real HTTP + OS encryption + Electron IPC. Every upstream response remains explicitly synthetic. */
export async function runProductIntegrationSmoke({BrowserWindow,cryptoAdapter,systems,dataDir}) {
  const {ipcMain}=await import('electron');
  const dir=join(dataDir,'registered-product'),service=await createPromotionService({dataDir:join(dataDir,'registered-service'),demo:true,monthlyTokens:100000,dailyRequests:20});
  const productClient=createProductClient({dataDir:dir,cryptoAdapter,baseUrl:service.url,allowLocalDemo:true});
  const win=new BrowserWindow({show:false,width:1440,height:900,webPreferences:{preload:join(root,'src/preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  const uiUrl=pathToFileURL(join(root,'src/ui/index.html')).href;
  let controller;
  try {
    controller=await createController({dataDir:dir,cryptoAdapter,systems,BrowserWindow,productClient,browserShow:false,onUpdate:snapshot=>{if(!win.isDestroyed())win.webContents.send('workbench:update',snapshot);}});
    ipcMain.handle('workbench:invoke',async(event,action,payload)=>{
      if(event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||event.senderFrame.url!==uiUrl)return {ok:false,error:{code:'IPC_DENIED'}};
      try{return {ok:true,data:await controller.invoke(action,payload)};}catch(error){return {ok:false,error:safeError(error)};}
    });
    await win.loadURL(uiUrl);
    const invoke=(action,payload={})=>win.webContents.executeJavaScript(`window.workbench.invoke(${JSON.stringify(action)},${JSON.stringify(payload)})`,true);
    const registered=await invoke('auth.register',{email:'desktop-synthetic@example.invalid',name:'合成个人账号',password:'synthetic-desktop-password-2026'});
    assert.equal(registered.ok,true,JSON.stringify(registered.error));
    assert.equal((await invoke('auth.verify',{code:registered.data.demoVerificationCode})).ok,true);
    assert.equal((await invoke('workflow.import',{publicationId:'sample-purchase-monthly'})).error.code,'ENTERPRISE_REQUIRED');
    const tested=await invoke('model.test',{consent:true});assert.equal(tested.ok,true,JSON.stringify(tested.error));
    let state=(await invoke('snapshot')).data;assert.equal(state.product.usage.dailyRequestsUsed,1);assert.ok(state.product.usage.usedTokens>0);
    const raw=await readFile(join(dir,'account','session.json'),'utf8');assert.ok(!raw.includes('sessionToken'));assert.ok(!raw.includes('synthetic-desktop-password'));
    const preview=await invoke('write.demo.preview',{month:'2026-10',note:'真实IPC合成源核对备注'});assert.equal(preview.ok,true);
    const confirmed=await invoke('write.demo.confirm',{id:preview.data.id,fingerprint:preview.data.fingerprint});assert.equal(confirmed.data.status,'completed');
    service.operator.setQuota({monthlyTokens:100000,dailyRequests:1});
    const limited=await invoke('model.test',{consent:true});assert.equal(limited.ok,false);assert.equal(limited.error.code,'DAILY_REQUEST_LIMIT');
    service.operator.revokeSessions(registered.data.account.id);
    state=(await invoke('snapshot')).data;assert.equal(state.identity,null);assert.equal(state.product.authenticated,false);assert.equal(state.writeDemo,undefined);
    console.log('SMOKE product integration: 真实 HTTP 注册/验证、OS 会话加密、Electron IPC、服务端额度、企业权限与合成写入回执通过（未调用真实模型）。');
  }finally{ipcMain.removeHandler('workbench:invoke');await controller?.close();win.destroy();await service.close();}
}
