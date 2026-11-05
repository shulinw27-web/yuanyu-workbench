import { app, BrowserWindow, ipcMain, safeStorage, shell,nativeTheme,clipboard } from 'electron';
import { mkdirSync,mkdtempSync } from 'node:fs';
import { homedir,tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startMockSystems } from './mock/systems.mjs';
import {startInteractiveMockSite} from './mock/interactive-fixture.mjs';
import {createProductClient} from './product/client.mjs';
import {createPromotionService} from './service/index.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import { createController, safeError } from './controller.mjs';

const here=dirname(fileURLToPath(import.meta.url));
if(process.argv.includes('--smoke'))console.log('SMOKE: initializing desktop');
const dataDir=resolve(process.argv.includes('--smoke') ? mkdtempSync(join(tmpdir(),'yuanyu-desktop-smoke-')) : process.env.YUANYU_DATA_DIR || join(process.env.LOCALAPPDATA || homedir(),process.platform==='win32'?'YuanyuWorkbench':'.yuanyu-workbench'));
mkdirSync(join(dataDir,'electron'),{recursive:true});
app.setPath('userData',join(dataDir,'electron'));
app.setName('元域个人工作台');
const cryptoAdapter={
  available:()=>safeStorage.isEncryptionAvailable() && !(process.platform==='linux' && safeStorage.getSelectedStorageBackend?.()==='basic_text'),
  encrypt:text=>safeStorage.encryptString(text).toString('base64'),
  decrypt:cipher=>safeStorage.decryptString(Buffer.from(cipher,'base64'))
};
let controller,mocks,interactiveMock,promotionService,win,quitting=false;
app.whenReady().then(async()=>{
 if(process.argv.includes('--smoke'))console.log('SMOKE: Electron ready');
 try {
  mocks=await startMockSystems(process.argv.includes('--smoke') ? {} : {ports:{procurement:15331,warehouse:15332}});
  if(process.argv.includes('--smoke')) {
    const {runDesktopSmoke}=await import('../scripts/desktop-smoke.mjs');
    await runDesktopSmoke({BrowserWindow,safeStorage,cryptoAdapter,systems:mocks.systems,dataDir});
    const {runInteractiveSmoke}=await import('../scripts/interactive-smoke.mjs');
    await runInteractiveSmoke({BrowserWindow});
    const {runAgentSmoke}=await import('../scripts/agent-smoke.mjs');
    await runAgentSmoke({BrowserWindow,cryptoAdapter,systems:mocks.systems,dataDir});
    const {runProductUISmoke}=await import('../scripts/product-ui-smoke.mjs');
    await runProductUISmoke({BrowserWindow});
    const {runProductIntegrationSmoke}=await import('../scripts/product-integration-smoke.mjs');
    await runProductIntegrationSmoke({BrowserWindow,cryptoAdapter,systems:mocks.systems,dataDir});
    await mocks.close();app.exit(0);
  } else {
    interactiveMock=await startInteractiveMockSite({port:15333});
    const productConfigPath=join(dataDir,'product.local.json');
    try{await writeFile(productConfigPath,JSON.stringify({schemaVersion:1,serviceUrl:'http://127.0.0.1:15334',allowLocalDemo:true,autoStartLocalDemo:true},null,2),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
    const productConfig=JSON.parse(await readFile(productConfigPath,'utf8'));
    if(productConfig.schemaVersion!==1||Object.keys(productConfig).some(key=>!['schemaVersion','serviceUrl','allowLocalDemo','autoStartLocalDemo'].includes(key)))throw new Error('SERVICE_CONFIG_INVALID');
    if(productConfig.autoStartLocalDemo===true){
      if(productConfig.allowLocalDemo!==true||productConfig.serviceUrl!=='http://127.0.0.1:15334')throw new Error('SERVICE_CONFIG_INVALID');
      promotionService=await createPromotionService({dataDir:join(dataDir,'promotion-service'),port:15334,demo:true,monthlyTokens:100000,dailyRequests:20});
    }
    const productClient=createProductClient({dataDir,cryptoAdapter,baseUrl:productConfig.serviceUrl,allowLocalDemo:productConfig.allowLocalDemo===true});
    win=new BrowserWindow({width:1420,height:940,minWidth:780,minHeight:640,backgroundColor:nativeTheme.shouldUseDarkColors?'#202020':'#ffffff',autoHideMenuBar:true,webPreferences:{preload:join(here,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
    const uiUrl=pathToFileURL(join(here,'ui','index.html')).href;
    controller=await createController({dataDir,cryptoAdapter,systems:mocks.systems,BrowserWindow,builtinSites:[interactiveMock.site],productClient,copyText:text=>clipboard.writeText(text),openPath:async path=>{const error=await shell.openPath(path);if(error)throw new Error('ARTIFACT_OPEN_FAILED');},onUpdate:snapshot=>{if(win && !win.isDestroyed())win.webContents.send('workbench:update',snapshot);}});
    ipcMain.handle('workbench:invoke',async(event,action,payload)=>{
      if(event.sender!==win.webContents || event.senderFrame!==win.webContents.mainFrame || event.senderFrame.url!==uiUrl)return {ok:false,error:{code:'IPC_DENIED',message:'请求来源不受信任。'}};
      try{return {ok:true,data:await controller.invoke(action,payload)};}catch(error){return {ok:false,error:safeError(error)};}
    });
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.on('will-navigate',(event,url)=>{if(url!==uiUrl)event.preventDefault();});
    win.webContents.session.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
    await win.loadURL(uiUrl);
  }
 } catch (error) {
  process.stderr.write('工作台启动或集成验证失败，请检查本机数据目录与测试报告。\n');
  if(process.argv.includes('--smoke'))process.stderr.write(String(error?.stack || error?.message || 'TEST_FAILED').replaceAll('demo123','[synthetic credential redacted]')+'\n');
  await controller?.close();await interactiveMock?.close();await promotionService?.close();await mocks?.close();app.exit(1);
 }
});
app.on('window-all-closed',()=>{if(!process.argv.includes('--smoke'))app.quit();});
app.on('before-quit',event=>{
  if(quitting)return;
  event.preventDefault();quitting=true;
  Promise.resolve().then(()=>controller?.close()).then(()=>interactiveMock?.close()).then(()=>promotionService?.close()).then(()=>mocks?.close()).finally(()=>app.exit(0));
});
