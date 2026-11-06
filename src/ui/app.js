const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const SYSTEMS = [
  { id: 'procurement', label: 'Mock 采购订单', description: '采购订单 · 已审核记录', symbol: '▤' },
  { id: 'warehouse', label: 'Mock 仓储入库', description: '仓储入库 · 到货记录', symbol: '▥' },
];
const VIEW_NAMES = { workspace: '新任务', history: '任务历史', workflows: '工作流', accounts: '系统与账号', company: '公司流程', settings: '设置' };
const STATUS = { running: '执行中', awaiting_user: '等待你操作', interrupted: '已中断', completed: '已完成', failed: '未完成', cancelled: '已取消', pending: '等待执行', queued: '等待执行' };
const state = {
  snapshot: { identity: null, credentials: [], workflows: [], runs: [], shared: [] },
  view: 'workspace', filter: 'all', plan: null, actionPending: false, planning: false,
  switching: false, switchTarget: null, activeRunId: null, connected: false,
  expandedSteps: new Set(), request: '', plannerMode: 'preset', modelConsent: false, pageConsent: false, selectedSiteIds: [], agentSitesChosen: false,
  entryPanel: 'choices', authTab: 'register', authPending: false, demoVerificationCode: '', modelTestResult: '', writePreview: null, demonstrationSiteIds: [],
};
let toastTimer;
let confirmCallback;
let unsubscribe;

function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== '') node.textContent = String(text);
  return node;
}

function append(parent, ...children) {
  for (const child of children.flat()) {
    if (child !== null && child !== undefined) parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

function button(text, className, handler, options = {}) {
  const node = element('button', className, text);
  node.type = 'button';
  node.disabled = Boolean(options.disabled);
  if (options.label) node.setAttribute('aria-label', options.label);
  if (options.title) node.title = options.title;
  if (handler) node.addEventListener('click', handler);
  return node;
}

function list(value) { return Array.isArray(value) ? value : []; }
function workflows() { return list(state.snapshot.workflows); }
function agentSkills() { return list(state.snapshot.agentSkills); }
function agentTasks() { return [...list(state.snapshot.agentTasks)].sort((a, b) => runTime(b) - runTime(a)); }
function agentSites() { return list(state.snapshot.agentSites || state.snapshot.sites); }
function browserMode() { return ['mock_browser', 'compatible_browser'].includes(state.plannerMode); }
function taskTitle(task) { return task.kind === 'browser' ? (task.goal || '浏览器任务') : `${monthText(task.month)} · 采购月报资料`; }
function allTasks() { return [...runs(), ...agentTasks().map((task) => ({ ...task, kind: 'browser' }))].sort((a, b) => runTime(b) - runTime(a)); }
function credentials() { return list(state.snapshot.credentials); }
function currentIdentity() { return state.snapshot.identity || {}; }
function product() { return state.snapshot.product || null; }
function productLocked() { return Boolean(product() && !product().authenticated); }
function companyReadOnly() { return Boolean(product() && (product().mode === 'personal' || product().companyWorkflows?.readOnly)); }
function companyWorkflow(workflow) { return workflow.source?.kind === 'company-template' || workflow.importedFrom || workflow.publicationId; }
function sponsoredOpen() {
  const current = product();
  if (!current) return true;
  const monthly = current.limits?.monthlyTokens ?? current.usage?.monthlyTokens;
  const daily = current.limits?.dailyRequests ?? current.usage?.dailyRequests;
  return current.limits?.configured !== false && current.promotionBudget?.configured !== false && Number.isFinite(monthly) && monthly > 0 && Number.isFinite(daily) && daily > 0;
}
function quotaMessage() {
  const current = product();
  if (!current) return '';
  if (!sponsoredOpen()) return '推广额度尚未开放，由开发者配置后启用。可使用自己的 API，不扣开发者额度。';
  if (current.account && !current.account.verified) return '验证邮箱后即可使用推广额度。自己的 API 由提供方计费，不扣开发者额度。';
  const usage = current.usage;
  if (usage && usage.remainingTokens <= 0) return '本月推广额度已用完或已预留，恢复可用额度后可继续；也可切换自己的 API。';
  if (usage && usage.dailyRequestsUsed >= usage.dailyRequests) return '今日推广请求次数已用完，次日恢复后可继续；也可切换自己的 API。';
  return current.deployment === 'local_demo' ? '本机合成演示额度，非推广承诺。' : current.modelSource === 'byok' ? '使用自己的 API 不扣开发者额度；提供方费用由该 API 账号承担。' : '用量以服务实际记录为准，预留额度不代表已产生费用。';
}
function publications() {
  const shared = state.snapshot.shared;
  return Array.isArray(shared) ? shared : list(shared?.publications || shared?.items || shared?.available);
}
function runTime(run) { return Date.parse(run.createdAt || run.startedAt || run.updatedAt || '') || 0; }
function runs() { return [...list(state.snapshot.runs)].sort((a, b) => runTime(b) - runTime(a)); }
function isRunning() { return Boolean(state.snapshot.busy || runs().some((run) => run.status === 'running') || agentTasks().some((task) => ['running', 'awaiting_user'].includes(task.status))); }
function isLocked() { return productLocked() || state.authPending || state.actionPending || state.switching || isRunning(); }
function credentialFor(systemId) { return credentials().find((credential) => credential.systemId === systemId || credential.id === systemId); }
function hasCredentials() { return SYSTEMS.every((system) => { const credential = credentialFor(system.id); return credential && !credential.needsRebind; }); }
function workflowName(workflow) { return workflow?.name || '采购与入库月报资料'; }
function monthText(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value || ''));
  return match ? `${match[1]} 年 ${Number(match[2])} 月` : '未指定月份';
}
function dateText(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '时间未记录';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
function maskAccount(credential) {
  const readyMask = credential?.usernameMasked || credential?.maskedUsername || credential?.usernameMask;
  if (typeof readyMask === 'string' && readyMask.includes('*')) return readyMask;
  if (typeof readyMask === 'string' && readyMask.includes('•')) return readyMask;
  const raw = String(credential?.username || '');
  return raw ? `${raw.slice(0, 1)}${'•'.repeat(Math.max(3, Math.min(raw.length - 1, 7)))}` : '••••';
}
function notice(text = '', error = false) {
  const node = $('#global-notice');
  node.textContent = text;
  node.hidden = !text;
  node.setAttribute('role', error ? 'alert' : 'status');
}
function toast(text, error = false) {
  clearTimeout(toastTimer);
  const node = $('#toast');
  node.textContent = String(text);
  node.classList.toggle('error', error);
  node.hidden = false;
  toastTimer = setTimeout(() => { node.hidden = true; }, 5500);
}

async function invoke(action, payload = {}) {
  if (!window.workbench?.invoke) throw new Error('工作台未连接本机运行器。请从桌面应用启动。');
  const result = await window.workbench.invoke(action, payload);
  if (!result?.ok) throw new Error(result?.error?.message || '操作未完成，请重试。');
  return result.data;
}

function acceptSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  if (state.switching && snapshot.identity?.userId !== state.switchTarget) return;
  if (product()?.authenticated && (!snapshot.product?.authenticated || snapshot.identity?.userId !== currentIdentity().userId)) clearAccountView();
  state.snapshot = snapshot;
  state.connected = true;
  render();
}

function clearAccountView() {
  state.entryPanel = 'choices'; state.demoVerificationCode = ''; state.modelTestResult = ''; state.writePreview = null; state.plan = null; state.activeRunId = null; state.request = ''; state.modelConsent = false; state.pageConsent = false; state.selectedSiteIds = []; state.agentSitesChosen = false; state.demonstrationSiteIds = []; state.expandedSteps.clear();
  for (const selector of ['#task-form', '#credential-form', '#model-profile-form', '#product-auth-form', '#entry-verify-form', '#settings-verify-form', '#save-workflow-form', '#edit-workflow-form', '#write-demo-form', '#agent-edit-form', '#agent-run-form', '#demonstration-form']) $(selector).reset();
  for (const dialog of $$('dialog')) if (dialog.open) dialog.close();
  confirmCallback = undefined;
  $('#toast').hidden = true;
  notice();
}

async function refresh() { acceptSnapshot(await invoke('snapshot')); }

async function mutation(action, payload, successText) {
  if (state.actionPending || state.switching) return false;
  state.actionPending = true;
  render();
  try {
    await invoke(action, payload);
    if (action.startsWith('model.')) { state.modelConsent = false; state.pageConsent = false; state.plan = null; state.modelTestResult = ''; }
    await refresh();
    if (successText) toast(successText);
    return true;
  } catch (error) {
    toast(error.message, true);
    return false;
  } finally {
    state.actionPending = false;
    render();
  }
}

function navigate(view, focus = false) {
  if (!(view in VIEW_NAMES)) return;
  state.view = view;
  $$('.view').forEach((node) => {
    const active = node.id === `view-${view}`;
    node.hidden = !active;
    node.classList.toggle('active', active);
  });
  $$('.nav-item').forEach((node) => {
    const active = node.dataset.view === view;
    node.classList.toggle('active', active);
    if (active) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  });
  $('#view-breadcrumb').textContent = VIEW_NAMES[view];
  $('#composer-dock').hidden = view !== 'workspace';
  if (focus) $('#main-content').focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function statusNode(status) {
  const safeStatus = Object.hasOwn(STATUS, status) ? status : 'pending';
  return append(element('span', `status ${safeStatus}`), element('span', 'dot'), STATUS[safeStatus]);
}

function emptyState(symbol, title, description, action) {
  const node = append(element('div', 'empty-state'), element('span', 'empty-symbol', symbol), element('h3', '', title), element('p', '', description));
  if (action) node.append(action);
  return node;
}

function fillExample() {
  state.plannerMode = 'preset';
  state.modelConsent = false;
  state.pageConsent = false;
  navigate('workspace', true);
  render();
  $('#task-input').value = '帮我整理采购与入库月报资料，按采购单号核对已审核订单，列出待核实记录。';
  $('#task-input').focus();
}

function renderQuickWorkflows() {
  const target = $('#quick-workflows');
  target.replaceChildren();
  const sorted = workflows().filter((workflow) => workflow.enabled !== false && !(companyReadOnly() && companyWorkflow(workflow))).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || (Date.parse(b.updatedAt || b.createdAt || '') || 0) - (Date.parse(a.updatedAt || a.createdAt || '') || 0));
  for (const workflow of sorted.slice(0, 3)) {
    const card = element('article', 'quick-card');
    const top = append(element('div', 'quick-card-top'), element('span', 'flow-icon', '▤'), element('span', 'quick-meta', workflow.pinned ? '⌁ 已置顶' : '↺ 最近保存'));
    append(card, top, element('h3', '', workflowName(workflow)), element('p', '', '采购 + 入库 · 可复用月份参数'), button('运行工作流  ↗', 'card-run', () => openRunDialog(workflow), { disabled: isLocked() }));
    target.append(card);
  }
  for (const skill of agentSkills().sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))).slice(0, 3)) {
    const card = element('article', 'quick-card');
    append(card, element('h3', '', skill.name || '浏览器流程'), button('运行工作流  ↗', 'card-run', () => planAgentSkill(skill), { disabled: isLocked() }));
    target.append(card);
  }
  if (sorted.length < 3) {
    const card = element('article', 'quick-card starter-card');
    append(card, append(element('div', 'quick-card-top'), element('span', 'flow-icon', '▤'), element('span', 'starter-label', '预设演示')),
      element('h3', '', '采购与入库月报资料'), element('p', '', '两处合成站点，一份可追溯资料草稿'), button('用一句话开始  ↗', 'card-run', fillExample, { disabled: isLocked() }));
    target.append(card);
  }
  if (target.children.length < 3) {
    const card = button('', 'quick-card add-card', () => navigate(hasCredentials() ? 'workflows' : 'accounts', true));
    append(card, element('span', 'plus', '+'), element('strong', '', hasCredentials() ? '把好用的方法留在这里' : '先连接两个演示账号'), element('p', '', hasCredentials() ? '完成任务后，即可保存为工作流' : '仅需首次手动录入，下次直接使用'));
    target.append(card);
  }
}

