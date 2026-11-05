import {runProductUISmoke} from '../scripts/product-ui-smoke.mjs';
import electron from 'electron';
import {mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

export {runProductUISmoke};

if(process.versions.electron&&resolve(process.argv[1]||'')===fileURLToPath(import.meta.url)) {
  const {app,BrowserWindow}=electron;
  app.setPath('userData',await mkdtemp(join(tmpdir(),'yuanyu-product-ui-')));
  app.whenReady().then(()=>runProductUISmoke({BrowserWindow})).then(()=>app.exit(0),error=>{console.error(error.stack);app.exit(1);});
}
