# 首轮实现契约

日期：2026-11-05。此文件是协作接口，不是完整产品规范。

## 固定场景

预设技能 `purchase-monthly`：Mock采购订单与Mock仓储入库两个不同本机站点，经各自登录和月份筛选，按采购单号关联；仅纳入已审核订单，缺少入库的列为待核实；按分为单位计算金额，输出CSV和来源说明。默认2026-10，另含2026-09以验证参数复用。它是业务月报资料草稿，不是正式财务报表。

## 核心模块（src/core/）

导出 `createWorkspace({ dataDir, cryptoAdapter, identity, systems })`。方法均可await：

- `snapshot()` -> `{ identity, credentials, workflows, runs, shared }`；永不返回密码/密文/令牌。身份 `{companyId,userId,displayName,provider:'mock'}`。
- `saveCredential({systemId,username,password})`；systems为服务端固定字典 `{[id]:{id,label,origin}}`。不得接受调用方绑定任意origin。
- `deleteCredential(id)`；`withCredential(systemId, callback)`仅供可信主进程运行时，callback接收 `{username,password,origin}`。
- `beginRun({month,workflowId?})` -> run；记录 `{id,month,status:'running',steps:[],...}`。
- `updateRun(id, {status?,steps?,artifact?,summary?,error?})` -> run；状态 running/completed/failed/cancelled。artifact为受控本机文件元数据，不含文件内容。
- `saveWorkflowFromRun({runId,name,pinned})` -> workflow `{id,name,recipeId:'purchase-monthly',parameters:{month},pinned,version,verified,...}`；仅从本人的completed运行创建，不复制结果或凭据。
- `setPinned(id,pinned)`、`deleteWorkflow(id)`。
- `publishWorkflow(id)` -> sanitized publication，包含固定版本、公司、发布者和白名单模板。
- `importWorkflow(publicationId)` -> 个人副本；不同公司不可见不可导入；模板不授予系统权限。
- `revokePublication(id)`仅作者可撤回。

文件存储单进程串行、原子替换、验证输入和路径，不支持未经验证的多实例。凭据使用注入的加密器 `{available(),encrypt(text),decrypt(ciphertext)}`，Electron端绑定safeStorage；测试加密适配器不得在生产回退。

## 浏览器与Mock（src/browser/, src/mock/, src/runtime/）

- `startMockSystems()` -> `{systems,close()}`；systems采购/仓储键为 `procurement`、`warehouse`，各有 `{id,label,origin,url}`。
- `createBrowserDriver({BrowserWindow,systems,show=true})` -> `{readSystem(systemId,{month,credential}),close()}`；readSystem真正打开网页、登录、筛选、读取并验证表格，结果 `{rows,source:{systemId,url,month,readAt},actions}`。不从Mock服务端直取内部数据。credential来自可信withCredential，不得进入actions/source/log。
- `buildMonthlyReport({procurement,warehouse,month,outputDir})` -> `{artifact,summary}`；独立对账校验，CSV公式注入保护，唯一文件名、落盘后校验、另有来源说明；仅授权的固定输出目录。不返回“完整财报”声明。
- 可测试的纯校验/聚合/URL规则须从Electron import中分离，Node单元测试无需Electron启动。

## 主进程 / UI

本机独立版固定Mock身份：alice/bob同公司，outsider另一公司；身份由 `src/core/identity.mjs` 本机工厂与受控断言裁决，无账号服务、无云端身份。切换仅限明确标记的Mock演示，切换后中止/隔离执行与浏览器状态。IPC只允许本地工作台主frame，不向远程页面开放。

`window.workbench.invoke(action,payload)` -> `{ok:true,data}` 或 `{ok:false,error:{code,message}}`；`window.workbench.onUpdate(callback)`接收无敏感数据的snapshot。action：`snapshot`,`credential.save`,`credential.delete`,`task.plan`,`task.run`,`run.cancel`,`workflow.save`,`workflow.pin`,`workflow.delete`,`workflow.run`,`workflow.publish`,`workflow.import`,`workflow.revoke`,`artifact.open`,`identity.switch`。