function renderPlan() {
  const target = $('#task-plan');
  target.hidden = !state.plan;
  target.replaceChildren();
  if (!state.plan) return;
  const plan = state.plan;
  if (plan.kind === 'browser') {
    const heading = append(element('div', 'plan-heading'), element('span', 'flow-icon', '▦'), element('h3', '', '确认浏览器任务'), element('span', 'tag', plan.skillId ? '本机只读重放' : plan.mode === 'mock_browser' ? '合成模型 · 本机演示' : '模型 · 所选页面'));
    append(target, heading, element('p', 'plan-request', plan.goal));
    if (plan.skillId) target.append(element('p', 'plan-meta', `浏览器流程 v${plan.skillVersion || 1}${Object.keys(plan.values || {}).length ? ` · ${Object.entries(plan.values).map(([name, value]) => `${name}：${value}`).join('；')}` : ''}`));
    const steps = element('div', 'plan-steps');
    for (const [index, text] of [`访问已授权站点：${plan.siteIds.map((id) => agentSites().find((site) => site.id === id)?.label || id).join('、')}`, '在允许来源与路径内导航、观察并读取页面', '登录、验证码和多因素验证交给你操作', '仅整理可见资料，不提交业务变更'].entries()) steps.append(append(element('div', 'plan-step'), element('span', '', `0${index + 1}`), text));
    target.append(steps);
    const modeText = plan.skillId ? '仅在本机重放已保存步骤，不发送模型，不消耗推广额度' : plan.mode === 'mock_browser' ? '合成模型演示，不向外部发送页面' : '将本条任务文本和所选页面内容发送给已配置模型';
    target.append(append(element('div', 'plan-footer'), element('p', 'plan-meta', modeText), append(element('div'), button('暂不执行', 'button secondary small', () => { state.plan = null; render(); }), button('确认执行', 'button primary small', startRun, { disabled: isLocked() }))));
    return;
  }
  const heading = append(element('div', 'plan-heading'), element('span', 'flow-icon', '≋'), element('h3', '', plan.supported ? '执行前，确认一下计划' : '这个任务暂时无法执行'), element('span', 'tag', plan.mode === 'compatible' ? '模型规划 · 固定配方' : '预设 Mock'));
  append(target, heading, element('p', 'plan-request', plan.message || (plan.supported ? '将使用预设采购与入库流程整理指定月份的资料。' : '当前仅支持预设的采购与入库月报资料整理，尚未接入通用模型。')));
  if (plan.supported) {
    const steps = element('div', 'plan-steps');
    ['登录采购、仓储两个合成站点', `筛选 ${monthText(plan.month)} 的业务记录`, '按采购单号关联，缺失记录列待核实', '生成 CSV 与来源说明到本机'].forEach((text, index) => steps.append(append(element('div', 'plan-step'), element('span', '', `0${index + 1}`), text)));
    target.append(steps);
    const info = element('div', 'plan-meta', `${monthText(plan.month)} · ${plan.workflowId ? '复用个人工作流' : '预设采购月报资料'} · 合成数据`);
    const controls = append(element('div'), button('暂不执行', 'button secondary small', () => { state.plan = null; render(); }), button('确认执行', 'button primary small', startRun, { disabled: isLocked() || !hasCredentials() }));
    target.append(append(element('div', 'plan-footer'), info, controls));
    if (!hasCredentials()) {
      target.append(append(element('p', 'plan-warning'), '首次运行需先连接两个演示账号。 ', button('前往连接 →', 'text-button', () => navigate('accounts', true))));
    }
  } else {
    target.append(button('收起', 'button secondary small', () => { state.plan = null; render(); }));
  }
}

function summaryText(summary) {
  if (typeof summary === 'string') return summary;
  if (!summary || typeof summary !== 'object') return '';
  if (typeof summary.text === 'string') return summary.text;
  const parts = [];
  const approved = summary.approvedOrderCount ?? summary.approvedOrders ?? summary.orderCount;
  const matched = summary.matchedOrderCount ?? summary.matchedCount;
  const missing = summary.pendingVerificationCount ?? summary.unmatchedOrderCount ?? summary.unmatchedCount ?? summary.pendingCount;
  if (typeof approved === 'number') parts.push(`已审核采购单 ${approved} 条`);
  if (typeof matched === 'number') parts.push(`已关联 ${matched} 条`);
  if (typeof missing === 'number') parts.push(`缺少入库 ${missing} 条`);
  if (typeof summary.partialCount === 'number' && summary.partialCount > 0) parts.push(`部分入库 ${summary.partialCount} 条`);
  if (typeof summary.overReceivedCount === 'number' && summary.overReceivedCount > 0) parts.push(`超额入库 ${summary.overReceivedCount} 条`);
  if (Number.isSafeInteger(summary.orderedCents)) parts.push(`采购金额 ¥${(summary.orderedCents / 100).toFixed(2)}`);
  if (Number.isSafeInteger(summary.receivedCents)) parts.push(`入库金额 ¥${(summary.receivedCents / 100).toFixed(2)}`);
  if (Number.isSafeInteger(summary.totalCents)) parts.push(`金额合计 ¥${(summary.totalCents / 100).toFixed(2)}`);
  return parts.join(' · ');
}

function runSources(run) {
  const sources = run.sources || run.summary?.sources || run.artifact?.sources;
  if (Array.isArray(sources)) return sources;
  if (sources && typeof sources === 'object') return Object.values(sources).filter((source) => source && typeof source === 'object');
  return list(run.steps).flatMap((step) => step?.source ? [step.source] : list(step?.sources));
}

function renderRunPanel(run, compact = false) {
  const panel = element('article', 'run-panel');
  const title = `${monthText(run.month)} · 采购与入库月报资料`;
  const heading = append(element('div', 'run-heading'), element('h3', '', title), statusNode(run.status));
  if (run.status === 'running') heading.append(button('取消执行', 'button secondary small', () => mutation('run.cancel', { runId: run.id }, '已请求取消，等待运行器确认。'), { disabled: state.actionPending }));
  append(panel, heading, element('p', 'run-caption', `预设 Mock 流程 · ${dateText(run.createdAt || run.startedAt)}${run.workflowId ? ' · 来自个人工作流' : ''}`));
  const recordedSteps = list(run.steps);
  if (recordedSteps.length) {
    const disclosure = element('details', 'steps-disclosure');
    disclosure.open = state.expandedSteps.has(run.id);
    disclosure.addEventListener('toggle', () => disclosure.open ? state.expandedSteps.add(run.id) : state.expandedSteps.delete(run.id));
    const done = recordedSteps.filter((step) => step?.status === 'completed').length;
    disclosure.append(element('summary', '', `执行步骤 · ${done}/${recordedSteps.length}${run.status === 'running' ? ' · 正在执行' : ''}`));
    const steps = element('div', 'run-steps');
    for (const raw of recordedSteps) {
      const step = typeof raw === 'string' ? { label: raw } : raw || {};
      const status = Object.hasOwn(STATUS, step.status) ? step.status : 'pending';
      const row = element('div', `run-step ${status}`);
      const content = append(element('div'), element('strong', '', step.label || step.title || step.name || step.message || step.id || '运行记录'));
      const detail = step.detail || step.description;
      if (typeof detail === 'string') content.append(element('span', 'run-step-detail', detail));
      append(row, element('span', 'step-marker', status === 'completed' ? '✓' : status === 'failed' ? '!' : ''), content);
      steps.append(row);
    }
    disclosure.append(steps);
    panel.append(disclosure);
  } else if (run.status === 'running') {
    panel.append(element('p', 'muted-text', '运行器已接收任务，等待第一条操作记录。进度将随真实执行更新。'));
  }
  if (run.error) panel.append(element('p', 'run-error', typeof run.error === 'string' ? run.error : run.error.message || '执行未完成，请检查账号与运行记录。'));
  if (run.status === 'cancelled') panel.append(element('p', 'muted-text', '本次任务已取消。未生成的文件不会显示为完成。'));
  if (run.artifact && run.status === 'completed') {
    const artifact = run.artifact;
    const block = element('div', 'artifact-block');
    const head = append(element('div', 'artifact-heading'), element('strong', '', artifact.name || '月报资料 CSV'), button('打开文件 ↗', 'button secondary small', () => openArtifact(run.id), { disabled: state.actionPending }));
    append(block, head);
    const summary = summaryText(run.summary);
    if (summary) block.append(element('p', 'report-summary', summary));
    if (artifact.path) block.append(element('p', 'artifact-path', artifact.path));
    block.append(element('p', 'artifact-path', '合成采购资料草稿 · 非正式财务报表'));
    panel.append(block);
  }
  const sources = runSources(run);
  if (sources.length || run.artifact?.sourcePath) {
    const section = element('div', 'sources');
    const headingNode = append(element('div', 'sources-heading'), element('span', '', '资料来源与执行依据'));
    if (run.artifact?.sourcePath && run.status === 'completed') headingNode.append(button('打开来源说明 ↗', 'text-button', () => openArtifact(run.id, true), { disabled: state.actionPending }));
    section.append(headingNode);
    for (const source of sources) {
      const system = SYSTEMS.find((item) => item.id === source.systemId);
      const detail = [source.url, source.month ? monthText(source.month) : null, source.readAt ? `读取于 ${dateText(source.readAt)}` : null].filter(Boolean).join(' · ');
      section.append(append(element('div', 'source-item'), element('strong', '', system?.label || source.label || '业务站点'), element('span', '', detail || '来源详情见运行器输出')));
    }
    if (run.artifact?.sourcePath) section.append(element('p', 'artifact-path', run.artifact.sourcePath));
    panel.append(section);
  }
  if (run.status === 'completed') {
    const saved = workflows().some((workflow) => workflow.source?.runId === run.id || workflow.sourceRunId === run.id || workflow.runId === run.id);
    const copy = append(element('div'), element('strong', '', saved ? '这个方法已保存在工作流里' : '这次跑通了，下次可以更省心。'), saved ? '到“我的工作流”中复用或调整月份。' : '只保存步骤和参数，账号与结果文件不会被带走。');
    panel.append(append(element('div', 'save-suggestion'), copy, button(saved ? '查看工作流' : '保存为工作流', 'button subtle small', () => saved ? navigate('workflows', true) : openSaveDialog(run), { disabled: state.actionPending })));
  }
  if (compact) panel.setAttribute('aria-label', title);
  return panel;
}

function renderRuns() {
  const allRuns = allTasks();
  $('#run-count').textContent = `${allRuns.length} 个任务`;
  const active = $('#active-run');
  const recent = $('#recent-runs');
  active.replaceChildren();
  recent.replaceChildren();
  $('#history-nav-count').textContent = String(allRuns.length);
  const current = allRuns.find((run) => ['running', 'awaiting_user'].includes(run.status)) || allRuns.find((run) => run.id === state.activeRunId);
  if (current) active.append(current.kind === 'browser' ? renderAgentTask(current) : renderRunPanel(current));
  $('#view-workspace').classList.toggle('has-conversation', Boolean(state.plan || current || state.planning));
  $('#conversation-request').textContent = state.request;
  $('#conversation-request').hidden = !state.request || (!state.plan && !current && !state.planning);
  const history = $('#history-list');
  const sidebar = $('#sidebar-runs');
  history.replaceChildren();
  sidebar.replaceChildren();
  if (!allRuns.length) {
    history.append(emptyState('◷', '还没有任务记录', '完成第一个任务后，执行记录和生成的文件会保存在这里。', button('开始一个任务', 'button secondary', fillExample)));
    sidebar.append(element('p', 'sidebar-empty', '暂无任务'));
  }
  for (const run of allRuns) {
    const record = element('details', 'run-record');
    const summary = append(element('summary'), element('span', 'record-title', taskTitle(run)), element('span', 'record-date', dateText(run.createdAt || run.startedAt)), statusNode(run.status), element('span', 'record-arrow', '›'));
    append(record, summary, run.kind === 'browser' ? renderAgentTask(run) : renderRunPanel(run, true));
    history.append(record);
  }
  for (const run of allRuns.slice(0, 7)) {
    sidebar.append(button(taskTitle(run), 'sidebar-run', () => { state.activeRunId = run.id; state.request = ''; state.plan = null; navigate('workspace', true); render(); }));
  }
}

