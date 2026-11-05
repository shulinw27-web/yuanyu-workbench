import assert from 'node:assert/strict';
import {createInteractiveBrowser} from '../src/browser/interactive.mjs';
import {startInteractiveMockSite} from '../src/mock/interactive-fixture.mjs';

export async function runInteractiveSmoke({BrowserWindow}) {
  const fixture=await startInteractiveMockSite();const windows=[];
  function TrackedWindow(options){const window=new BrowserWindow(options);windows.push(window);return window;}
  const browser=createInteractiveBrowser({BrowserWindow:TrackedWindow,sites:[fixture.site],show:false});
  const id=fixture.site.id;
  async function human(script){const contents=windows[0].webContents;let timer,loaded,failed;
    const navigation=new Promise((resolve,reject)=>{loaded=resolve;failed=(_event,code,_message,_url,main)=>{if(main && code!==-3)reject(new Error('MOCK_HUMAN_NAVIGATION_FAILED'));};contents.once('did-finish-load',loaded);contents.on('did-fail-load',failed);timer=setTimeout(()=>reject(new Error('MOCK_HUMAN_NAVIGATION_TIMEOUT')),5000);});
    try {await contents.executeJavaScript(`(()=>{${script}})()`,true);await navigation;}finally{clearTimeout(timer);contents.removeListener('did-finish-load',loaded);contents.removeListener('did-fail-load',failed);}
  }
  try {
    await browser.open(id);let observation=await browser.observe(id);
    const loginField=observation.elements.find(e=>e.credential);assert.ok(loginField);
    await assert.rejects(browser.act(id,{type:'fill',ref:loginField.ref,value:'not-a-secret'}),e=>e.code==='CREDENTIAL_FIELD_REQUIRES_TRUSTED_FILL');
    await browser.fillCredential(id,{origin:fixture.site.origin,username:'demo',password:'interactive123'});
    observation=await browser.observe(id);assert.ok(!JSON.stringify(observation).includes('interactive123'));
    await browser.handoff(id);await assert.rejects(browser.observe(id),e=>e.code==='MANUAL_HANDOFF_ACTIVE');
    await human(`document.querySelector('#login-submit').click();`);
    observation=await browser.resume(id);assert.ok(observation.text.includes('需要用户完成'));
    const otp=observation.elements.find(e=>e.credential);assert.ok(otp);
    await assert.rejects(browser.act(id,{type:'fill',ref:otp.ref,value:'246810'}),e=>e.code==='CREDENTIAL_FIELD_REQUIRES_TRUSTED_FILL');
    await browser.handoff(id);await human(`document.querySelector('input[name="otp"]').value='246810';document.querySelector('#mfa-submit').click();`);
    observation=await browser.resume(id);assert.ok(observation.text.includes('SYN-101'));
    for(const secret of ['interactive123','hidden-fixture-token','private-input-value','hidden-fixture-text','aria-hidden-fixture-text','css-hidden-fixture-text','visible-query-secret','visible-token-secret'])assert.ok(!JSON.stringify(observation).includes(secret),`观察应剔除隐藏或敏感内容：${secret}`);
    await assert.rejects(browser.act(id,{type:'fill',ref:otp.ref,value:'old'}),e=>e.code==='STALE_REFERENCE');
    let select=observation.elements.find(e=>e.tag.toLowerCase()==='select');assert.ok(select);
    await browser.act(id,{type:'select',ref:select.ref,value:'2026-09'});observation=await browser.observe(id);
    let search=observation.elements.find(e=>e.label.includes('筛选合成记录'));assert.ok(search);
    await browser.act(id,{type:'click',ref:search.ref});observation=await browser.observe(id);assert.ok(observation.text.includes('SYN-091'));
    const change=observation.elements.find(e=>e.label.includes('切换合成页面版本'));assert.ok(change);
    await browser.act(id,{type:'click',ref:change.ref});observation=await browser.observe(id);assert.ok(observation.text.includes('页面版本 2'));
    await assert.rejects(browser.act(id,{type:'click',ref:search.ref}),e=>e.code==='STALE_REFERENCE');
    observation=await browser.observe(id);const business=observation.elements.find(e=>e.label.includes('提交合成业务写入'));assert.ok(business);
    await assert.rejects(browser.act(id,{type:'click',ref:business.ref}),e=>e.code==='WRITE_CONFIRM_REQUIRED');assert.equal(fixture.getWriteCount(),0);
    await browser.close();await assert.rejects(browser.observe(id),e=>e.code==='CANCELLED');
    console.log('PASS 交互浏览器：可信填充、人工登录/MFA接管、只读筛选、页面版本变化、过期引用、敏感内容过滤、业务写入拒绝。');
  }finally{await browser.close();await fixture.close();}
}