task.plan接收 `{text,month}` -> `{supported,mode:'preset_mock',message,month,recipeId:'purchase-monthly'}`，仅识别明确采购/入库/月报材料任务，不声称通用模型理解；不支持的诉求直接说明。task.run接收 `{month,workflowId?}`，主进程串行执行，返回运行id；状态通过onUpdate/snapshot刷新。

UI负责界面文件 src/ui/*；不直接访问Node和文件系统。凭据表单提交后清空密码，绝不缓存localStorage。公开仅指公司内部Mock目录。

本机合成演示边界：个人独立版无账号服务与部署模式，不预填任何登录表单；内建合成站点的演示凭据在[使用指南](GUIDE.md)中静态给出，由用户自行填入本机凭据表单。密码不从凭据库回传渲染器、不进入上下文或日志。`src/ui/styles.css`用`scrollbar-width:none`与`::-webkit-scrollbar{display:none}`隐藏默认滚动条但保留滚动能力，不禁用overflow。

## 后续增强接口（2026-11-05）

- 私有state schema2：workflow新增description/enabled及不可变历史，run绑定workflowVersion。`workflow.edit{id,name?,description?,month?,expectedVersion}`、`workflow.versions{id}`、`workflow.restore{id,version,expectedVersion}`、`workflow.enabled{id,enabled,expectedVersion}`；内容/状态变化撤旧发布、清verified，恢复创建新revision。
- `site.register{id,label,origin,entryPath,paths}`、`site.update{...,expectedRevision}`、`site.delete{id,expectedRevision}`；元数据按公司/用户隔离。路径为精确页面路径；同来源静态资源另有只读例外，不能据此打开未授权页面或XHR。源变更时凭据需重绑，删除时移除关联凭据并关闭会话。
- `browser.open/observe/handoff/resume/fillCredential{siteId}`、`browser.close{}`。`createInteractiveBrowser`是有限原生工具端口，不收任意JS/selector，不直接接受模型提供的密码。普通工具禁止凭据/OTP和业务提交。元素ref在页面变化/动作后失效；fillCredential仍由可信主进程访问凭据库。
- `model.status`返回配置元数据，`ready`仅表示语法配置完备，`connection:not_verified`，不读密钥或联网。`model.configure`在仓库外创建默认disabled配置并打开。`task.modelPlan{text,month,consent:true}`只将本条任务及公开固定配方交给兼容模型，返回计划，不能直接执行；与真实任务读取/确认区分。
- `runBrowserToolLoop`由工作台通用任务执行器调用：仅有open/observe/act/handoff四类工具，独立pageContent consent、当前站点、12步/45秒预算及前后context检查；未读取非登录页面不能直接声称完成。checkpoint不存页面正文。
- OIDC/公司HTTP共享/写入确认/备份恢复为可信集成端口，未直接放开Mock核心的生产身份或真实上游提交。公司HTTP客户端不缓存成员授权；写入未知回执只能核对，不能重试提交。
- localStorage仅保存外观主题，不保存密码、账号或模型密钥；模型配置/密钥文件、业务网页内容不会出现在共享模板中。

## 通用浏览器任务与个人Skill

`snapshot`额外返回`agentTasks`、`agentSkills`和`agentSites`（id/label/origin/revision/builtin），不把通用任务套入采购月份/报表。运行时与采购执行互斥；身份切换关闭旧会话并丢弃迟到结果。

- `agent.start{goal,siteIds,mode,consent}`、`agent.resume{id,consent}`、`agent.cancel{id}`。mode为`mock_browser`或`compatible_browser`；前者只能内建本机合成站点，后者只能注册HTTPS来源。开始/继续均为用户显式操作。
- `agent.skill.save{taskId,name,pinned}`、`agent.skill.run{id,mode,consent}`、`agent.skill.pin{id,pinned}`、`agent.skill.delete{id}`。保存仅接受本人completed任务；IPC不能提交recipe、locator、trace或站点来源。
- `src/agent/store.mjs`按个人持久化状态与attempt；每次写回检查attempt和终态。跨进程遗留running转interrupted；续跑产生新attempt，重建只读动作轨迹。
- `src/agent/runtime.mjs`绑定当前身份、站点origin/revision；每个工具动作前后复验。成功动作在执行前先验证可记录性，再持久化checkpoint。恢复不保存cookie、旧元素ref或内部模型思考。
- trace只保存open/observe及有限click/fill/select：动作使用角色与可见名称唯一匹配；正文不存，查询值最长200字符且不得含凭据。普通业务提交仍由浏览器策略拒绝。浏览器Skill只在本人本机使用，暂不接公司发布。
- `createBrowserModelRequester({file,consent})`只接受已配置`dataScope:selected_pages`和双同意；工厂/状态不读密钥不联网，实际请求才读取外部文件。每轮请求前后固定配置指纹，禁止静默更换提供方。最终摘要不是原始页面备份，也不构成真实性保证。

合成演示是确定性的测试驱动，只用于交互站点2026-09/10筛选，不算LLM理解验收。步骤重放仅复用已验证只读动作，不代表已经自动归纳任意新业务规则。

## 本机身份与自配模型（2026-11-18 独立化收束）

本产品为完全独立的本机个人 Agent：无账号注册、无服务端、无公网部署、无企业入口。身份固定为 Mock（alice/bob/outsider），由 `src/core/identity.mjs` 的本机工厂与受控 WeakSet 断言裁决；`snapshot` 不再暴露 `product` 字段或企业公开示例。2026-11-06 的账号/推广契约作为历史归档，不再属于现行产品（见 PLAN M11）。

- `accountIdentity(account)` 生成本机冻结身份（companyId `personal-<id>`、userId `user-<id>`、provider `account`）；`isAccountIdentity(identity)` 仅对工厂生成的对象返回真，供 agent/core/memory/project 各存储层与 Mock 身份断言并列使用。工厂不接受用户自填公司或外部输入 injected 身份。
- 身份切换 `identity.switch{userId}` 仅限明确标记的 Mock 演示身份；切换时中止并隔离执行、浏览器与待确认状态，各存储按身份目录分别落盘，跨身份数据不可见。
- `model.profile.save{id?,label,provider,baseUrl,model,dataScope,apiKey?,expectedRevision?}`、`select{id}`、`delete{id}`：仅本人自配的 Chat Completions 兼容 API；密钥OS加密并绑定本人/模型/来源；列表仅公开元数据；源改变必须重录密钥。数据外发范围 `dataScope` 为 `selected_pages` 时才允许页面内容进入模型，任务文本与页面内容分别逐次同意。
- `model.test{consent:true}`只发送最小测试消息，费用由本人模型提供方计收；不发送页面。失败不自动重试，成功只证明当前连接，不能证明业务质量。
- 用量可观测：请求经网关透传提供方 `usage`（`promptTokens`/`completionTokens`/`cachedTokens`，未报告记 null），跨轮累计写入任务终态白名单字段 `usage`/`promptVersion`/`compactions`。无服务端额度、无推广预算、无按账号计费。

## 只读浏览器Skill修订与合成业务写入

- `agent.skill.edit{id,name?,parameters?:[{name,stepIndex,label,defaultValue?}],expectedVersion}`，stepIndex为已成功recipe的0-based索引，仅fill/select可参数化。不能从IPC注入recipe、定位器、站点或脚本。新内容version+1。
- `agent.skill.run{id,mode,consent,values?,expectedVersion?}`，values仅接收声明参数。运行绑定skillVersion和parameterValues，暂停/重开仍使用原参数；修订后旧任务不能恢复，也不能用旧确认计划运行新版。站点版本规则继续有效。
- `snapshot.writeDemo`仅本人合成源records及审批元数据；`write.demo.preview{month,note}`固定合成源/操作，返回payload、expiresAt、fingerprint；`write.demo.confirm{id,fingerprint}`必须源/身份/期限复验；`write.demo.inspect{id}`核对未知回执。普通浏览器工具仍不能提交业务。
- 合成源仅保存2026-09/10月核对备注草稿，实际写本机隔离文件。幂等键固定为审批id；重建或恢复后只核对未知回执，不重试写入。备份采用精确白名单（agents/company/user/state.json 及 demo-source），不包含模型密钥、浏览器缓存或任何服务端数据。

## 个人开源分发范围

本分支为完全独立的本机个人 Agent，不含账号服务、推广额度、公网部署、企业OIDC与HTTP共享适配器；相关历史契约保留为跨版本设计参考，企业实现在独立的 `enterprise`（原 `codex/enterprise`）。模型配置、执行器与公司Mock共享的受控 IPC 校验保留为本地/安全回归用途。详见[版本说明](EDITIONS.md)。

## 工作台受控人工示范（2026-11-06）

`snapshot.demonstration`为当前身份的易失视图或null：taskId/mode/status/siteIds/currentSiteId/page/canFinish/operationPending。page仅主进程内存与受信UI使用，含经清洗的title/text和安全控件ref/role/name/actionKinds/options，不落盘、不发送模型。身份切换时整体隐藏。

- `demo.start{goal,siteIds,mode}`先确认1—3个授权站点；mode为mock_browser或compatible_browser。与采购、模型任务、站点和模型配置变更互斥。自动打开首站；登录/MFA仅人工接管。
- `demo.observe{id,siteId}`重新打开/观察所选站点；`demo.act{id,siteId,action:{type,ref,value?}}`仅接收当前观察的fill/select/白名单只读click。名称/角色必须唯一并可复用，敏感控件/查询值在动作前拒绝，每次动作自动重新观察。
- `demo.handoff{id,siteId}`、`demo.resume{id}`：登录操作不记录；resume只继续本次进程仍存活的示范，重建观察，不使用旧ref。
- `demo.finish{id,confirmed:true}`需至少一次成功操作和最新非登录结果；逐个重读已打开站点，内容或结构变化则刷新视图并要求再次核对。完成后可由原有agent.skill.save保存，编辑参数与重放沿用原契约。
- `demo.cancel{id}`与通用取消/退出/切身份清理原身份任务和会话。错误id不能取消另一条启动中的任务。IO与授权有操作时限，取消/身份切换抑制迟到成功；完成写盘后的最终授权失败用仅可信主进程可调用的同attempt负向收尾，不暴露IPC、不修改已保存Skill的来源记录。
- AgentStore任务新增可选`execution:'demonstration'`，兼容既有schema。仅保存安全trace和步骤，不能从普通agent.resume接入模型。重启后遗留录制/接管示范转为interrupted，用户直接重新示范，原记录保留；不承诺复原原生网页操作或旧会话。

自定义站点可执行哪些操作仍由浏览器策略决定；未配置只读点击规则的自定义站点不会因人工示范自动开放按钮。示范是在工作台中选择允许的控件，不监听或录制网页中的任意手势。

## 只读重放的有界引用恢复

已保存Skill的本机步骤重放不创建模型requester，不要求模型配置、任务文本/页面外发同意；本机身份、精确站点与修订校验保持。新建兼容模型任务仍须模型配置和逐次双同意。

- replayRecipe仅对当前动作抛出的STALE_REFERENCE重新观察并重定位一次；此前成功操作不重复。重新观察后必须唯一匹配原角色/名称，不能凭相似文字猜测，也不自动改写原Skill。
- 来源变化、身份切换、取消、写入策略拒绝、网络/未知回执及模型错误不自动重试。重试前后均复验上下文；再次过期即停止。
- 登录页交给用户处理；显式继续仍按新观察安全重放，不宣称跨登录/进程保留精确业务状态。末尾有动作未读取的站点须重新观察；不能沿用旧页面宣布完成。
- 任务可选replay元数据：stepIndex（0-based）、total（1—100）、tool、siteId、retries（0/1）、state（executing/recovering/completed/awaiting_user/failed）、可选reason（STALE_REFERENCE/PAGE_STRUCTURE_CHANGED/LOGIN_REQUIRED）。仅绑定Skill任务可写，站点必须属于任务，拒绝额外字段、页面、ref。
- 每次成功和恢复尝试采用当前attempt写回；resume与重开遗留运行清除旧进度。恢复步骤单独记录在steps，UI区分执行步骤与重新观察尝试。

## 固定配方模型验收入口（2026-11-07）

公共规划题库与纯评分模块只覆盖purchase_plan。runModelEvaluationCLI默认offline：不读取配置/密钥、不构造真实请求，报告not_run/scorePercent:null/networkRequests:0。live必须同时明确--live --allow-paid --config（仓库外模型配置）--max-requests，预算在读取配置前校验；每题仅一次，失败占尝试数，止损错误停止后续调用。

输入仅task/month/signal，预期答案只在本地评分；报告区分requestsAttempted/networkRequests/覆盖率，不回传原始模型输出或秘密。CLI不执行浏览器工具；离线通过或固定规划得分不代表真实模型、页面理解或生产业务验收。

## M6 记忆、统一工具、结果验证与有限修正（2026-11-13，A/B/C 阶段）

本节只描述本机合成验证过的接口，完成状态以[唯一工作清单](PLAN.md)和[测试报告](TEST_REPORT.md)为准，不代表真实模型或生产业务验收。

- `snapshot.memory`返回`{revision,available,entries,settings}`；OS加密不可用或身份切换时整体隐藏。载荷使用现有加密适配，存于仓库外`memory/<company>/<user>/state.json`，单写者原子替换与CAS revision；每条含kind、status、source、siteBindings、有效期及版本。`pauseRestoredMemory`只在恢复时把条目置为paused，不解密也不启用；`forget`级联清除所有历史版本、候选与派生载荷并保留最小删除标记；备份沿用精确白名单，不导出整个用户目录。
- `memory.save{id?,kind,title,content,siteIds,expiresAt?,expectedRevision?}`、`memory.enabled`、`memory.confirm`、`memory.settings`、`memory.forget`、`memory.preview{query,siteIds,includeEpisodes?}`、`agent.history.clear{before,confirmed}`。候选默认proposed不生效；本机关键词检索先按可信身份、状态、有效期、站点及修订过滤，最多5条/约1500输入Token，不建立明文索引、不引入外部向量库。结构白名单与敏感内容检查拒绝凭据、URL内嵌账号、网页正文、提示注入及伪造字段；扫描只是辅助，不宣称能识别所有秘密。记忆只作为本次任务的不可信DATA，不授予站点、模型或企业权限。
- `agent.start`新增`consent.memoryIds`（最多5条，须`consent.memory===true`）、`budgetOptions.maxModelRequests`（1—12）与`enableReflection`。`contextProvider`逐条取出本人已选记忆，请求前后复验身份、记忆revision及模型来源/配置revision；切换身份、模型或记忆修订即丢弃旧上下文，不把旧模型对话静默转发。已保存Skill重放不携带记忆、不构造模型requester、不要求页面外发同意。模型网关consent白名单接受`memory/memoryIds`，仅校验字段，不接收记忆正文。
- 现有四工具由`createBrowserToolRegistry`/`createToolExecutor`统一注册执行：严格输入/输出schema、执行前后授权复验、串行调用、由可信执行器生成证据ID，结果状态为succeeded/failed/uncertain/awaiting_user/denied。界面、模型或网页不能注册工具实现；不新增任意Shell、HTTP或JS执行；登录、凭据与MFA仍由可信主进程和人工接管；普通工具继续拒绝业务写入。
- `createTaskBudget`及store的`claimBudget/beginBudget/finishBudget`跨attempt累计模型请求、轮次、工具数、主动时间、修正与复核次数及输入Token估算；默认8次模型请求、12轮、45秒、1次修正、1次复核，Skill的modelRequests上限为0。继续或重启不刷新额度，旧任务缺budget以`AGENT_BUDGET_LEGACY`拒绝恢复。
- `verifyTaskResult`独立于模型措辞检查必要站点覆盖、动作后重新读取与页面证据。内建合成站点按月份做确定性校验返回verified；其他开放式网页任务为needs_review，任务进入`awaiting_review`，须经`agent.confirmResult{id,confirmed:true,expectedAttempt}`明确核对后才转为completed；`store.saveSkill`拒绝未完成或未核对结果的任务。工具循环返回的是任务状态，写入步骤时必须映射为合法步骤状态，不能把任务级状态直接落盘。
- B阶段错误分类：`classifyRecovery({code,effectState,correctionsUsed})`现由`runBrowserToolLoop`与`replayRecipe`共同调用，只返回`repair_once / handoff / stop`。仅`effectState==='not_started'`且`correctionsUsed===0`的`STALE_REFERENCE / INVALID_BROWSER_ACTION / AGENT_TOOL_INPUT_INVALID`允许一次修正；登录/MFA交人工接管；身份切换、取消、越权/写入确认、来源或模型配置变化、提供方/额度/费用/限流/超时、未知回执、页面结构变化与预算耗尽一律停止。`onBudget`返回主进程累计预算，`used.corrections`为跨attempt唯一裁决依据，确定性引用恢复与可选模型复核不再各开一套计数；相同问题码或修正后重复同一调用立即以`AGENT_CORRECTION_NO_CHANGE`停止。
- 可选模型复核：仅在`agent.start.enableReflection===true`时启用，每任务最多一次，先预留`correction`与`reflection`预算，再向当前请求追加结构化反馈消息；反馈只含安全错误码、站点ID和限定指令，不含页面正文或模型推理。修正后的每个动作仍经过原工具schema、执行前后授权复验与`Verifier`；完成状态仍由独立验证决定，模型复核不能单独升级为"已验证完成"。
- 结构化修正记录：`task.reflections`最多5条，字段严格限制为`id / problemCode / evidenceIds / proposedCorrection / checkResult / nextAction`；`proposedCorrection`仅`REOBSERVE_CURRENT_SITE / CORRECT_TOOL_INPUT / NONE`，`checkResult`仅`pending / verified / needs_review / rejected`，`nextAction`仅`reobserve / deliver / await_user_review / stop`。证据ID来自可信执行器；记录不含网页正文、模型思维链或自由文本，`onReflection`在修正开始与复验结束时各写一次，任务卡展示问题、动作与复验结果。store按字段白名单校验，拒绝伪造字段、页面文本与超量；继续任务保留记录，迟到或取消后的结果不得落盘。
- 脱敏经验候选：`snapshot.memory.settings`新增独立开关`rememberLessons`（默认关闭，与`rememberEpisodes`分别控制）。仅本人已完成、存在`verified / needs_review`复验记录、且开关打开时，控制器才用安全错误码与复验结论生成一条`kind:'lesson'`候选；`confirmed:false`即`proposed`，7天未确认清理，必须`memory.confirm`后才生效。同一运行ID不重复生成；候选不能自动修改永久Skill、白名单、预算或权限，也不能作为可信业务规则。候选是尽力而为，保存失败不影响任务完成。C阶段已按[清单](PLAN.md)补齐本机可验证部分：
- `memory.diff{id,expectedRevision}`只读返回`{id,revision,kind,status,current,history}`：`current/history`严格限于标题、内容、核实时间、有效期、revision与状态；历史密文解密后仍按本人/记录/revision绑定校验，拒绝篡改密文、跨身份、过期CAS与伪造字段，不返回密文、owner、来源或派生引用。界面只对stale/superseded条目提供"查看差异"，记忆revision变化即清空差异展示，差异不会自动采纳旧事实。
- 摘要选择留存：`rememberEpisodes`打开后，控制器只为本人的completed任务生成一条`kind:'episode'`的`proposed`候选（7天未确认清理、同一任务去重），必须`memory.confirm`后才active（确认后30天）；内容只含执行模式与步骤数。`offerEpisode`在`onTaskMemory`与`agent.confirmResult`两条路径调用，修复待核对任务确认结果后不生成摘要的缺陷。未确认候选不进入`memory.preview`或上下文外发。
- 来源与恢复：`agent.history.clear`为被Skill引用的已结束任务保留最小不可执行来源凭证（taskId、模板指纹、完成时间），清理后Skill仍通过`validateState`来源校验；备份精确白名单只导出`memory/<company>/<user>/state.json`，恢复由`pauseRestoredMemory`把全部条目置paused，不解密、不自动启用，需逐条确认；`forget`级联清除全部历史版本、候选与派生载荷并保留最小删除标记。
- 证据边界：`memory.preview.recommendedSkills`只按当前站点绑定与名称做本机匹配，不读取记忆正文、不自动运行或修改Skill；身份切换隔离端到端回归已由`test/memory-consent-revocation.test.mjs`补齐（切换后旧身份数据不可见、跨身份隔离、选定记忆外发逐次同意、请求间记忆修订使上下文失效）；真实模型/业务的成功率与费用/人工纠正次数对照仍未验收，不自动扩大反思范围。W24—W27父项按A→B→C整体验收保持未关闭。

## M8 项目化工作（2026-11-16）

- `snapshot.projects`返回`{revision,projects,currentId}`；身份切换时整体隐藏（与`memory`同款门控）。项目是按身份隔离的**目录登记记录**，存于仓库外`projects/<company>/<user>/state.json`，单写者队列、原子替换、PID映像锁与`projects`根锁。
- `project.createEmpty{name,root}`在全部校验通过后才创建目录（失败无目录副作用）：root必须绝对、仓库外、链路无符号链接；目标不存在或为空目录才创建，非空拒绝。`project.importFolder{root,name?}`只登记已存在的真实文件夹（默认名取文件夹名），不移动、不复制、不修改其中任何文件；同一真实路径（按realpath规范化，含大小写/斜杠差异）拒绝重复登记。`project.rename`、`project.setCurrent{id|null}`、`project.remove`、`project.openFolder`均以`expectedRevision`裁决，`openFolder`调用本机打开器并顺带更新最近打开与当前项目。
- 安全边界：删除项目只移除登记记录，永不删除用户文件；路径含符号链接、落点在代码仓库内或状态文件被篡改一律拒绝（`PROJECT_UNSAFE_PATH` / `PROJECT_STORE_INVALID`）；界面渲染项目名与路径为纯文本，不执行项目目录内容。`workbench:pickDirectory`为系统目录选择IPC，校验请求来源帧，仅返回所选路径或取消，不读取目录内容。

## M9 多模态任务附件（2026-11-17）

- 附件仅用于通用浏览器任务（`agent.start` 的 `attachments` 字段）：类型白名单为图片（png/jpg/jpeg/webp/gif/bmp）、PDF、Office（doc/docx/xls/xlsx/ppt/pptx）、文本（txt/md/csv/json/log）与音频（mp3/wav/m4a/ogg）；**视频显式拒绝**（`ATTACHMENT_VIDEO_UNSUPPORTED`）。上限 6 个、单个 3MB、合计 9MB，名称去重，data URL 逐字节核验后才允许落盘或外发。
- 附件文件按任务写入 `agents/<company>/<user>/attachments/<taskId>/`，权限 600；读取时校验非符号链接且大小与任务记录一致，篡改或缺失一律拒绝（`AGENT_UNSAFE_PATH`）。任务记录仅保存附件元数据白名单（id/name/mediaType/kind/size），不含文件内容。
- 模型消息中仅**首个用户消息**允许 parts 数组：首 part 必须为任务文本，其余为 `image_url`（仅 data:image/(png|jpeg|webp|gif|bmp) 前缀，≤5M 字符）或 `text`（≤25000 字，过敏感词校验）；其余用户消息保持纯文本。后续轮次的历史消息中原样保留首条 parts。合成 Mock 模式只记录附件，不把附件交给合成请求器。
- 同意边界：附件随任务文本在 `consent.taskText` 同意后外发；附件不进入预设采购配方、示范录制与工作流重放。PDF/Office/音频当前仅登记元数据，不解析正文。