function renderDemonstration(task) {
  const box = element('section', 'demonstration-panel');
  box.dataset.taskId = task.id;
  const view = state.snapshot.demonstration;
  if (!view || view.taskId !== task.id) return append(box, element('p', 'form-note', '示范记录当前不可操作。请取消后重新开始，不复用上次页面引用。'));
  const locked = state.actionPending || state.authPending || state.switching || productLocked() || view.operationPending;
  const page = view.page;
  const siteId = view.currentSiteId || view.siteIds?.[0];
  const sites = element('select', 'text-input demonstration-site');
  sites.setAttribute('aria-label', '当前示范站点');
  for (const id of list(view.siteIds)) {
    const option = element('option', '', agentSites().find(site => site.id === id)?.label || id);
    option.value = id; option.selected = id === siteId; sites.append(option);
  }
  sites.disabled = locked || view.status === 'awaiting_user';
  const refreshButton = button('打开并观察', 'button secondary small demonstration-observe', () => demonstrationAction('demo.observe', { id: task.id, siteId: sites.value }), { disabled: locked || view.status === 'awaiting_user' });
  append(box, append(element('div', 'demonstration-toolbar'), sites, refreshButton), element('p', 'form-note', '在这里选择允许的查询、筛选操作；每次操作后重新观察。不会记录你在登录窗口中的账号或验证码。'));
  if (view.status === 'awaiting_user') {
    append(box, append(element('div', 'handoff-card'), element('strong', '', '请在独立浏览器中完成登录或验证'), element('p', '', '完成后返回这里继续，工作台将重新观察当前页面。'), button('继续示范', 'button primary small demonstration-resume', () => demonstrationAction('demo.resume', { id: task.id }), { disabled: locked })));
    return box;
  }
  if (page) {
    box.append(element('h4', 'demonstration-page-title', page.title || agentSites().find(site => site.id === siteId)?.label || '当前页面'));
    if (page.loginRequired) box.append(element('p', 'form-note', '当前页面包含登录或验证控件，普通示范操作暂不可用。'));
    else {
      const observation = append(element('details', 'demonstration-observation'), element('summary', '', '查看当前页面文字'));
      observation.append(element('pre', 'observation-content', page.text || '当前页面没有可显示文字。')); box.append(observation);
    }
    const candidates = list(page.elements).filter(item => item && typeof item.ref === 'string' && !item.credential && list(item.actionKinds).some(kind => ['click', 'fill', 'select'].includes(kind)));
    if (!page.loginRequired && candidates.length) {
      const form = element('form', 'demonstration-action-form');
      const label = element('label', 'field-label', '选择当前页面的只读控件');
      const control = element('select', 'text-input demonstration-element'); control.setAttribute('aria-label', '示范操作控件');
      for (const item of candidates) { const option = element('option', '', item.name || item.role || '未命名控件'); option.value = item.ref; control.append(option); }
      const fields = element('div', 'demonstration-action-fields');
      const submit = button('执行并记录', 'button primary small demonstration-act', null, { disabled: locked }); submit.type = 'submit';
      const updateFields = () => {
        fields.replaceChildren();
        const selected = candidates.find(item => item.ref === control.value), kinds = list(selected?.actionKinds).filter(kind => ['click', 'fill', 'select'].includes(kind));
        const kind = element('select', 'text-input demonstration-action-kind'); kind.setAttribute('aria-label', '只读操作类型');
        for (const value of kinds) { const option = element('option', '', { click: '只读点击', fill: '填写查询条件', select: '选择筛选条件' }[value]); option.value = value; kind.append(option); }
        fields.append(kind);
        const valueArea = element('div', 'demonstration-value-area'); fields.append(valueArea);
        const updateValue = () => {
          valueArea.replaceChildren(); if (kind.value === 'click') return;
          valueArea.append(element('label', 'field-label', kind.value === 'select' ? '筛选条件' : '查询内容'));
          const options = list(selected?.options);
          const input = kind.value === 'select' && options.length ? element('select', 'text-input demonstration-value') : element('input', 'text-input demonstration-value');
          input.setAttribute('aria-label', kind.value === 'select' ? '筛选条件' : '查询内容');
          if (input.tagName === 'INPUT') { input.type = 'text'; input.maxLength = 200; input.autocomplete = 'off'; input.placeholder = '仅填写查询条件，不要输入凭据'; }
          else for (const item of options) { const option = element('option', '', item.label || ''); option.value = item.label || ''; input.append(option); }
          input.disabled = locked; valueArea.append(input);
        };
        kind.disabled = locked; kind.addEventListener('change', updateValue); updateValue();
      };
      control.disabled = locked; control.addEventListener('change', updateFields); updateFields();
      form.addEventListener('submit', event => {
        event.preventDefault(); if (locked) return;
        const type = $('.demonstration-action-kind', fields)?.value;
        const action = { type, ref: control.value };
        if (type !== 'click') action.value = $('.demonstration-value', fields)?.value ?? '';
        demonstrationAction('demo.act', { id: task.id, siteId: page.siteId || siteId, action });
      });
      append(form, label, control, fields, append(element('div', 'inline-actions'), submit)); box.append(form);
    } else if (!page.loginRequired) box.append(element('p', 'form-note', '此页面没有已授权的只读操作。可重新观察、切换所选站点，或取消示范。'));
  }
  const actions = element('div', 'demonstration-footer');
  actions.append(button('接管登录或验证', 'text-button demonstration-handoff', () => demonstrationAction('demo.handoff', { id: task.id, siteId }), { disabled: locked }));
  actions.append(button('已核对，完成示范', 'button secondary small demonstration-finish', () => confirmAction('完成这次示范', '请确认已核对当前页面结果。完成后可将已执行的只读步骤保存为个人工作流；不会保存页面正文或凭据。', '确认完成示范', () => demonstrationAction('demo.finish', { id: task.id, confirmed: true }), false), { disabled: locked || !view.canFinish }));
  box.append(actions); if (!view.canFinish) box.append(element('p', 'form-note', '至少执行一次可记录操作并取得最新页面结果后，才能确认完成。'));
  return box;
}

async function demonstrationAction(action, payload) {
  if (state.actionPending || state.switching || productLocked()) return;
  state.actionPending = true; render();
  try { await invoke(action, payload); await refresh(); }
  catch (error) { toast(error.message, true); await refresh().catch(() => {}); }
  finally { state.actionPending = false; render(); }
}

function renderDemonstrationSites() {
  const mode = $('#demonstration-mode').value;
  const available = agentSites().filter(site => mode === 'mock_browser' ? Boolean(site.builtin) : !site.builtin && String(site.origin || '').startsWith('https:'));
  state.demonstrationSiteIds = state.demonstrationSiteIds.filter(id => available.some(site => site.id === id));
  if (!state.demonstrationSiteIds.length && available.length === 1) state.demonstrationSiteIds = [available[0].id];
  const target = $('#demonstration-sites'); target.replaceChildren();
  for (const site of available) {
    const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.value = site.id; checkbox.checked = state.demonstrationSiteIds.includes(site.id);
    checkbox.disabled = !checkbox.checked && state.demonstrationSiteIds.length >= 3;
    checkbox.addEventListener('change', () => { state.demonstrationSiteIds = checkbox.checked ? [...state.demonstrationSiteIds, site.id].slice(0, 3) : state.demonstrationSiteIds.filter(id => id !== site.id); renderDemonstrationSites(); });
    target.append(append(element('label', 'agent-site-choice'), checkbox, append(element('div'), element('strong', '', site.label || site.id), element('p', '', site.origin || ''))));
  }
  $('#demonstration-sites-note').textContent = available.length ? `已选择 ${state.demonstrationSiteIds.length}/3 个站点。只在所选来源和路径内示范。` : '当前没有此范围内的站点，请先到“系统与账号”添加受控 HTTPS 站点。';
  $('#demonstration-start').disabled = state.actionPending || !state.demonstrationSiteIds.length;
}

function openDemonstrationDialog() {
  if (isLocked()) return;
  $('#demonstration-form').reset(); $('#demonstration-goal').value = $('#task-input').value.trim();
  state.demonstrationSiteIds = [];
  if (!agentSites().some(site => site.builtin)) $('#demonstration-mode').value = 'compatible_browser';
  $('#demonstration-start-error').hidden = true; renderDemonstrationSites(); $('#demonstration-dialog').showModal(); $('#demonstration-goal').focus();
}

function renderReplayProgress(task) {
  if (!task.skillId) return null;
  const replay = task.replay;
  const valid = replay && Number.isInteger(replay.stepIndex) && Number.isInteger(replay.total) && replay.total > 0 && replay.total <= 100 && replay.stepIndex >= 0 && replay.stepIndex < replay.total;
  const recoverySteps = list(task.steps).filter(step => /^recovery-\d+-1$/.test(step.id || '') && step.status === 'completed');
  const errorCode = typeof task.error === 'object' ? task.error?.code : '';
  const needsReview = task.status === 'failed' && ['PAGE_STRUCTURE_CHANGED', 'STALE_REFERENCE'].includes(errorCode);
  if (!valid && !recoverySteps.length && !needsReview) return null;
  const box = element('section', 'replay-status'); box.setAttribute('aria-label', '只读工作流进度');
  if (valid) {
    const status = { executing: '正在执行', recovering: '正在刷新引用', completed: '步骤已完成', awaiting_user: '等待登录或验证', failed: '此步已停止' }[replay.state] || '等待检查';
    const tool = { open: '打开站点', observe: '读取当前页面', click: '只读点击', fill: '填写查询条件', select: '选择筛选条件' }[replay.tool] || '只读操作';
    append(box, append(element('div', 'replay-status-heading'), element('strong', '', `只读工作流 · 第 ${replay.stepIndex + 1} / ${replay.total} 步`), element('span', 'tag', status)), element('p', 'replay-step-description', tool));
    const progress = element('progress', 'replay-progress'); progress.max = replay.total;
    progress.value = replay.state === 'completed' ? replay.stepIndex + 1 : replay.stepIndex;
    progress.setAttribute('aria-label', `已完成 ${progress.value} / ${replay.total} 个步骤`); box.append(progress);
    if (replay.state === 'recovering') box.append(element('p', 'replay-recovery-note', '页面引用已变化，正在重新观察并唯一定位当前控件。此步骤最多刷新一次，之前成功的步骤不会在本轮重复。'));
    else if (replay.state === 'failed' && replay.reason === 'STALE_REFERENCE') box.append(element('p', 'replay-recovery-note', '重新观察后引用仍失效，已停止当前步骤。请检查页面后重新运行。'));
  }
  if (recoverySteps.length) box.append(element('p', 'replay-recovered', `本轮有 ${recoverySteps.length} 个步骤重新观察后完成；每个步骤最多刷新一次。`));
  if (needsReview) {
    box.append(element('p', 'replay-review-note', errorCode === 'PAGE_STRUCTURE_CHANGED' ? '当前页面缺少原控件，或有多个同名控件，流程已停止。请核对页面；必要时重新示范并保存流程，再确认参数运行。' : '页面持续变化，有限刷新已停止。请检查当前页面，确认参数后重新运行。'));
    const skill = agentSkills().find(skill => skill.id === task.skillId);
    if (skill) box.append(button('检查并重新运行', 'button secondary small replay-review-run', () => planAgentSkill(skill), { disabled: isLocked() }));
  }
  return box;
}

function renderAgentTask(task) {
  const panel = element('article', 'run-panel browser-task-panel');
  const taught = task.execution === 'demonstration';
  const heading = append(element('div', 'run-heading'), element('h3', '', task.goal || '浏览器任务'), statusNode(task.status));
  if (['running', 'awaiting_user', 'interrupted'].includes(task.status) && !(taught && task.status === 'interrupted')) heading.append(button('取消任务', 'button secondary small', () => mutation(taught ? 'demo.cancel' : 'agent.cancel', { id: task.id }, taught ? '已取消示范。' : '已取消浏览器任务。'), { disabled: state.actionPending }));
  append(panel, heading, element('p', 'run-caption', `${taught ? '人工示范 · 本机记录只读步骤' : task.skillId ? '个人工作流 · 本机只读重放' : task.mode === 'mock_browser' ? '合成模型 · 本机浏览器演示' : '模型浏览器任务'} · ${dateText(task.createdAt)}`));
  if (task.message) panel.append(element('p', 'agent-message', task.message));
  if (task.error) panel.append(element('p', 'run-error', typeof task.error === 'string' ? task.error : task.error.message || '任务未完成。'));
  const replayProgress = renderReplayProgress(task); if (replayProgress) panel.append(replayProgress);
  const steps = list(task.steps);
  if (steps.length) {
    const disclosure = element('details', 'steps-disclosure');
    disclosure.open = state.expandedSteps.has(task.id);
    disclosure.addEventListener('toggle', () => disclosure.open ? state.expandedSteps.add(task.id) : state.expandedSteps.delete(task.id));
    disclosure.append(element('summary', '', `执行步骤 · ${steps.filter((step) => step.status === 'completed').length}/${steps.length}`));
    const rows = element('div', 'run-steps');
    for (const step of steps) rows.append(append(element('div', `run-step ${step.status || 'pending'}`), element('span', 'step-marker', step.status === 'completed' ? '✓' : step.status === 'failed' ? '!' : ''), append(element('div'), element('strong', '', step.label || step.id || '浏览器操作'))));
    disclosure.append(rows);
    panel.append(disclosure);
  }
  if (taught && ['running', 'awaiting_user'].includes(task.status)) panel.append(renderDemonstration(task));
  if (taught && task.status === 'interrupted') panel.append(append(element('div', 'handoff-card'), element('strong', '', '示范已中断'), element('p', '', '重启后不会恢复旧页面引用。原记录会保留，你可以直接重新示范。'), button('重新示范', 'button primary small', () => { $('#task-input').value = task.goal || ''; openDemonstrationDialog(); }, { disabled: isLocked() })));
  if (!taught && ['awaiting_user', 'interrupted'].includes(task.status)) {
    const box = element('div', 'handoff-card');
    append(box, element('strong', '', task.status === 'awaiting_user' ? '需要你在浏览器中操作' : '任务已中断'), element('p', '', task.status === 'awaiting_user' ? '请在独立浏览器窗口完成登录或验证，再点击继续。' : '检查当前页面后，可继续尝试。任务不会自动恢复执行。'));
    if (task.skillId) box.append(element('p', 'form-note', '继续会从头执行已确认的只读步骤，并重新读取当前页面；本次不发送模型。'));
    else if (task.mode === 'compatible_browser') box.append(element('p', 'form-note', '继续会再次按已选择范围发送任务文本和页面内容。'));
    const controls = append(element('div', 'inline-actions'), button('继续任务', 'button primary small', () => resumeAgentTask(task), { disabled: state.actionPending }));
    if (task.awaitingSiteId) controls.append(button('打开浏览器', 'text-button', () => browserAction('browser.handoff', task.awaitingSiteId), { disabled: state.actionPending }));
    box.append(controls);
    panel.append(box);
  }
  if (task.status === 'completed') {
    const saved = agentSkills().some((skill) => skill.sourceTaskId === task.id || skill.taskId === task.id || skill.source?.taskId === task.id);
    const copy = append(element('div'), element('strong', '', saved ? '已保存为浏览器工作流' : '把这次方法保存下来'), '只保存任务说明、授权站点和步骤，不保存页面内容或凭据。');
    panel.append(append(element('div', 'save-suggestion'), copy, button(saved ? '查看工作流' : '保存为浏览器工作流', 'button subtle small', () => saved ? navigate('workflows', true) : openAgentSaveDialog(task), { disabled: state.actionPending })));
  }
  return panel;
}

