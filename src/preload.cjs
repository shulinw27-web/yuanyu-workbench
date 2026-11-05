const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('workbench', Object.freeze({
  invoke:(action,payload={})=>ipcRenderer.invoke('workbench:invoke',action,payload),
  onUpdate:callback=>{
    const handler=(_event,value)=>callback(value);
    ipcRenderer.on('workbench:update',handler);
    return ()=>ipcRenderer.removeListener('workbench:update',handler);
  }
}));
