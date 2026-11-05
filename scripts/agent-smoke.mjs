import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createController, safeError } from '../src/controller.mjs';
import { startInteractiveMockSite } from '../src/mock/interactive-fixture.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Real desktop UI + isolated loopback browser. All accounts and page records are synthetic. */
export async function runAgentSmoke({ BrowserWindow, cryptoAdapter, systems, dataDir }) {
  const fixture = await startInteractiveMockSite();
  const privateDataDir = join(dataDir, `agent-ui-${randomUUID()}`);
  const screenshotDir = join(root, 'output', 'screenshots');
  const uiPath = join(root, 'src', 'ui', 'index.html');
  const uiUrl = pathToFileURL(uiPath).href;
  const { ipcMain } = await import('electron');
  const controlledWindows = [];
  const acceptedActions = [];
  const updates = [];
  let controller;
  let ui;
  let handlerInstalled = false;

  // This wrapper observes windows created by the production runtime. It does not alter its policies.
  function TrackedWindow(options) {
    const window = new BrowserWindow(options);
    controlledWindows.push(window);
    return window;
  }

  async function until(check, label, timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await check();
      if (value) return value;
      await delay(80);
    }
    throw new Error(`AGENT_UI_TIMEOUT: ${label}`);
  }

  const runUi = (code) => ui.webContents.executeJavaScript(`(()=>{${code}})()`);
  const untilUi = (expression, label) => until(() => runUi(`return (${expression});`), label);
  const snapshot = () => controller.snapshot();
  const activeTask = async (id) => (await snapshot()).agentTasks.find((task) => task.id === id);

  async function taskWithStatus(id, status) {
    return until(async () => {
      const state = await snapshot();
      const task = state.agentTasks.find((item) => item.id === id);
      if (task?.status === 'failed' && status !== 'failed') {
        throw new Error(`AGENT_SMOKE_TASK_FAILED: ${task.error?.code || 'UNKNOWN'}`);
      }
      return task?.status === status && !state.busy ? task : false;
    }, `${id}: ${status}`);
  }

  async function capture(name) {
    // Let the hidden test window paint the state already observed in the DOM.
    await ui.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await mkdir(screenshotDir, { recursive: true });
    await writeFile(join(screenshotDir, name), (await ui.webContents.capturePage()).toPNG());
  }

  function fixtureWindow() {
    const matches = controlledWindows.filter((window) => {
      if (window.isDestroyed()) return false;
      try { return new URL(window.webContents.getURL()).origin === fixture.site.origin; }
      catch { return false; }
    });
    assert.equal(matches.length, 1, '当前身份仅应有一个本测试合成受控窗口');
    return matches[0];
  }

  async function humanLoginAndMfa(window) {
    assert.ok(controlledWindows.includes(window), '可信合成输入仅限测试追踪的受控窗口');
    const contents = window.webContents;
    assert.equal(new URL(contents.getURL()).origin, fixture.site.origin);
    assert.ok(['/', '/login'].includes(new URL(contents.getURL()).pathname));
    const preferences = contents.getLastWebPreferences();
    assert.equal(preferences.nodeIntegration, false);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.sandbox, true);
    assert.ok(!preferences.preload, '远程合成站点不得带工作台preload');
    assert.deepEqual(await contents.executeJavaScript('({bridge:typeof window.workbench,node:typeof require})'), { bridge: 'undefined', node: 'undefined' });

    // Fixed fixture-only scripts simulate the human after production browser_handoff.
    // They are never exposed as a renderer/model tool or used against a registered real site.
    await contents.executeJavaScript(`(()=>{
      const form=document.querySelector('#interactive-login');
      if(!form || location.origin!==${JSON.stringify(fixture.site.origin)})throw new Error('MOCK_LOGIN_FORM_REQUIRED');
      form.querySelector('input[name="username"]').value='demo';
      form.querySelector('input[name="password"]').value='interactive123';
      document.querySelector('#login-submit').click();
    })()`, true);
    await until(async () => !contents.isLoadingMainFrame() && new URL(contents.getURL()).pathname === '/mfa'
      && await contents.executeJavaScript("Boolean(document.querySelector('#mfa-submit'))"), '合成登录进入MFA');
    assert.equal(new URL(contents.getURL()).origin, fixture.site.origin);
    await contents.executeJavaScript(`(()=>{
      if(location.origin!==${JSON.stringify(fixture.site.origin)} || location.pathname!=='/mfa')throw new Error('MOCK_MFA_FORM_REQUIRED');
      document.querySelector('input[name="otp"]').value='246810';
      document.querySelector('#mfa-submit').click();
    })()`, true);
    await until(async () => !contents.isLoadingMainFrame() && new URL(contents.getURL()).pathname === '/records'
      && await contents.executeJavaScript("Boolean(document.querySelector('[data-authenticated=\"true\"]'))"), '合成MFA进入记录页');
  }

  async function startFromUi(goal) {
    const previousIds = new Set((await snapshot()).agentTasks.map((task) => task.id));
    await runUi(`document.querySelector('[data-view="workspace"]').click();
      const mode=document.querySelector('#planner-mode');mode.value='mock_browser';mode.dispatchEvent(new Event('change',{bubbles:true}));
      document.querySelector('#task-input').value=${JSON.stringify(goal)};document.querySelector('#task-form').requestSubmit();`);
    await untilUi(`!document.querySelector('#task-plan').hidden && document.querySelector('#task-plan').textContent.includes('确认浏览器任务') && [...document.querySelectorAll('#task-plan button')].some(b=>b.textContent==='确认执行'&&!b.disabled)`, '浏览器授权计划');
    assert.ok(await runUi(`return document.querySelector('#task-plan').textContent.includes('交互式本机合成站点');`));
    await runUi(`[...document.querySelectorAll('#task-plan button')].find(b=>b.textContent==='确认执行').click();`);
    const task = await until(async () => (await snapshot()).agentTasks.find((item) => !previousIds.has(item.id)), 'UI创建浏览器任务');
    assert.equal(task.goal, goal);
    assert.equal(task.mode, 'mock_browser');
    return task;
  }

  async function switchIdentity(userId, initial) {
    await runUi(`const picker=document.querySelector('#identity-select');picker.value=${JSON.stringify(userId)};picker.dispatchEvent(new Event('change',{bubbles:true}));`);
    await untilUi(`document.querySelector('#identity-avatar').textContent===${JSON.stringify(initial)} && !document.querySelector('#identity-select').disabled`, `切换${userId}`);
    assert.equal((await snapshot()).identity.userId, userId);
  }

  try {
    await mkdir(privateDataDir, { recursive: true });
    ui = new BrowserWindow({ show: false, width: 1440, height: 940, webPreferences: {
      preload: join(root, 'src', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
    } });
    controller = await createController({ dataDir: privateDataDir, cryptoAdapter, systems, BrowserWindow: TrackedWindow,
      builtinSites: [fixture.site], browserShow: false,
      onUpdate: (state) => { updates.push(state); if (!ui.isDestroyed()) ui.webContents.send('workbench:update', state); },
    });
    ipcMain.handle('workbench:invoke', async (event, action, payload) => {
      if (event.sender !== ui.webContents || event.senderFrame !== ui.webContents.mainFrame || event.senderFrame.url !== uiUrl) {
        return { ok: false, error: { code: 'IPC_DENIED', message: '请求来源不受信任。' } };
      }
      acceptedActions.push(action);
      try { return { ok: true, data: await controller.invoke(action, payload) }; }
      catch (error) { return { ok: false, error: safeError(error) }; }
    });
    handlerInstalled = true;
    await ui.loadFile(uiPath);
    await untilUi(`document.querySelector('#identity-avatar').textContent==='林' && !document.querySelector('#plan-submit').disabled`, 'UI连接真实控制器');
    assert.equal((await snapshot()).credentials.length, 0, '通用浏览器任务无需采购凭据');
    assert.equal((await snapshot()).agentTasks.length, 0);
    assert.equal((await snapshot()).agentSkills.length, 0);

    const first = await startFromUi('读取2026-09合成记录');
    await taskWithStatus(first.id, 'awaiting_user');
    await untilUi(`document.querySelector('#active-run').textContent.includes('等待你操作') && [...document.querySelectorAll('#active-run button')].some(b=>b.textContent==='继续任务'&&!b.disabled)`, 'UI显示人工登录接管');
    const aliceWindow = fixtureWindow();
    const aliceSession = aliceWindow.webContents.session;
    await capture('agent-task-awaiting-login.png');
    await humanLoginAndMfa(aliceWindow);
    await runUi(`[...document.querySelectorAll('#active-run button')].find(b=>b.textContent==='继续任务').click();`);
    const completed = await taskWithStatus(first.id, 'completed');
    assert.ok(completed.message.includes('SYN-091') && completed.message.includes('9087'), '完成说明必须来自9月实际页面记录');
    assert.ok(await aliceWindow.webContents.executeJavaScript("document.querySelector('tbody').textContent.includes('SYN-091')&&document.querySelector('tbody').textContent.includes('9087')"));
    await untilUi(`document.querySelector('#active-run').textContent.includes('SYN-091') && [...document.querySelectorAll('#active-run button')].some(b=>b.textContent==='保存为浏览器工作流'&&!b.disabled)`, 'UI显示浏览器结果及保存入口');
    assert.equal(await runUi("return document.querySelector('#active-run .steps-disclosure').open;"), false, '执行步骤默认折叠');
    assert.equal(await runUi("return [...document.querySelectorAll('#active-run button')].some(b=>b.textContent==='保存为工作流');"), false, '通用任务不能套用采购保存入口');
    await capture('agent-task-completed.png');

    const skillName = '九月合成记录浏览器流程';
    await runUi(`[...document.querySelectorAll('#active-run button')].find(b=>b.textContent==='保存为浏览器工作流').click();document.querySelector('#workflow-name').value=${JSON.stringify(skillName)};document.querySelector('#workflow-pinned').checked=true;document.querySelector('#save-workflow-form').requestSubmit();`);
    await untilUi(`!document.querySelector('#save-dialog').open && document.querySelector('#quick-workflows').textContent.includes(${JSON.stringify(skillName)})`, 'UI保存并置顶浏览器工作流');
    const skill = (await snapshot()).agentSkills.find((item) => item.name === skillName);
    assert.ok(skill?.pinned && skill.template.recipe.length > 0);
    assert.equal(skill.source.taskId, first.id);
    const beforeReplay = new Set((await snapshot()).agentTasks.map((task) => task.id));
    await runUi(`document.querySelector('[data-view="workspace"]').click();const card=[...document.querySelectorAll('#quick-workflows article')].find(c=>c.querySelector('h3')?.textContent===${JSON.stringify(skillName)});if(!card)throw new Error('AGENT_SKILL_CHIP_REQUIRED');card.querySelector('button').click();`);
    await untilUi(`!document.querySelector('#task-plan').hidden && [...document.querySelectorAll('#task-plan button')].some(b=>b.textContent==='确认执行'&&!b.disabled)`, '快捷浏览器流程授权计划');
    await runUi(`[...document.querySelectorAll('#task-plan button')].find(b=>b.textContent==='确认执行').click();`);
    const repeated = await until(async () => (await snapshot()).agentTasks.find((task) => !beforeReplay.has(task.id)), '首页快捷实际创建新任务');
    const replayed = await taskWithStatus(repeated.id, 'completed');
    assert.equal((await activeTask(repeated.id)).skillId, skill.id);
    assert.ok(await aliceWindow.webContents.executeJavaScript("document.querySelector('tbody').textContent.includes('SYN-091')&&document.querySelector('tbody').textContent.includes('9087')"), '技能重跑必须重新读取实际9月页面');
    await untilUi(`document.querySelector('#active-run').textContent.includes(${JSON.stringify(replayed.message)}) && document.querySelector('#run-count').textContent==='2 个任务' && !document.querySelector('#identity-select').disabled`, 'UI显示本次快捷重跑完成');
    await capture('agent-task-skill-replayed.png');

    // Use the saved successful select step as a parameter, then verify actual Chromium content changes.
    const stepIndex=skill.template.recipe.findIndex(entry=>entry.tool==='select');
    assert.ok(stepIndex>=0);
    const revised=await controller.invoke('agent.skill.edit',{id:skill.id,name:'按月份读取合成记录',expectedVersion:1,parameters:[{name:'month',label:'查询月份',stepIndex,defaultValue:'2026-09'}]});
    assert.equal(revised.version,2);
    const changed=await controller.invoke('agent.skill.run',{id:skill.id,mode:'mock_browser',expectedVersion:2,values:{month:'2026-10'}});
    await taskWithStatus(changed.taskId,'completed');
    assert.ok(await aliceWindow.webContents.executeJavaScript("document.querySelector('tbody').textContent.includes('SYN-101')&&document.querySelector('tbody').textContent.includes('12345')"),'参数必须真正改变页面筛选结果');
    assert.equal((await activeTask(changed.taskId)).parameterValues.month,'2026-10');
    await assert.rejects(controller.invoke('agent.skill.run',{id:skill.id,mode:'mock_browser',expectedVersion:1,values:{month:'2026-09'}}),/AGENT_SKILL_VERSION_CHANGED/);
    console.log('PASS 参数化浏览器Skill：已成功步骤→修订v2→传入10月→实际网页SYN-101/12345分，旧版本确认拒绝。');

    await switchIdentity('bob', '陈');
    let state = await snapshot();
    assert.equal(state.agentTasks.length, 0);
    assert.equal(state.agentSkills.length, 0);
    assert.ok(aliceWindow.isDestroyed(), '切换身份必须销毁Alice的受控浏览器');
    assert.equal(await runUi(`return document.querySelector('#quick-workflows').textContent.includes(${JSON.stringify(skillName)}) || document.querySelector('#history-list').textContent.includes('读取2026-09合成记录');`), false, 'Bob界面不得显示Alice任务或技能');

    const paused = await startFromUi('读取2026-10合成记录');
    await taskWithStatus(paused.id, 'awaiting_user');
    await untilUi(`document.querySelector('#active-run').textContent.includes('等待你操作') && [...document.querySelectorAll('#active-run button')].some(b=>b.textContent==='取消任务'&&!b.disabled)`, 'Bob独立会话等待登录');
    const bobWindow = fixtureWindow();
    assert.notEqual(bobWindow.webContents.session, aliceSession, 'Bob必须使用独立浏览器分区');
    assert.ok(['/', '/login'].includes(new URL(bobWindow.webContents.getURL()).pathname), 'Bob不得继承Alice登录状态');
    await runUi(`[...document.querySelectorAll('#active-run button')].find(b=>b.textContent==='取消任务').click();`);
    await taskWithStatus(paused.id, 'cancelled');
    await controller.waitForIdle();
    await untilUi(`document.querySelector('#active-run').textContent.includes('已取消') && ![...document.querySelectorAll('#active-run button')].some(b=>b.textContent==='继续任务')`, '暂停任务取消后UI不再允许继续');
    assert.equal((await activeTask(paused.id)).status, 'cancelled');
    await capture('agent-task-bob-cancelled.png');
    await switchIdentity('alice', '林');
    state = await snapshot();
    assert.ok(bobWindow.isDestroyed(), '切回身份必须销毁Bob受控浏览器');
    assert.equal(state.agentSkills.length, 1);
    assert.ok(state.agentTasks.some((task) => task.id === first.id) && state.agentTasks.some((task) => task.id === repeated.id));
    assert.ok(!state.agentTasks.some((task) => task.id === paused.id));
    assert.equal(fixture.getWriteCount(), 0, '测试不得产生合成业务写入');
    assert.ok(acceptedActions.includes('agent.start') && acceptedActions.includes('agent.resume') && acceptedActions.includes('agent.skill.save') && acceptedActions.includes('agent.skill.run') && acceptedActions.includes('agent.cancel'), '闭环必须由真实UI桥接执行');
    for (const secret of ['interactive123', '246810', 'hidden-fixture-token', 'visible-token-secret', 'visible-query-secret']) {
      assert.ok(!JSON.stringify(updates).includes(secret), '任务更新不得包含合成密码、验证码或页面令牌');
    }
    assert.equal(await runUi('return document.documentElement.scrollWidth<=innerWidth+2;'), true);
    console.log('PASS 通用浏览器UI：真实计划确认→人工登录/MFA→9月网页核对→保存置顶→首页技能重跑；身份/浏览器隔离、暂停取消及凭据不回传。');
  } catch (error) {
    if (ui && !ui.isDestroyed()) await capture('agent-task-failed.png').catch(() => {});
    throw error;
  } finally {
    if (handlerInstalled) ipcMain.removeHandler('workbench:invoke');
    try { await controller?.close(); }
    finally {
      if (ui && !ui.isDestroyed()) ui.destroy();
      for (const window of controlledWindows) if (!window.isDestroyed()) window.destroy();
      await fixture.close();
    }
  }
}