function workflowCard(workflow) {
  const card = element('article', `workflow-card${workflow.enabled === false ? ' is-disabled' : ''}`);
  const pin = button(workflow.pinned ? '⌁' : '⌁', `pin-button${workflow.pinned ? ' pinned' : ''}`, () => mutation('workflow.pin', { id: workflow.id, pinned: !workflow.pinned }, workflow.pinned ? '已取消置顶。' : '已置顶到工作台。'), { disabled: state.actionPending, label: workflow.pinned ? `取消置顶：${workflowName(workflow)}` : `置顶：${workflowName(workflow)}`, title: workflow.pinned ? '取消置顶' : '置顶到工作台' });
  pin.setAttribute('aria-pressed', String(Boolean(workflow.pinned)));
  const title = append(element('div', 'workflow-card-title'), element('h3', '', workflowName(workflow)), element('p', '', `个人流程 · v${workflow.version || 1}${workflow.createdAt ? ` · ${dateText(workflow.createdAt)} 保存` : ''}`));
  append(card, append(element('div', 'workflow-card-head'), element('span', 'flow-icon', '▤'), title, pin), element('p', 'workflow-description', workflow.description || '登录合成采购与仓储系统，关联已审核订单与入库记录，输出指定月份的资料草稿。'));
  const tags = append(element('div', 'workflow-tags'), element('span', 'tag', 'Mock 采购 + 入库'), element('span', 'tag', `月份 ${workflow.parameters?.month || '运行时选择'}`));
  if (workflow.verified) tags.append(element('span', 'tag verified', '✓ 已验证运行'));
  else tags.append(element('span', 'tag', '待运行验证'));
  if (workflow.enabled === false) tags.append(element('span', 'tag disabled', '已停用'));
  if (workflow.source?.kind === 'company-template' || workflow.importedFrom || workflow.publicationId) tags.append(element('span', 'tag', '公司模板副本'));
  card.append(tags);
  const footer = append(element('div', 'workflow-card-footer'), button('运行流程  ↗', 'button primary small', () => openRunDialog(workflow), { disabled: isLocked() || workflow.enabled === false || (companyReadOnly() && companyWorkflow(workflow)) }), button('编辑', 'text-button', () => openEditWorkflow(workflow), { disabled: isLocked() }), button('版本历史', 'text-button', () => openWorkflowVersions(workflow), { disabled: state.actionPending }), button('发布到公司', 'text-button', () => confirmAction('发布流程模板', `将“${workflowName(workflow)}”的脱敏步骤和参数发布到当前 Mock 公司目录。不会发布账号、业务记录或结果文件。`, '确认发布', () => mutation('workflow.publish', { id: workflow.id }, '模板已发布到当前 Mock 公司目录。'), false), { disabled: state.actionPending || companyReadOnly() || workflow.enabled === false || !workflow.verified }), button(workflow.enabled === false ? '启用' : '停用', 'text-button', () => mutation('workflow.enabled', { id: workflow.id, enabled: workflow.enabled === false, expectedVersion: workflow.version }, workflow.enabled === false ? '流程已启用，请重新运行验证。' : '流程已停用并撤回发布。'), { disabled: isLocked() }), button('删除', 'text-button danger-text', () => confirmAction('删除个人工作流', `删除“${workflowName(workflow)}”？此操作不会删除已生成的本机文件。`, '删除流程', () => mutation('workflow.delete', { id: workflow.id }, '工作流已删除。')), { disabled: isLocked() }));
  card.append(footer);
  return card;
}

function renderWorkflows() {
  const all = workflows();
  const skills = agentSkills();
  $('#workflow-nav-count').textContent = String(all.length + skills.length);
  $('#all-workflow-count').textContent = String(all.length + skills.length);
  $('#pinned-workflow-count').textContent = String([...all, ...skills].filter((workflow) => workflow.pinned).length);
  const target = $('#workflow-list');
  target.replaceChildren();
  const selected = all.filter((workflow) => state.filter !== 'pinned' || workflow.pinned).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  const selectedSkills = skills.filter((skill) => state.filter !== 'pinned' || skill.pinned).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  if (!selected.length && !selectedSkills.length) {
    target.append(emptyState('⌘', state.filter === 'pinned' ? '把常用的流程置顶到这里' : '第一个工作流，从一次成功运行开始', state.filter === 'pinned' ? '点击流程卡片上的置顶按钮，在工作台快捷复用。' : '先整理一份采购与入库月报资料，成功后保存步骤与参数。', state.filter === 'all' ? button('开始一个任务', 'button secondary', fillExample, { disabled: isLocked() }) : null));
  } else selected.forEach((workflow) => target.append(workflowCard(workflow)));
  for (const skill of selectedSkills) {
    const title = append(element('div', 'workflow-card-title'), element('h3', '', skill.name || '浏览器工作流'), element('p', '', `浏览器流程 · v${skill.version || 1} · 授权站点内运行`));
    const pin = button(skill.pinned ? '⌁' : '⌁', `pin-button${skill.pinned ? ' pinned' : ''}`, () => mutation('agent.skill.pin', { id: skill.id, pinned: !skill.pinned }, skill.pinned ? '已取消置顶。' : '已置顶到新任务页。'), { disabled: state.actionPending, label: skill.pinned ? '取消置顶浏览器流程' : '置顶浏览器流程' });
    const card = append(element('article', 'workflow-card'), append(element('div', 'workflow-card-head'), element('span', 'flow-icon', '▦'), title, pin), element('p', 'workflow-description', skill.goalTemplate || skill.template?.goalTemplate || '在授权站点内复用已验证的浏览器步骤。'));
    const bindings = skillSiteIds(skill);
    card.append(append(element('div', 'workflow-tags'), element('span', 'tag', '浏览器流程'), element('span', 'tag', `${bindings.length} 个授权站点`), element('span', 'tag', `${list(skill.template?.parameters).length} 个运行参数`)));
    card.append(append(element('div', 'workflow-card-footer'), button('运行浏览器流程 ↗', 'button primary small', () => planAgentSkill(skill), { disabled: isLocked() }), button('编辑参数', 'text-button', () => openAgentEditDialog(skill), { disabled: isLocked() }), button('删除', 'text-button danger-text', () => confirmAction('删除浏览器工作流', `删除“${skill.name || '浏览器工作流'}”？`, '删除流程', () => mutation('agent.skill.delete', { id: skill.id }, '浏览器工作流已删除。')), { disabled: isLocked() })));
    target.append(card);
  }
}

function renderAccounts() {
  const target = $('#account-list');
  target.replaceChildren();
  for (const system of SYSTEMS) {
    const credential = credentialFor(system.id);
    const row = element('div', 'account-row');
    const name = append(element('div', 'system-name'), element('span', 'flow-icon', system.symbol), append(element('div'), element('strong', '', system.label), element('p', '', system.description)));
    const account = element('span', 'masked-account', credential ? maskAccount(credential) : '尚未录入');
    const status = credential?.needsRebind ? append(element('span', 'status failed'), element('span', 'dot'), '需重新绑定') : credential ? append(element('span', 'status completed'), element('span', 'dot'), '已加密保存') : append(element('span', 'status pending'), element('span', 'dot'), '待连接');
    const actions = append(element('div', 'account-actions'), button(credential?.needsRebind ? '重新连接' : credential ? '更新账号' : '连接账号', 'button secondary small', () => openCredentialDialog(system), { disabled: isLocked() }));
    if (credential) actions.append(button('移除', 'text-button', () => confirmAction('移除本机账号', `移除“${system.label}”的已保存凭据？下次运行需要重新录入。`, '移除账号', () => mutation('credential.delete', { id: credential.id || system.id }, '已移除保存的凭据。')), { disabled: isLocked() }));
    append(row, name, account, status, actions);
    target.append(row);
  }
}

function renderCompany() {
  const all = publications();
  const identity = currentIdentity();
  const readOnly = companyReadOnly();
  $('#company-access-description').textContent = readOnly ? '这里只展示公开的合成流程示例，不包含未授权公司的资料。个人账号可浏览；导入、运行和发布需要企业接入。' : '当前为本机 Mock 公司目录，仅含脱敏模板。真实企业身份与跨电脑共享尚未接入。';
  $('#company-enterprise-access').hidden = !readOnly;
  $('#view-company .page-description').textContent = readOnly ? '浏览流程模板，了解可复用的方法。' : '导入同事发布的方法，使用自己的系统账号运行。';
  $('#company-title .mock-tiny').textContent = readOnly ? '只读' : 'Mock';
  $('#company-name').textContent = readOnly ? '个人版 · 仅浏览' : identity.companyId || 'Mock 公司';
  $('#publication-count').textContent = `${all.length} 个模板`;
  const target = $('#company-list');
  target.replaceChildren();
  if (!all.length) {
    if (readOnly) {
      target.append(emptyState('♧', '公司流程目录', '可查看的示例或授权模板会出现在这里。企业流程使用权限请联系开发者。', button('联系开发者', 'button secondary', showDeveloperContact)));
      return;
    }
    target.append(emptyState('♧', '公司的好方法，会在这里相遇', '发布一个已跑通的个人工作流，同公司 Mock 身份即可导入。其他公司的身份看不到这些模板。', button('查看我的工作流', 'button secondary', () => navigate('workflows', true))));
    return;
  }
  for (const publication of all) {
    const card = element('article', 'workflow-card');
    const author = publication.publisher?.displayName || publication.authorName || publication.authorId || publication.publisherId || '同公司成员';
    const title = append(element('div', 'workflow-card-title'), element('h3', '', publication.name || publication.template?.name || '采购与入库月报模板'), element('p', '', `${author} 发布 · v${publication.version || publication.template?.version || 1}`));
    append(card, append(element('div', 'workflow-card-head'), element('span', 'flow-icon', '♧'), title), element('p', 'workflow-description', readOnly ? publication.description || '示例展示采购与入库资料的关联方法。个人版仅供阅读，不能导入或执行。' : '复用采购与入库关联的步骤与参数。导入后使用自己的系统账号，生成自己的资料文件。'), append(element('div', 'workflow-tags'), element('span', 'tag', readOnly ? '公开合成示例' : '公司内部 Mock'), element('span', 'tag', '仅脱敏模板')));
    const footer = append(element('div', 'workflow-card-footer'), button(readOnly ? '企业接入后可导入' : '导入到我的工作流', 'button primary small', () => mutation('workflow.import', { publicationId: publication.id }, '已导入个人副本，请使用自己的系统账号运行。'), { disabled: readOnly || state.actionPending }));
    if ((publication.publisher?.userId || publication.authorId || publication.publisherId) === identity.userId) footer.append(button('撤回发布', 'text-button danger-text', () => confirmAction('撤回公司模板', '撤回后，此模板将从当前公司目录移除。已导入的个人副本按系统规则保留。', '撤回发布', () => mutation('workflow.revoke', { id: publication.id }, '已撤回公司目录中的模板。')), { disabled: readOnly || state.actionPending }));
    card.append(footer);
    target.append(card);
  }
}

function renderSites() {
  const target = $('#controlled-site-list');
  target.replaceChildren();
  const sites = list(state.snapshot.sites);
  if (!sites.length) {
    target.append(emptyState('▦', '还没有受控站点', '添加明确的 HTTPS 来源和允许路径后，可打开独立窗口手动登录、观察页面。'));
    return;
  }
  for (const site of sites) {
    const info = append(element('div', 'controlled-site-info'), element('strong', '', site.label || site.id), element('p', '', `${site.origin}${site.entryPath || '/'} · ${list(site.paths).length} 个允许路径`));
    const actions = append(element('div', 'controlled-site-actions'),
      button('打开并登录', 'button secondary small', () => browserAction('browser.open', site.id), { disabled: isLocked() }),
      button('观察', 'text-button', () => browserAction('browser.observe', site.id), { disabled: isLocked() }),
      button('接管', 'text-button', () => browserAction('browser.handoff', site.id), { disabled: isLocked() }),
      button('继续', 'text-button', () => browserAction('browser.resume', site.id), { disabled: isLocked() }));
    actions.append(button('编辑','text-button',()=>openSiteDialog(site),{disabled:isLocked()}),button('移除','text-button danger-text',()=>confirmAction('移除受控站点','将关闭该站点的浏览器会话并移除关联的本机凭据。','移除站点',()=>mutation('site.delete',{id:site.id,expectedRevision:site.revision},'站点及关联凭据已移除。')),{disabled:isLocked()}));
    target.append(append(element('div', 'controlled-site-row'), info, actions));
  }
  target.append(button('关闭浏览器窗口', 'text-button', () => browserAction('browser.close'), { disabled: state.actionPending }));
}

function renderModel() {
  const model = state.snapshot.model || {};
  const localReplay = Boolean(state.plan?.skillId || agentTasks().some(task => task.id === state.activeRunId && task.skillId && ['running', 'awaiting_user'].includes(task.status)));
  const ready = model.status === 'ready';
  const labels = { not_configured: '未配置', disabled: '已停用', ready: '已配置', invalid: '配置无效' };
  $('#model-status').textContent = labels[model.status] || '未配置';
  $('#model-status-title').textContent = ready ? (model.model || '兼容接口模型') : product() ? '选择工作模型' : '预设 Mock 规划';
  $('#model-status-description').textContent = ready ? `${model.host || '所选服务'} · 保存配置不代表连接已通过测试。仅在你逐次同意后发送允许范围内的数据。` : product() ? '在下方选择模型来源或添加自己的 API 配置。合成演示可独立使用。' : '可在仓库外的本机文件中配置兼容接口；未配置时使用预设任务识别器。';
  $('#model-config-note').textContent = '密钥来自你指定的本机文件，界面不展示；仅在逐次同意调用时由主进程读取。';
  $('#model-mode-option').disabled = !ready;
  const browserReady = ready && model.dataScope === 'selected_pages';
  $('#browser-model-mode-option').disabled = !browserReady;
  if (!ready && state.plannerMode === 'model') state.plannerMode = 'preset';
  if (!browserReady && state.plannerMode === 'compatible_browser') state.plannerMode = 'preset';
  $('#planner-mode').value = state.plannerMode;
  $('#planner-mode').disabled = isLocked() || state.planning;
  $('#model-consent-row').hidden = localReplay || !['model', 'compatible_browser'].includes(state.plannerMode);
  const destination = model.model ? `“${model.model}”` : '已配置模型';
  $('#model-consent-description').textContent = state.plannerMode === 'compatible_browser' ? `同意将本条任务文本发送给${destination}。` : `同意将本条任务文本及公开配方定义发送给${destination}。`;
  $('#model-consent').checked = state.modelConsent;
  $('#page-consent-row').hidden = localReplay || state.plannerMode !== 'compatible_browser';
  $('#page-consent').checked = state.pageConsent;
  $('#choose-agent-sites').hidden = !browserMode();
  $('#choose-agent-sites').textContent = `站点 ${state.selectedSiteIds.length}/3`;
  $('#choose-agent-sites').disabled = isLocked();
  $('#task-month-control').hidden = browserMode();
  $('#task-month').required = !browserMode();
  $('#runtime-mode').textContent = { model: '模型采购规划', preset: '预设流程', mock_browser: '合成模型 · 浏览器', compatible_browser: '模型浏览器任务' }[state.plannerMode];
  $('#composer-hint').textContent = state.plannerMode === 'mock_browser' ? '合成模型只用于本机交互演示，不向外部发送页面。' : state.plannerMode === 'compatible_browser' ? '仅在所选站点内只读操作。登录和验证由你接管。' : '执行前会展示计划，由你确认。';
  if (product()?.modelSource === 'sponsored' && ['model', 'compatible_browser'].includes(state.plannerMode)) $('#composer-hint').textContent += ` ${quotaMessage()}`;
  if (localReplay) { $('#runtime-mode').textContent = '本机只读重放'; $('#composer-hint').textContent = '按已确认的站点、流程版本和参数重放，不发送模型，不消耗推广额度。'; }
  $('#model-configure').disabled = state.actionPending;
  $('#model-refresh').disabled = state.actionPending;
}

function amount(value) {
  return Number.isFinite(value) ? new Intl.NumberFormat('zh-CN').format(value) : '—';
}

function showDeveloperContact() { $('#developer-contact-dialog').showModal(); }

function renderProduct() {
  const current = product();
  const locked = productLocked();
  document.body.classList.toggle('product-locked', locked);
  $('#product-entry').hidden = !locked;
  $('#product-account-settings').hidden = !current;
  $('#product-account-button').hidden = !current;
  $('.identity-picker').hidden = Boolean(current);
  $('.app-shell').inert = locked;
  $('.environment-pill').textContent = current ? (current.deployment === 'local_demo' ? '本机合成账户' : current.mode === 'enterprise' ? '企业版' : '个人版') : 'Mock 身份';
  if (!current) return;
  const local = current.deployment === 'local_demo';
  const account = current.account || {};
  const name = account.displayName || account.email || '个人账号';
  $('#product-account-button').textContent = name;
  $('#product-account-button').disabled = state.authPending;
  $('.nav-item[data-view="company"] .mock-tiny').textContent = '只读';
  $('.private-note .mock-tiny').textContent = local ? '合成演示' : '个人';
  $('#settings-environment-title').textContent = local ? '本机合成演示' : '个人注册账号';
  $('#settings-environment-description').textContent = local ? '当前为本机注册服务。业务站点、校验码和模型响应均为隔离合成数据。' : '注册身份与本机系统账号分别管理。业务系统权限始终由该系统决定。';
  $('#product-account-name').textContent = name;
  $('#product-account-email').textContent = account.email || '';
  $('#product-account-status').textContent = account.verified ? '已验证' : '待验证';
  $('#entry-environment').textContent = local ? '本机合成演示' : current.deployment === 'configured' ? '个人服务' : '服务待配置';
  $('#entry-deployment-note').textContent = local ? '当前注册、邮箱验证和额度均为本机合成演示，不代表云端账号或真实云端配额。' : current.deployment === 'unconfigured' ? '开发者尚未配置注册服务；入口不会代替真实服务创建云端账号。' : '使用前请确认任务和页面的发送范围。';
  $('#entry-personal-description').textContent = sponsoredOpen() ? `注册后免费使用，每日 ${amount(current.limits?.dailyRequests ?? current.usage?.dailyRequests)} 次模型请求、每月 ${amount(current.limits?.monthlyTokens ?? current.usage?.monthlyTokens)} tokens；也可接入自己的 API。` : '注册个人账号，管理工作流并接入自己的 API。推广额度开放后可免费领取。';
  $('#entry-choices').hidden = state.entryPanel !== 'choices';
  $('#entry-auth-panel').hidden = state.entryPanel !== 'auth';
  $('#entry-verify-panel').hidden = state.entryPanel !== 'verify';
  $('#entry-enterprise-panel').hidden = state.entryPanel !== 'enterprise';
  $('#entry-auth-title').textContent = state.authTab === 'register' ? '创建个人账号' : '登录个人账号';
  $('#auth-name-field').hidden = state.authTab !== 'register';
  $('#auth-name').required = state.authTab === 'register';
  $('#auth-password').autocomplete = state.authTab === 'register' ? 'new-password' : 'current-password';
  $('#auth-submit').textContent = state.authPending ? '正在处理…' : state.authTab === 'register' ? '免费注册' : '登录';
  $('#auth-submit').disabled = state.authPending || !state.connected;
  $('#entry-verify-submit').disabled = state.authPending;
  $('#settings-verify-submit').disabled = state.authPending;
  $('#auth-logout').disabled = state.authPending || state.actionPending;
  $$('[data-auth-tab]').forEach((node) => { node.classList.toggle('selected', node.dataset.authTab === state.authTab); node.disabled = state.authPending; });
  const demoCode = local && state.demoVerificationCode ? `合成校验码：${state.demoVerificationCode}（仅本机演示，没有发送邮件）` : '';
  for (const selector of ['#entry-demo-code', '#settings-demo-code']) { $(selector).textContent = demoCode; $(selector).hidden = !demoCode; }
  $('#entry-verify-description').textContent = local ? '在本机合成演示中输入下方校验码。' : '请输入注册服务提供的邮箱校验码。';
  $('#settings-verify-form').hidden = !current.authenticated || Boolean(account.verified);
  const contact = current.developer?.contact;
  $$('.developer-name').forEach((node) => { node.textContent = current.developer?.name || '开发者'; });
  $$('.developer-contact-value').forEach((node) => { node.textContent = typeof contact === 'string' && contact.trim() ? `微信号：${contact}` : '开发者微信号待配置'; });
  $$('.developer-contact-note').forEach((node) => { node.hidden = !(typeof contact === 'string' && contact.trim()); });
  $$('[data-copy-developer]').forEach((node) => { node.disabled = !contact || state.actionPending; });
  const usage = current.usage;
  const usageNode = $('#product-usage');
  usageNode.replaceChildren();
  if (usage) {
    for (const [label, value, detail] of [
      ['本月剩余', amount(usage.remainingTokens), `总额度 ${amount(usage.monthlyTokens)} tokens`],
      ['本月已用', amount(usage.usedTokens), `已预留 ${amount(usage.reservedTokens)} tokens`],
      ['今日请求', `${amount(usage.dailyRequestsUsed)} / ${amount(usage.dailyRequests)}`, usage.month || '当前计费周期'],
    ]) usageNode.append(append(element('div', 'usage-item'), element('span', '', label), element('strong', '', value), element('p', '', detail)));
  } else usageNode.append(element('p', 'muted-text', '额度状态暂不可用。'));
  $('#product-usage-note').textContent = quotaMessage();
  $('#product-usage-note').classList.toggle('quota-exhausted', Boolean(usage && sponsoredOpen() && (usage.remainingTokens <= 0 || usage.dailyRequestsUsed >= usage.dailyRequests)));
}

function renderWriteDemo() {
  const current = state.snapshot.writeDemo;
  $('#write-demo-settings').hidden = !current || productLocked();
  const target = $('#write-demo-records');
  target.replaceChildren();
  if (!current) return;
  $('#write-demo-preview').disabled = isLocked();
  $('#write-demo-month').disabled = isLocked();
  $('#write-demo-note').disabled = isLocked();
  const labels = { awaiting_confirmation: '待确认', executing: '回执待核对', receipt_unknown: '回执待核对', completed: '已写入合成源' };
  for (const approval of list(current.approvals).slice(0, 5)) {
    const content = append(element('div', 'write-demo-record-info'), element('strong', '', `${approval.payload?.month || ''} · ${labels[approval.status] || '待核对'}`), element('p', '', approval.payload?.note || ''), element('p', 'muted-text', approval.receipt?.receiptId ? `回执：${approval.receipt.receiptId}` : `预览有效期至 ${dateText(new Date(approval.expiresAt).toISOString())}`));
    const row = append(element('div', 'write-demo-record'), content);
    if (['receipt_unknown', 'executing'].includes(approval.status)) row.append(button('核对回执', 'button secondary small', () => mutation('write.demo.inspect', { id: approval.id }, '已核对合成源回执。回执未知时不会再次提交。'), { disabled: isLocked() }));
    target.append(row);
  }
  if (!target.children.length) target.append(element('p', 'form-note', '还没有提交记录。生成预览不会修改合成源。'));
  $('#write-demo-count').textContent = `${list(current.records).length} 条合成草稿`;
}

function renderModelProfiles() {
  const catalog = state.snapshot.modelProfiles;
  const current = product();
  $('#model-source-settings').hidden = !current;
  $('#model-profiles-settings').hidden = !catalog;
  $('#model-local-config').hidden = Boolean(catalog);
  if (current) {
    $('#model-source-select').value = current.modelSource || 'sponsored';
    $('#model-source-select').disabled = isLocked();
    $('#model-source-select option[value="sponsored"]').textContent = sponsoredOpen() ? (current.deployment === 'local_demo' ? '合成演示额度模型' : '推广额度模型') : '推广额度模型（尚未开放）';
    $('#model-source-select option[value="sponsored"]').disabled = !sponsoredOpen();
    $('#model-source-description').textContent = current.modelSource === 'byok' ? '使用本人的 API；需要注册，不扣开发者额度。' : !sponsoredOpen() ? '推广额度尚未开放，由开发者配置后启用。' : current.deployment === 'local_demo' ? '本机合成演示额度，非推广承诺。' : '使用开发者提供的模型，受账号可用额度限制。';
    const select = $('#sponsored-model-select');
    select.replaceChildren();
    for (const model of list(current.models)) { const option = element('option', '', model.label || model.id); option.value = model.id; select.append(option); }
    if (!select.children.length) { const option = element('option', '', '开发者尚未提供可用模型'); option.value = ''; select.append(option); }
    select.value = current.sponsoredModelId || select.firstElementChild?.value || '';
    select.disabled = isLocked() || !sponsoredOpen() || !list(current.models).length;
    $('#sponsored-model-row').hidden = current.modelSource !== 'sponsored';
  }
  if (!catalog) return;
  const target = $('#model-profile-list');
  target.replaceChildren();
  for (const profile of list(catalog.profiles)) {
    const provider = list(catalog.providers).find((item) => item.id === profile.provider);
    const info = append(element('div', 'model-profile-info'), element('strong', '', profile.label || profile.model), element('p', '', `${provider?.label || profile.provider} · ${profile.model} · ${profile.dataScope === 'selected_pages' ? '所选页面' : '仅任务文本'}`), element('p', '', profile.baseUrl || ''));
    const active = profile.id === catalog.activeId;
    const controls = append(element('div', 'model-profile-actions'), element('span', 'tag', profile.configured ? (active ? '当前 API' : '已配置') : '待配置'), button(active ? '已选中' : '设为当前 API', 'button secondary small', () => mutation('model.profile.select', { id: profile.id }, '已选择当前 API 配置。保存和切换不会自动调用模型。'), { disabled: active || isLocked() }), button('编辑', 'text-button', () => openModelProfile(profile), { disabled: isLocked() }), button('删除', 'text-button danger-text', () => confirmAction('删除模型配置', `删除“${profile.label || profile.model}”及其本机保存的密钥？`, '删除配置', () => mutation('model.profile.delete', { id: profile.id }, '模型配置已删除。')), { disabled: isLocked() }));
    target.append(append(element('div', 'model-profile-row'), info, controls));
  }
  if (!target.children.length) target.append(emptyState('⌘', '添加本人的模型 API', '选择提供方、接口地址与模型。密钥使用操作系统加密，仅在本机保存，不会显示在列表里。'));
  $('#new-model-profile').disabled = isLocked();
  $('#model-test').disabled = isLocked() || state.snapshot.model?.status !== 'ready';
  $('#model-test-result').textContent = state.modelTestResult;
}

function providerHelp() {
  const provider = list(state.snapshot.modelProfiles?.providers).find((item) => item.id === $('#model-profile-provider').value);
  $('#model-profile-provider-help').textContent = provider?.docUrl ? `提供方文档：${provider.docUrl}` : '填写该提供方支持的兼容接口地址与模型名称。';
  const form = $('#model-profile-form');
  const reentry = !$('#model-profile-id').value || form.dataset.provider !== $('#model-profile-provider').value || form.dataset.baseUrl !== $('#model-profile-base-url').value.trim().replace(/\/$/, '');
  $('#model-profile-api-key').required = reentry;
  $('#model-profile-key-note').textContent = reentry ? '新增配置或变更提供方、接口地址时需要重新输入密钥。提交后立即清空。' : '留空可保留原密钥。页面内容外发仍需每次分别同意。';
}

function openModelProfile(profile) {
  if (isLocked()) return;
  $('#model-profile-form').reset();
  $('#model-profile-id').value = profile?.id || '';
  $('#model-profile-revision').value = profile?.revision || '';
  $('#model-profile-form').dataset.provider = profile?.provider || '';
  $('#model-profile-form').dataset.baseUrl = profile?.baseUrl || '';
  $('#model-profile-dialog-title').textContent = profile ? '编辑模型配置' : '添加模型配置';
  $('#model-profile-label').value = profile?.label || '';
  const providers = $('#model-profile-provider');
  providers.replaceChildren();
  for (const provider of list(state.snapshot.modelProfiles?.providers)) { const option = element('option', '', provider.label || provider.id); option.value = provider.id; providers.append(option); }
  if (profile?.provider && ![...providers.options].some((option) => option.value === profile.provider)) { const option = element('option', '', profile.provider); option.value = profile.provider; providers.append(option); }
  providers.value = profile?.provider || providers.firstElementChild?.value || '';
  const provider = list(state.snapshot.modelProfiles?.providers).find((item) => item.id === providers.value);
  $('#model-profile-base-url').value = profile?.baseUrl || provider?.baseUrl || '';
  $('#model-profile-model').value = profile?.model || '';
  $('#model-profile-scope').value = profile?.dataScope || 'task_text';
  $('#model-profile-api-key').value = '';
  $('#model-profile-error').hidden = true;
  providerHelp();
  $('#model-profile-dialog').showModal();
  $('#model-profile-label').focus();
}

async function authenticate(action, payload, errorSelector) {
  if (state.authPending || state.actionPending) { if (payload.password) payload.password = ''; return; }
  state.authPending = true;
  $(errorSelector).hidden = true;
  renderProduct();
  try {
    const result = await invoke(action, payload);
    if (payload.password) payload.password = '';
    if (action === 'auth.register') state.entryPanel = 'verify';
    if (action === 'auth.logout') clearAccountView();
    await refresh();
    if (product()?.deployment === 'local_demo' && result?.demoVerificationCode) state.demoVerificationCode = String(result.demoVerificationCode);
    if (action === 'auth.verify') state.demoVerificationCode = '';
    if (product()?.authenticated) navigate(product().account?.verified ? 'workspace' : 'settings');
    if (action === 'auth.verify') toast('邮箱验证已完成。');
  } catch (error) { $(errorSelector).textContent = error.message; $(errorSelector).hidden = false; if (action === 'auth.logout') toast(error.message, true); }
  finally { if (payload.password) payload.password = ''; state.authPending = false; render(); }
}

function skillSiteIds(skill) {
  const bindings = skill.siteBindings || skill.template?.siteBindings;
  if (Array.isArray(bindings)) return bindings.map((site) => typeof site === 'string' ? site : site.siteId || site.id).filter(Boolean);
  if (bindings && typeof bindings === 'object') return Object.values(bindings).map((site) => typeof site === 'string' ? site : site?.siteId || site?.id).filter(Boolean);
  return list(skill.siteIds);
}

function agentConsent(mode) {
  return mode === 'mock_browser' ? { taskText: true, pageContent: true } : { taskText: state.modelConsent, pageContent: state.pageConsent };
}

function selectDefaultAgentSites() {
  const sites = agentSites();
  const available = new Set(sites.map((site) => site.id));
  state.selectedSiteIds = state.selectedSiteIds.filter((id) => available.has(id));
  if (!state.agentSitesChosen && !state.selectedSiteIds.length && state.plannerMode === 'mock_browser') state.selectedSiteIds = sites.filter((site) => site.builtin || site.builtIn || site.mock || site.kind === 'mock').slice(0, 3).map((site) => site.id);
}

function renderAgentSiteChoices() {
  selectDefaultAgentSites();
  const target = $('#agent-sites-list');
  target.replaceChildren();
  for (const site of agentSites()) {
    const checkbox = element('input');
    checkbox.type = 'checkbox';
    checkbox.value = site.id;
    checkbox.checked = state.selectedSiteIds.includes(site.id);
    checkbox.disabled = !checkbox.checked && state.selectedSiteIds.length >= 3;
    checkbox.addEventListener('change', () => {
      state.agentSitesChosen = true;
      state.selectedSiteIds = checkbox.checked ? [...state.selectedSiteIds, site.id].slice(0, 3) : state.selectedSiteIds.filter((id) => id !== site.id);
      renderAgentSiteChoices();
      renderModel();
    });
    target.append(append(element('label', 'agent-site-choice'), checkbox, append(element('div'), element('strong', '', site.label || site.id), element('p', '', `${site.origin || ''}${site.entryPath || ''}`))));
  }
  if (!target.children.length) target.append(element('p', 'muted-text', '尚无可用站点，请先到系统与账号添加。'));
  $('#agent-sites-hint').textContent = `已选择 ${state.selectedSiteIds.length}/3 个站点。`;
}

function planAgentSkill(skill, values) {
  if (isLocked()) return;
  const parameters = list(skill.template?.parameters);
  if (parameters.length && values === undefined) { openAgentRunDialog(skill); return; }
  state.selectedSiteIds = skillSiteIds(skill).slice(0, 3);
  const registered = agentSites().filter((site) => state.selectedSiteIds.includes(site.id));
  const bindings = list(skill.siteBindings || skill.template?.siteBindings);
  const mode = [...registered, ...bindings].some((site) => String(site.origin || '').startsWith('https:')) ? 'compatible_browser' : 'mock_browser';
  state.modelConsent = false;
  state.pageConsent = false;
  if (!state.selectedSiteIds.length) { toast('这个流程没有有效站点绑定，请重新选择站点。', true); navigate('settings', true); return; }
  const goal = skill.goalTemplate || skill.template?.goalTemplate || skill.name || '复用浏览器工作流';
  state.request = goal;
  state.plan = { kind: 'browser', supported: true, goal, mode, siteIds: [...state.selectedSiteIds], skillId: skill.id, skillVersion: skill.version || 1, values: values || {} };
  navigate('workspace');
  render();
}

function openAgentEditDialog(skill) {
  if (isLocked()) return;
  $('#agent-edit-form').reset();
  $('#agent-edit-form').dataset.skillId = skill.id;
  $('#agent-edit-form').dataset.version = skill.version || 1;
  $('#agent-edit-name').value = skill.name || '';
  $('#agent-edit-error').hidden = true;
  const target = $('#agent-parameter-editor'); target.replaceChildren();
  const recipe = list(skill.template?.recipe), definitions = list(skill.template?.parameters);
  for (const [index, step] of recipe.entries()) {
    if (!['fill', 'select'].includes(step.tool)) continue;
    const definition = definitions.find((item) => item.stepIndex === index);
    const row = element('div', 'agent-parameter-row'); row.dataset.stepIndex = index;
    const enabled = element('input'); enabled.type = 'checkbox'; enabled.checked = Boolean(definition); enabled.className = 'agent-parameter-enabled';
    row.append(append(element('label', 'checkbox-label'), enabled, `步骤 ${index + 1} · ${step.locator?.name || '只读筛选'}`));
    const fields = element('div', 'agent-parameter-fields');
    for (const [key, label, value, max] of [['name', '参数标识', definition?.name || `query_${index + 1}`, 32], ['label', '显示名称', definition?.label || step.locator?.name || '查询条件', 80], ['defaultValue', '默认值', definition?.defaultValue ?? step.value ?? '', 200]]) {
      const input = element('input', 'text-input'); input.id = `agent-param-${index}-${key}`; input.dataset.parameterField = key; input.value = value; input.maxLength = max; input.required = key !== 'defaultValue';
      if (key === 'name') { input.pattern = '[a-z][a-z0-9_]{0,31}'; input.title = '小写英文字母开头，可含小写字母、数字和下划线'; }
      const labelNode = element('label', 'field-label', label); labelNode.htmlFor = input.id;
      fields.append(append(element('div'), labelNode, input));
    }
    const update = () => { for (const input of $$('input', fields)) input.disabled = !enabled.checked; fields.hidden = !enabled.checked; };
    enabled.addEventListener('change', update); update(); row.append(fields); target.append(row);
  }
  if (!target.children.length) target.append(element('p', 'form-note', '此流程没有可参数化的输入或选择步骤；可修改名称。'));
  $('#agent-edit-dialog').showModal();
}

function openAgentRunDialog(skill) {
  const form = $('#agent-run-form'); form.reset(); form.dataset.skillId = skill.id; form.dataset.version = skill.version || 1;
  $('#agent-run-name').textContent = `${skill.name} · v${skill.version || 1}`;
  const target = $('#agent-run-fields'); target.replaceChildren();
  for (const [index, parameter] of list(skill.template?.parameters).entries()) {
    const input = element('input', 'text-input'); input.id = `agent-run-param-${index}`; input.dataset.parameterName = parameter.name; input.value = parameter.defaultValue ?? ''; input.maxLength = 200;
    const label = element('label', 'field-label', parameter.label || parameter.name); label.htmlFor = input.id;
    target.append(label, input);
  }
  $('#agent-run-dialog').showModal();
}

function openAgentSaveDialog(task) {
  $('#save-workflow-form').reset();
  $('#save-dialog').dataset.taskKind = 'browser';
  $('#save-dialog-title').textContent = '保存为浏览器工作流';
  $('#save-dialog .modal-description').textContent = '保留本次任务说明、授权站点和已完成的操作步骤。';
  $('#save-run-id').value = task.id;
  $('#workflow-name').value = (task.goal || '浏览器资料整理').slice(0, 60);
  $('#workflow-pinned').checked = true;
  $('#save-error').hidden = true;
  $('#save-dialog').showModal();
  $('#workflow-name').select();
}

async function resumeAgentTask(task) {
  if (state.actionPending) return;
  if (!task.skillId && task.mode === 'compatible_browser' && (!state.modelConsent || !state.pageConsent)) {
    state.plannerMode = 'compatible_browser';
    navigate('workspace');
    render();
    toast('请在输入框下确认本条任务文本和所选页面内容的发送范围，再继续任务。', true);
    return;
  }
  state.activeRunId = task.id;
  await mutation('agent.resume', { id: task.id, ...(!task.skillId ? { consent: agentConsent(task.mode) } : {}) }, task.skillId ? '已从头重放已确认的只读步骤。' : '已继续浏览器任务。');
}

async function browserAction(action, siteId) {
  if (state.actionPending || state.switching) return;
  state.actionPending = true;
  render();
  try {
    const data = await invoke(action, siteId ? { siteId } : {});
    if (action === 'browser.observe') {
      $('#site-observation-content').textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      $('#site-observation-dialog').showModal();
    } else toast(action === 'browser.close' ? '浏览器窗口已关闭。' : action === 'browser.handoff' ? '已交给你操作，请在浏览器中完成登录或验证。' : action === 'browser.resume' ? '已恢复受控浏览。' : '已打开独立浏览器窗口，请手动登录。');
    await refresh();
  } catch (error) { toast(error.message, true); }
  finally { state.actionPending = false; render(); }
}

function openEditWorkflow(workflow) {
  if (isLocked()) return;
  $('#edit-workflow-id').value = workflow.id;
  $('#edit-workflow-version').value = String(workflow.version);
  $('#edit-workflow-name').value = workflowName(workflow);
  $('#edit-workflow-description').value = workflow.description || '';
  $('#edit-workflow-month').value = workflow.parameters?.month || '2026-10';
  $('#edit-workflow-error').hidden = true;
  $('#edit-workflow-dialog').showModal();
}

async function openWorkflowVersions(workflow) {
  if (state.actionPending) return;
  try {
    const versions = await invoke('workflow.versions', { id: workflow.id });
    const target = $('#workflow-versions-list');
    target.replaceChildren();
    $('#workflow-versions-caption').textContent = `${workflowName(workflow)} · 当前 v${workflow.version}。恢复会创建新版本，保留当前启用状态，并需要重新验证。`;
    for (const version of list(versions)) {
      const current = version.version === workflow.version;
      const info = append(element('div'), element('strong', '', `v${version.version} · ${version.name || workflowName(workflow)}${current ? ' · 当前' : ''}`), element('p', '', `${monthText(version.parameters?.month)} · ${dateText(version.createdAt)}${version.enabled === false ? ' · 已停用' : ''}`));
      if (version.description) info.append(element('p', '', version.description));
      target.append(append(element('div', 'version-row'), info, button(current ? '当前版本' : '恢复此版本', 'button secondary small', () => {
        $('#workflow-versions-dialog').close();
        confirmAction('恢复工作流版本', `将“${workflowName(workflow)}”恢复到 v${version.version} 的名称、说明和默认月份？恢复后创建新版本，并撤回当前发布。`, '恢复版本', () => mutation('workflow.restore', { id: workflow.id, version: version.version, expectedVersion: workflow.version }, '已恢复为新版本，请重新运行验证。'), false);
      }, { disabled: current || isLocked() })));
    }
    if (!target.children.length) target.append(element('p', 'muted-text', '尚无版本记录。'));
    $('#workflow-versions-dialog').showModal();
  } catch (error) { toast(error.message, true); }
}

function setTheme(theme) {
  const selected = ['system', 'light', 'dark'].includes(theme) ? theme : 'system';
  if (selected === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = selected;
  $('#theme-select').value = selected;
  $('#theme-cycle').title = `外观：${{ system: '跟随系统', light: '浅色', dark: '深色' }[selected]}`;
  try { localStorage.setItem('yuanyu-theme', selected); } catch { /* The appearance preference is optional. */ }
}
function openSiteDialog(site) {
  if(isLocked())return;$('#site-form').reset();$('#site-form').dataset.siteId=site?.id||'';$('#site-form').dataset.revision=String(site?.revision||'');
  $('#site-dialog-title').textContent=site?'编辑受控站点':'添加受控站点';$('#site-label').value=site?.label||'';$('#site-url').value=site?site.origin+site.entryPath:'';$('#site-paths').value=site?site.paths.join('\n'):'/\n/login';$('#site-error').hidden=true;$('#site-dialog').showModal();
}

function newTask() {
  state.plan = null;
  state.activeRunId = null;
  state.request = '';
  state.modelConsent = false;
  state.pageConsent = false;
  $('#task-input').value = '';
  navigate('workspace', true);
  render();
  $('#task-input').focus();
}

function render() {
  document.body.classList.toggle('booting', !state.connected);
  const identity = currentIdentity();
  const userId = identity.userId || 'alice';
  if (!state.switching) $('#identity-select').value = userId;
  $('#identity-avatar').textContent = (identity.displayName || userId).slice(0, 1).toUpperCase();
  $('#identity-select').disabled = state.switching || state.actionPending;
  $('#plan-submit').disabled = !state.connected || isLocked() || state.planning;
  $('#plan-submit').firstElementChild.textContent = state.planning ? '生成中…' : isRunning() ? '正在执行' : '生成计划';
  $('#task-input').disabled = state.switching || isRunning();
  $('#task-month').disabled = state.switching || isRunning();
  $('#try-example').disabled = isLocked();
  $('#demonstration-open').disabled = !state.connected || isLocked();
  $('#new-workflow').disabled = isLocked();
  renderQuickWorkflows();
  renderPlan();
  renderRuns();
  renderWorkflows();
  renderAccounts();
  renderCompany();
  renderSites();
  renderModel();
  renderProduct();
  renderModelProfiles();
  renderWriteDemo();
}

async function generatePlan(text, month, workflowId) {
  if (isLocked() || state.planning) return;
  if (!text.trim()) { $('#task-input').focus(); return; }
  if (browserMode()) {
    selectDefaultAgentSites();
    if (!state.selectedSiteIds.length || state.selectedSiteIds.length > 3) { renderAgentSiteChoices(); $('#agent-sites-dialog').showModal(); return; }
    if (state.plannerMode === 'compatible_browser' && (!state.modelConsent || !state.pageConsent)) { toast('请先确认发送本条任务文本和所选页面内容的授权。', true); return; }
    state.request = text.trim();
    state.plan = { kind: 'browser', supported: true, goal: text.trim(), mode: state.plannerMode, siteIds: [...state.selectedSiteIds] };
    navigate('workspace');
    render();
    return;
  }
  if (!/^2026-(09|10)$/.test(month)) { toast('当前合成资料支持 2026 年 9 月与 10 月。', true); return; }
  const planningIdentity = currentIdentity().userId;
  state.planning = true;
  state.plan = null;
  render();
  try {
    const payload = { text: text.trim(), month };
    if (workflowId) payload.workflowId = workflowId;
    if (state.plannerMode === 'model' && !state.modelConsent) throw new Error('请先同意将本条任务文本发送给已配置的模型。');
    const modelMode = state.plannerMode === 'model';
    if (modelMode) payload.consent = true;
    const data = await invoke(modelMode ? 'task.modelPlan' : 'task.plan', payload);
    if (state.switching || currentIdentity().userId !== planningIdentity) return;
    if (modelMode) state.modelConsent = false;
    state.request = text.trim();
    state.plan = { ...data, month: data?.month || month, workflowId, request: text.trim(), supported: Boolean(data?.supported && ['preset_mock', 'compatible'].includes(data?.mode)) };
    navigate('workspace');
  } catch (error) { toast(error.message, true); }
  finally { state.planning = false; render(); }
}

async function startRun() {
  if (!state.plan?.supported || isLocked()) return;
  const plan = state.plan;
  if (plan.kind !== 'browser' && !hasCredentials()) return;
  if (plan.kind === 'browser' && !plan.skillId && plan.mode === 'compatible_browser' && (!state.modelConsent || !state.pageConsent)) { toast('请先确认发送本条任务文本和所选页面内容的授权。', true); return; }
  state.actionPending = true;
  render();
  try {
    let data;
    if (plan.kind === 'browser') data = await invoke(plan.skillId ? 'agent.skill.run' : 'agent.start', plan.skillId ? { id: plan.skillId, mode: plan.mode, values: plan.values || {}, expectedVersion: plan.skillVersion } : { goal: plan.goal, siteIds: plan.siteIds, mode: plan.mode, consent: agentConsent(plan.mode) });
    else {
      const payload = { month: plan.month };
      if (plan.workflowId) payload.workflowId = plan.workflowId;
      data = await invoke(plan.workflowId ? 'workflow.run' : 'task.run', payload);
    }
    state.activeRunId = data?.taskId || data?.runId || data?.id || null;
    if (plan.kind === 'browser') { state.modelConsent = false; state.pageConsent = false; }
    state.plan = null;
    $('#task-input').value = '';
    await refresh();
    toast('任务已交给本机运行器，进度随实际操作更新。');
  } catch (error) { toast(error.message, true); }
  finally { state.actionPending = false; render(); }
}

function openCredentialDialog(system) {
  if (isLocked()) return;
  $('#credential-form').reset();
  $('#credential-system').value = system.id;
  $('#credential-dialog-title').textContent = credentialFor(system.id) ? '更新系统账号' : '连接系统账号';
  $('#credential-system-caption').textContent = `${system.label} · 仅用于本机合成站点演示`;
  $('#credential-error').hidden = true;
  $('#credential-dialog').showModal();
  $('#credential-username').focus();
}

function openSaveDialog(run) {
  if (state.actionPending || run.status !== 'completed') return;
  $('#save-workflow-form').reset();
  $('#save-dialog').dataset.taskKind = 'purchase';
  $('#save-dialog-title').textContent = '保存为工作流';
  $('#save-dialog .modal-description').textContent = '保留已跑通的步骤和月份参数。';
  $('#save-run-id').value = run.id;
  $('#workflow-name').value = '采购与入库月报资料';
  $('#workflow-pinned').checked = true;
  $('#save-error').hidden = true;
  $('#save-dialog').showModal();
  $('#workflow-name').select();
}

function openRunDialog(workflow) {
  if (isLocked() || workflow.enabled === false || (companyReadOnly() && companyWorkflow(workflow))) return;
  state.plannerMode = 'preset';
  state.modelConsent = false;
  state.pageConsent = false;
  renderModel();
  $('#run-workflow-id').value = workflow.id;
  $('#run-workflow-name').textContent = workflowName(workflow);
  $('#workflow-month').value = workflow.parameters?.month || $('#task-month').value || '2026-10';
  $('#run-dialog').showModal();
}

function confirmAction(title, message, actionText, callback, danger = true) {
  $('#confirm-title').textContent = title;
  $('#confirm-message').textContent = message;
  $('#confirm-action').textContent = actionText;
  $('#confirm-action').className = `button ${danger ? 'danger' : 'primary'}`;
  confirmCallback = callback;
  $('#confirm-dialog').showModal();
}

async function openArtifact(runId, source = false) {
  try { await invoke('artifact.open', { runId, source }); }
  catch (error) { toast(error.message, true); }
}

async function switchIdentity(userId) {
  if (userId === currentIdentity().userId || state.switching || state.actionPending) return;
  const previous = currentIdentity().userId || 'alice';
  state.switching = true;
  state.switchTarget = userId;
  state.plan = null;
  state.activeRunId = null;
  state.request = '';
  state.modelConsent = false;
  state.pageConsent = false;
  state.selectedSiteIds = [];
  state.agentSitesChosen = false;
  state.plannerMode = 'preset';
  state.expandedSteps.clear();
  state.snapshot = { identity: null, credentials: [], workflows: [], runs: [], shared: [] };
  $('#task-form').reset();
  $('#credential-form').reset();
  $('#save-workflow-form').reset();
  for (const dialog of $$('dialog')) if (dialog.open) dialog.close();
  confirmCallback = undefined;
  $('#toast').hidden = true;
  document.body.classList.add('busy-switch');
  notice('正在切换 Mock 身份；当前任务将被中止，工作空间将重新载入。');
  render();
  try {
    await invoke('identity.switch', { userId });
    await refresh();
    notice();
    toast(`已切换到 ${currentIdentity().displayName || userId} 的 Mock 工作空间。`);
  } catch (error) {
    state.switchTarget = previous;
    try { await refresh(); } catch { /* Keep the cleared workspace if the runner is unavailable. */ }
    notice(error.message, true);
  } finally {
    state.switching = false;
    state.switchTarget = null;
    document.body.classList.remove('busy-switch');
    navigate('workspace');
    render();
  }
}

$('#entry-personal').addEventListener('click', () => { state.entryPanel = 'auth'; renderProduct(); $('#auth-email').focus(); });
$('#entry-enterprise').addEventListener('click', () => { state.entryPanel = 'enterprise'; renderProduct(); });
$$('[data-entry-back]').forEach((node) => node.addEventListener('click', () => { state.entryPanel = 'choices'; $('#auth-password').value = ''; renderProduct(); }));
$('#entry-back-login').addEventListener('click', () => { state.entryPanel = 'auth'; state.authTab = 'login'; renderProduct(); });
$$('[data-auth-tab]').forEach((node) => node.addEventListener('click', () => {
  state.authTab = node.dataset.authTab; $('#auth-password').value = ''; $('#auth-error').hidden = true; renderProduct();
}));
$$('[data-contact-developer]').forEach((node) => node.addEventListener('click', showDeveloperContact));
$$('[data-copy-developer]').forEach((node) => node.addEventListener('click', () => mutation('developer.contact.copy', {}, '开发者微信号已复制。')));
$('.entry-brand').addEventListener('click', (event) => { event.preventDefault(); state.entryPanel = 'choices'; renderProduct(); });
$('#product-account-button').addEventListener('click', () => navigate('settings', true));
$('#product-auth-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const payload = { email: $('#auth-email').value.trim(), password: $('#auth-password').value };
  if (state.authTab === 'register') payload.name = $('#auth-name').value.trim();
  $('#auth-password').value = '';
  authenticate(state.authTab === 'register' ? 'auth.register' : 'auth.login', payload, '#auth-error');
});
for (const [form, input, error] of [['#entry-verify-form', '#entry-verification-code', '#entry-verify-error'], ['#settings-verify-form', '#settings-verification-code', '#settings-verify-error']]) {
  $(form).addEventListener('submit', (event) => { event.preventDefault(); const code = $(input).value.trim(); $(input).value = ''; authenticate('auth.verify', { code }, error); });
}
$('#auth-logout').addEventListener('click', () => confirmAction('退出个人账号', isRunning() ? '退出会中止当前任务并关闭业务浏览器。确定退出？' : '退出后将关闭当前业务浏览器，保留本人的本机加密资料。', '退出登录', () => authenticate('auth.logout', {}, '#settings-verify-error'), false));
$('#new-model-profile').addEventListener('click', () => openModelProfile());
$('#model-profile-provider').addEventListener('change', () => {
  const provider = list(state.snapshot.modelProfiles?.providers).find((item) => item.id === $('#model-profile-provider').value);
  $('#model-profile-base-url').value = provider?.baseUrl || '';
  $('#model-profile-api-key').value = ''; providerHelp();
});
$('#model-profile-base-url').addEventListener('input', providerHelp);
$('#model-profile-dialog').addEventListener('close', () => { $('#model-profile-api-key').value = ''; });
$('#model-profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (isLocked()) { $('#model-profile-api-key').value = ''; return; }
  const payload = { label: $('#model-profile-label').value.trim(), provider: $('#model-profile-provider').value, baseUrl: $('#model-profile-base-url').value.trim(), model: $('#model-profile-model').value.trim(), dataScope: $('#model-profile-scope').value };
  if ($('#model-profile-id').value) { payload.id = $('#model-profile-id').value; payload.expectedRevision = Number($('#model-profile-revision').value); }
  if ($('#model-profile-api-key').value) payload.apiKey = $('#model-profile-api-key').value;
  $('#model-profile-api-key').value = '';
  state.actionPending = true; $('#model-profile-submit').disabled = true; $('#model-profile-error').hidden = true;
  try {
    await invoke('model.profile.save', payload); delete payload.apiKey;
    state.modelConsent = false; state.pageConsent = false; state.plan = null; state.modelTestResult = '';
    await refresh(); $('#model-profile-dialog').close(); toast('已加密保存模型配置。保存不会自动调用模型。');
  } catch (error) { $('#model-profile-error').textContent = error.message; $('#model-profile-error').hidden = false; }
  finally { delete payload.apiKey; state.actionPending = false; $('#model-profile-submit').disabled = false; render(); }
});
$('#model-source-select').addEventListener('change', (event) => {
  state.modelTestResult = ''; const payload = { source: event.target.value };
  if (payload.source === 'sponsored' && $('#sponsored-model-select').value) payload.modelId = $('#sponsored-model-select').value;
  mutation('model.source', payload, '已切换模型来源。切换不会自动调用模型。');
});
$('#sponsored-model-select').addEventListener('change', (event) => { state.modelTestResult = ''; mutation('model.source', { source: 'sponsored', modelId: event.target.value }, '已选择服务模型。'); });
$('#model-test').addEventListener('click', () => confirmAction('测试当前模型连接', product()?.modelSource === 'sponsored' ? '将向当前所选服务模型发出一次短请求，会占用服务额度。若服务连接真实模型，可能产生 API 费用。是否继续？' : '将使用当前 API 配置向模型发出一次短请求，可能产生提供方费用。只测试连接，不发送业务页面。是否继续？', '确认并测试', async () => {
  if (isLocked()) return;
  state.actionPending = true; state.modelTestResult = '正在测试…'; render();
  try { const result = await invoke('model.test', { consent: true }); state.modelTestResult = result?.synthetic ? '本机合成服务连接成功，未验证真实大模型。' : '连接测试成功；实际任务质量仍需验证。'; }
  catch (error) { state.modelTestResult = error.message; toast(error.message, true); }
  finally { state.actionPending = false; await refresh().catch(() => {}); render(); }
}, false));

$('#write-demo-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (isLocked()) return;
  const owner = currentIdentity().userId;
  state.actionPending = true; $('#write-demo-error').hidden = true; render();
  try {
    const preview = await invoke('write.demo.preview', { month: $('#write-demo-month').value, note: $('#write-demo-note').value.trim() });
    await refresh();
    if (currentIdentity().userId !== owner || productLocked()) return;
    state.writePreview = preview;
    $('#write-preview-month').textContent = preview.payload.month;
    $('#write-preview-note').textContent = preview.payload.note;
    $('#write-preview-expiry').textContent = new Date(preview.expiresAt).toLocaleString('zh-CN', { hour12: false });
    $('#write-preview-error').hidden = true;
    $('#write-preview-confirm').disabled = false;
    $('#write-preview-dialog').showModal();
  } catch (error) { $('#write-demo-error').textContent = error.message; $('#write-demo-error').hidden = false; }
  finally { state.actionPending = false; render(); }
});
$('#write-preview-dialog').addEventListener('close', () => { state.writePreview = null; });
$('#write-preview-confirm').addEventListener('click', async () => {
  if (isLocked() || !state.writePreview) return;
  if (Date.now() >= new Date(state.writePreview.expiresAt).getTime()) { $('#write-preview-error').textContent = '预览已过期，请关闭后重新生成。'; $('#write-preview-error').hidden = false; $('#write-preview-confirm').disabled = true; return; }
  const preview = state.writePreview;
  state.actionPending = true; $('#write-preview-confirm').disabled = true; render();
  try {
    const result = await invoke('write.demo.confirm', { id: preview.id, fingerprint: preview.fingerprint });
    $('#write-preview-dialog').close();
    toast(result.status === 'completed' ? '已写入本机合成源。' : '回执尚未确认，请使用“核对回执”；不要重复提交。', result.status !== 'completed');
    await refresh();
  } catch (error) { $('#write-preview-error').textContent = error.message; $('#write-preview-error').hidden = false; }
  finally { state.actionPending = false; render(); }
});
$('#agent-edit-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (isLocked()) return;
  const form = $('#agent-edit-form'), parameters = [];
  for (const row of $$('.agent-parameter-row', form)) {
    if (!$('.agent-parameter-enabled', row).checked) continue;
    const definition = { stepIndex: Number(row.dataset.stepIndex) };
    for (const input of $$('[data-parameter-field]', row)) definition[input.dataset.parameterField] = input.value;
    parameters.push(definition);
  }
  state.actionPending = true; $('#agent-edit-submit').disabled = true; $('#agent-edit-error').hidden = true; render();
  try {
    await invoke('agent.skill.edit', { id: form.dataset.skillId, name: $('#agent-edit-name').value.trim(), parameters, expectedVersion: Number(form.dataset.version) });
    state.plan = null; await refresh(); $('#agent-edit-dialog').close(); toast('已保存浏览器流程新版本；站点与定位方式保持绑定。');
  } catch (error) { $('#agent-edit-error').textContent = error.message; $('#agent-edit-error').hidden = false; }
  finally { state.actionPending = false; $('#agent-edit-submit').disabled = false; render(); }
});
$('#agent-run-form').addEventListener('submit', (event) => {
  event.preventDefault(); if (isLocked()) return;
  const form = $('#agent-run-form'), skill = agentSkills().find((item) => item.id === form.dataset.skillId);
  if (!skill || (skill.version || 1) !== Number(form.dataset.version)) { $('#agent-run-dialog').close(); toast('工作流版本已变化，请重新选择运行参数。', true); return; }
  const values = Object.fromEntries($$('[data-parameter-name]', form).map((input) => [input.dataset.parameterName, input.value]));
  $('#agent-run-dialog').close(); planAgentSkill(skill, values);
});

$$('.nav-item').forEach((node) => node.addEventListener('click', () => node.dataset.view === 'workspace' ? newTask() : navigate(node.dataset.view, true)));
$$('[data-navigate]').forEach((node) => node.addEventListener('click', () => navigate(node.dataset.navigate, true)));
$('.brand').addEventListener('click', (event) => { event.preventDefault(); navigate('workspace', true); });
$('#try-example').addEventListener('click', fillExample);
$('#new-workflow').addEventListener('click', fillExample);
$('#theme-select').addEventListener('change', (event) => setTheme(event.target.value));
$('#theme-cycle').addEventListener('click', () => {
  const values = ['system', 'light', 'dark'];
  setTheme(values[(values.indexOf($('#theme-select').value) + 1) % values.length]);
});
$('#planner-mode').addEventListener('change', (event) => { state.plannerMode = event.target.value; state.modelConsent = false; state.pageConsent = false; state.plan = null; selectDefaultAgentSites(); render(); });
$('#model-consent').addEventListener('change', (event) => { state.modelConsent = event.target.checked; });
$('#page-consent').addEventListener('change', (event) => { state.pageConsent = event.target.checked; });
$('#choose-agent-sites').addEventListener('click', () => { renderAgentSiteChoices(); $('#agent-sites-dialog').showModal(); });
$('#model-configure').addEventListener('click', () => mutation('model.configure', {}, '已打开仓库外的本机模型配置文件。保存后刷新状态。'));
$('#model-refresh').addEventListener('click', () => mutation('model.status', {}, '模型配置状态已刷新。'));
$('#site-url').addEventListener('blur', () => {
  if ($('#site-paths').value.trim()) return;
  try { $('#site-paths').value = new URL($('#site-url').value.trim()).pathname || '/'; } catch { /* Validate on submit. */ }
});
window.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); newTask(); }
});
$('#identity-select').addEventListener('change', (event) => switchIdentity(event.target.value));
$$('[data-workflow-filter]').forEach((node) => node.addEventListener('click', () => {
  state.filter = node.dataset.workflowFilter;
  $$('[data-workflow-filter]').forEach((item) => item.classList.toggle('selected', item === node));
  renderWorkflows();
}));
$('#demonstration-open').addEventListener('click', openDemonstrationDialog);
$('#demonstration-mode').addEventListener('change', () => { state.demonstrationSiteIds = []; renderDemonstrationSites(); });
$('#demonstration-form').addEventListener('submit', async event => {
  event.preventDefault(); if (isLocked()) return;
  const goal = $('#demonstration-goal').value.trim();
  if (!goal || !state.demonstrationSiteIds.length) return;
  const payload = { goal, mode: $('#demonstration-mode').value, siteIds: [...state.demonstrationSiteIds] };
  state.actionPending = true; $('#demonstration-start').disabled = true; $('#demonstration-start-error').hidden = true; render();
  try {
    const value = await invoke('demo.start', payload); state.activeRunId = value?.taskId || null; state.request = goal; state.plan = null;
    $('#demonstration-dialog').close(); $('#demonstration-form').reset(); $('#task-input').value = ''; await refresh();
  } catch (error) { $('#demonstration-start-error').textContent = error.message; $('#demonstration-start-error').hidden = false; }
  finally { state.actionPending = false; render(); renderDemonstrationSites(); }
});
$('#task-form').addEventListener('submit', (event) => { event.preventDefault(); generatePlan($('#task-input').value, $('#task-month').value); });
$('#task-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!$('#plan-submit').disabled) $('#task-form').requestSubmit();
  }
});
$('#register-site').addEventListener('click',()=>openSiteDialog());
$('#site-form').addEventListener('submit',async event=>{
  event.preventDefault();if(isLocked())return;$('#site-error').hidden=true;
  state.actionPending=true;$('#site-submit').disabled=true;
  try {
    const url=new URL($('#site-url').value.trim());
    if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash)throw new Error('请填写不含账号、查询参数或片段的 HTTPS 地址。');
    const paths=[...new Set([url.pathname,...$('#site-paths').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean)])];
    if(paths.some(path=>!path.startsWith('/') || path.startsWith('//') || /[?#*\\]/.test(path)))throw new Error('允许路径须以 / 开头，且不含查询参数、片段、通配符或反斜线。');
    const id=$('#site-form').dataset.siteId;const payload={id:id||`site-${Date.now().toString(36)}`,label:$('#site-label').value.trim(),origin:url.origin,entryPath:url.pathname,paths};if(id)payload.expectedRevision=Number($('#site-form').dataset.revision);
    await invoke(id?'site.update':'site.register',payload);
    await refresh();$('#site-dialog').close();toast('已注册个人受控站点，登录或 MFA 需要你接管完成。');
  }catch(error){$('#site-error').textContent=error.message;$('#site-error').hidden=false;}
  finally{state.actionPending=false;$('#site-submit').disabled=false;render();}
});
$('#edit-workflow-form').addEventListener('submit',async event=>{
  event.preventDefault();if(isLocked())return;
  state.actionPending=true;$('#edit-workflow-submit').disabled=true;$('#edit-workflow-error').hidden=true;
  try {await invoke('workflow.edit',{id:$('#edit-workflow-id').value,name:$('#edit-workflow-name').value.trim(),description:$('#edit-workflow-description').value,month:$('#edit-workflow-month').value,expectedVersion:Number($('#edit-workflow-version').value)});state.plan=null;await refresh();$('#edit-workflow-dialog').close();toast('已保存新版本；重新运行验证后才能发布。');}
  catch(error){$('#edit-workflow-error').textContent=error.message;$('#edit-workflow-error').hidden=false;}
  finally{state.actionPending=false;$('#edit-workflow-submit').disabled=false;render();}
});
$('#workflow-run-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const workflowId = $('#run-workflow-id').value;
  const month = $('#workflow-month').value;
  $('#run-dialog').close();
  $('#task-month').value = month;
  generatePlan('运行采购与入库月报资料流程', month, workflowId);
});
$$('.close-dialog').forEach((node) => node.addEventListener('click', () => node.closest('dialog').close()));
$('#credential-dialog').addEventListener('close', () => { $('#credential-password').value = ''; $('#credential-username').value = ''; });
$('#confirm-dialog').addEventListener('close', () => { confirmCallback = undefined; });
$('#confirm-action').addEventListener('click', async () => {
  const callback = confirmCallback;
  $('#confirm-dialog').close();
  if (callback) await callback();
});
$('#credential-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.actionPending || state.switching || isRunning()) { $('#credential-password').value = ''; return; }
  const payload = { systemId: $('#credential-system').value, username: $('#credential-username').value.trim(), password: $('#credential-password').value };
  $('#credential-password').value = '';
  if (!payload.username || !payload.password) return;
  $('#credential-submit').disabled = true;
  $('#credential-error').hidden = true;
  state.actionPending = true;
  render();
  try {
    await invoke('credential.save', payload);
    payload.password = '';
    await refresh();
    $('#credential-dialog').close();
    toast('账号已由本机运行器加密保存。');
  } catch (error) {
    $('#credential-error').textContent = error.message;
    $('#credential-error').hidden = false;
  } finally {
    payload.password = '';
    state.actionPending = false;
    $('#credential-submit').disabled = false;
    render();
  }
});
$('#save-workflow-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.actionPending || state.switching) return;
  const name = $('#workflow-name').value.trim();
  if (!name) { $('#workflow-name').focus(); return; }
  state.actionPending = true;
  $('#save-submit').disabled = true;
  $('#save-error').hidden = true;
  render();
  try {
    const isBrowserTask = $('#save-dialog').dataset.taskKind === 'browser';
    await invoke(isBrowserTask ? 'agent.skill.save' : 'workflow.save', isBrowserTask ? { taskId: $('#save-run-id').value, name, pinned: $('#workflow-pinned').checked } : { runId: $('#save-run-id').value, name, pinned: $('#workflow-pinned').checked });
    await refresh();
    $('#save-dialog').close();
    toast(isBrowserTask ? '浏览器工作流已保存，可复用已授权站点与步骤。' : '工作流已保存，下次可以更换月份再运行。');
  } catch (error) { $('#save-error').textContent = error.message; $('#save-error').hidden = false; }
  finally { state.actionPending = false; $('#save-submit').disabled = false; render(); }
});
window.addEventListener('beforeunload', () => { if (typeof unsubscribe === 'function') unsubscribe(); });

try { setTheme(localStorage.getItem('yuanyu-theme') || 'system'); } catch { setTheme('system'); }
render();
try {
  if (window.workbench?.onUpdate) unsubscribe = window.workbench.onUpdate(acceptSnapshot);
  await refresh();
} catch (error) { notice(error.message, true); $('#boot-status').textContent = error.message; $('#boot-status').setAttribute('role', 'alert'); }
