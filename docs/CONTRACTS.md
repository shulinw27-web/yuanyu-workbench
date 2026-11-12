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

无productClient的兼容测试主进程固定Mock身份：alice/bob同公司，outsider另一公司；正常个人版使用后文账号服务身份。切换仅限明确标记的Mock演示，切换后中止/隔离执行与浏览器状态。IPC只允许本地工作台主frame，不向远程页面开放。

`window.workbench.invoke(action,payload)` -> `{ok:true,data}` 或 `{ok:false,error:{code,message}}`；`window.workbench.onUpdate(callback)`接收无敏感数据的snapshot。action：`snapshot`,`credential.save`,`credential.delete`,`task.plan`,`task.run`,`run.cancel`,`workflow.save`,`workflow.pin`,`workflow.delete`,`workflow.run`,`workflow.publish`,`workflow.import`,`workflow.revoke`,`artifact.open`,`identity.switch`。

task.plan接收 `{text,month}` -> `{supported,mode:'preset_mock',message,month,recipeId:'purchase-monthly'}`，仅识别明确采购/入库/月报材料任务，不声称通用模型理解；不支持的诉求直接说明。task.run接收 `{month,workflowId?}`，主进程串行执行，返回运行id；状态通过onUpdate/snapshot刷新。

UI负责界面文件 src/ui/*；不直接访问Node和文件系统。凭据表单提交后清空密码，绝不缓存localStorage。公开仅指公司内部Mock目录。

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

## 个人版账号、推广额度与模型（2026-11-06）

默认正常启动启用个人账号产品模式；既有Mock身份控制器仅用于隔离测试，不能从个人版IPC切换。服务端可信账号适配生成品牌身份，companyId为personal-<accountId>，不是用户自填公司。未登录/服务不可用/撤权后snapshot隐藏身份、私有系统、模型和业务数据。

- `auth.register{email,password,name}` / `auth.login{email,password}` / `auth.verify{code}` / `auth.logout{}`。服务端密码使用scrypt散列，sessionToken仅主进程收取并OS加密；注册/登录IPC返回公开account，不返回sessionToken。合成验证码仅local_demo返回。
- `snapshot.product`：authenticated、account、deployment（local_demo/configured）、developer{name,contact,contactType:'wechat'}、limits{monthlyTokens,dailyRequests,configured}、usage、models（仅id/label）、promotionBudget{configured}、modelSource、sponsoredModelId、companyWorkflows{readOnly:true}。默认联系微信wsltest。
- 个人版 `workflow.import/publish/revoke` 及公司来源流程运行在主进程拒绝；公开流程为脱敏示例，不向个人账号暴露企业私有目录。`developer.contact.copy{}`只复制可信服务返回的联系方式，不采纳调用方指定文本。
- 推广服务 `/v1/public`、`/v1/auth/register|login|verify|logout`、`/v1/me`、`/v1/inference`。推理接受白名单modelId/messages/tools/consent/requestId，注册账号和验证、逐次同意、额度缺一不可。每次模型请求计一次（一个任务可能多次）；BYOK不扣推广额度。日/月周期均按Asia/Shanghai。
- 调用前SQLite事务预留每人和全局额度；重复请求id与内容绑定。缺失用量、超时/未知回执保留预留，不自动再次调用；有效usage确定结算。真实模式全局预算须显式配置；demo授权不能自动转真实。服务不执行浏览器工具，只返回模型消息，由本机受控执行器复验。
- 运营配置仅仓库外：providers[{id,label,baseUrl,model,apiKeyFile}]。server provider构造/启动不读密钥、不联网，实际已授权推理才读取密钥。客户端拿不到开发者API key。reasoning_content有界且仅短期内存转发，不进入UI/磁盘缓存；带思考的幂等结果在重启或5分钟后返回REQUEST_CONTEXT_EXPIRED，不重新调用。
- `model.profile.save{id?,label,provider,baseUrl,model,dataScope,apiKey?,expectedRevision?}`、`select{id}`、`delete{id}`。密钥OS加密并绑定本人/模型/来源；列表仅公开元数据；源改变必须重录密钥。`model.source{source:'sponsored'|'byok',modelId?}`；进入多模型配置后无活动模型不会静默使用旧model.local.json。
- `model.test{consent:true}`只发送最小测试消息，可能扣推广额度或产生BYOK费用；不发送页面。失败不自动重试，成功只证明当前连接，不能证明业务质量。旧model.local.json在尚未使用多模型配置的兼容模式保留。

## 只读浏览器Skill修订与合成业务写入

- `agent.skill.edit{id,name?,parameters?:[{name,stepIndex,label,defaultValue?}],expectedVersion}`，stepIndex为已成功recipe的0-based索引，仅fill/select可参数化。不能从IPC注入recipe、定位器、站点或脚本。新内容version+1。
- `agent.skill.run{id,mode,consent,values?,expectedVersion?}`，values仅接收声明参数。运行绑定skillVersion和parameterValues，暂停/重开仍使用原参数；修订后旧任务不能恢复，也不能用旧确认计划运行新版。站点版本规则继续有效。
- `snapshot.writeDemo`仅本人合成源records及审批元数据；`write.demo.preview{month,note}`固定合成源/操作，返回payload、expiresAt、fingerprint；`write.demo.confirm{id,fingerprint}`必须源/身份/期限复验；`write.demo.inspect{id}`核对未知回执。普通浏览器工具仍不能提交业务。
- 合成源仅保存2026-09/10月核对备注草稿，实际写本机隔离文件。幂等键固定为审批id；重建或恢复后只核对未知回执，不重试写入。备份包括demo-source精确state.json及对应账本，不包含账号服务数据库、session、BYOK配置或浏览器缓存。

## 个人开源分发范围

本分支不包含企业OIDC和HTTP共享适配器；本文相关契约保留为跨版本设计参考，实际代码在`enterprise`（原 `codex/enterprise`）。个人注册服务、模型配置与执行器保留，公司Mock仅作合成测试。详见[版本说明](EDITIONS.md)。

## 工作台受控人工示范（2026-11-06）

`snapshot.demonstration`为当前身份的易失视图或null：taskId/mode/status/siteIds/currentSiteId/page/canFinish/operationPending。page仅主进程内存与受信UI使用，含经清洗的title/text和安全控件ref/role/name/actionKinds/options，不落盘、不发送模型。账号失效时整体隐藏。

- `demo.start{goal,siteIds,mode}`先确认1—3个授权站点；mode为mock_browser或compatible_browser。与采购、模型任务、站点和模型配置变更互斥。自动打开首站；登录/MFA仅人工接管。
- `demo.observe{id,siteId}`重新打开/观察所选站点；`demo.act{id,siteId,action:{type,ref,value?}}`仅接收当前观察的fill/select/白名单只读click。名称/角色必须唯一并可复用，敏感控件/查询值在动作前拒绝，每次动作自动重新观察。
- `demo.handoff{id,siteId}`、`demo.resume{id}`：登录操作不记录；resume只继续本次进程仍存活的示范，重建观察，不使用旧ref。
- `demo.finish{id,confirmed:true}`需至少一次成功操作和最新非登录结果；逐个重读已打开站点，内容或结构变化则刷新视图并要求再次核对。完成后可由原有agent.skill.save保存，编辑参数与重放沿用原契约。
- `demo.cancel{id}`与通用取消/退出/切身份清理原身份任务和会话。错误id不能取消另一条启动中的任务。IO与授权有操作时限，取消/撤权抑制迟到成功；完成写盘后的最终授权失败用仅可信主进程可调用的同attempt负向收尾，不暴露IPC、不修改已保存Skill的来源记录。
- AgentStore任务新增可选`execution:'demonstration'`，兼容既有schema。仅保存安全trace和步骤，不能从普通agent.resume接入模型。重启后遗留录制/接管示范转为interrupted，用户直接重新示范，原记录保留；不承诺复原原生网页操作或旧会话。

自定义站点可执行哪些操作仍由浏览器策略决定；未配置只读点击规则的自定义站点不会因人工示范自动开放按钮。示范是在工作台中选择允许的控件，不监听或录制网页中的任意手势。

## 只读重放的有界引用恢复

已保存Skill的本机步骤重放不创建模型requester，不要求模型配置、任务文本/页面外发同意；账号授权、精确站点与修订校验保持。新建兼容模型任务仍须模型配置和逐次双同意。

- replayRecipe仅对当前动作抛出的STALE_REFERENCE重新观察并重定位一次；此前成功操作不重复。重新观察后必须唯一匹配原角色/名称，不能凭相似文字猜测，也不自动改写原Skill。
- 来源变化、撤权、取消、写入策略拒绝、网络/未知回执及模型错误不自动重试。重试前后均复验上下文；再次过期即停止。
- 登录页交给用户处理；显式继续仍按新观察安全重放，不宣称跨登录/进程保留精确业务状态。末尾有动作未读取的站点须重新观察；不能沿用旧页面宣布完成。
- 任务可选replay元数据：stepIndex（0-based）、total（1—100）、tool、siteId、retries（0/1）、state（executing/recovering/completed/awaiting_user/failed）、可选reason（STALE_REFERENCE/PAGE_STRUCTURE_CHANGED/LOGIN_REQUIRED）。仅绑定Skill任务可写，站点必须属于任务，拒绝额外字段、页面、ref。
- 每次成功和恢复尝试采用当前attempt写回；resume与重开遗留运行清除旧进度。恢复步骤单独记录在steps，UI区分执行步骤与重新观察尝试。

## 推广服务运维与部署预检（2026-11-07）

本机管理员CLI新增backup <新目录>、restore <备份目录> <新数据目录>、reset-password <邮箱>。与既有命令使用相同仓库外配置解析，restore直接使用显式参数。管理工具不监听HTTP，也不把管理动作开放到工作台IPC。

- backupService({dataDir,backupDir})使用SQLite一致性快照，限定promotion.sqlite与service-backup.json，验证SHA256/integrity/schema，128MiB上限。外部密钥/配置不备份，数据库本身仍属敏感运营数据。
- restoreService({backupDir,targetDir})只写新目录，不改原服务；撤销所有session、清verification、pending转uncertain并保留quota。正式切换时必须停止原服务，不能把两份额度库并行对外。
- resetAccountPassword({dataDir,email,password})仅可信本机调用；scrypt参数与服务一致，新盐/CAS更新，撤旧session/挑战，不改变verified/enabled/用量。CLI密码仅stdin两次输入，交互不回显；操作者须事先人工核实身份。
- inspectReadiness({configFile,publicUrl})只读配置与文件元数据；不读取密钥内容、不联网、不创建目录。ready/checks只证明配置和运行时条件，DNS/TLS/ACL/真实模型/恢复演练仍需人工验收。

## 固定配方模型验收入口（2026-11-07）

公共规划题库与纯评分模块只覆盖purchase_plan。runModelEvaluationCLI默认offline：不读取配置/密钥、不构造真实请求，报告not_run/scorePercent:null/networkRequests:0。live必须同时明确--live --allow-paid --config（仓库外模型配置）--max-requests，预算在读取配置前校验；每题仅一次，失败占尝试数，止损错误停止后续调用。

输入仅task/month/signal，预期答案只在本地评分；报告区分requestsAttempted/networkRequests/覆盖率，不回传原始模型输出或秘密。CLI不执行浏览器工具；离线通过或固定规划得分不代表真实模型、页面理解或生产业务验收。

## M6 记忆、统一工具、结果验证与有限修正（2026-11-13，A/B 阶段）

本节只描述本机合成验证过的接口，完成状态以[唯一工作清单](PLAN.md)和[测试报告](TEST_REPORT.md)为准，不代表真实模型或生产业务验收。

- `snapshot.memory`返回`{revision,available,entries,settings}`；未登录、OS加密不可用或账号撤权时整体隐藏。载荷使用现有加密适配，存于仓库外`memory/<company>/<user>/state.json`，单写者原子替换与CAS revision；每条含kind、status、source、siteBindings、有效期及版本。`pauseRestoredMemory`只在恢复时把条目置为paused，不解密也不启用；`forget`级联清除所有历史版本、候选与派生载荷并保留最小删除标记；备份沿用精确白名单，不导出整个用户目录。
- `memory.save{id?,kind,title,content,siteIds,expiresAt?,expectedRevision?}`、`memory.enabled`、`memory.confirm`、`memory.settings`、`memory.forget`、`memory.preview{query,siteIds,includeEpisodes?}`、`agent.history.clear{before,confirmed}`。候选默认proposed不生效；本机关键词检索先按可信身份、状态、有效期、站点及修订过滤，最多5条/约1500输入Token，不建立明文索引、不引入外部向量库。结构白名单与敏感内容检查拒绝凭据、URL内嵌账号、网页正文、提示注入及伪造字段；扫描只是辅助，不宣称能识别所有秘密。记忆只作为本次任务的不可信DATA，不授予站点、模型或企业权限。
- `agent.start`新增`consent.memoryIds`（最多5条，须`consent.memory===true`）、`budgetOptions.maxModelRequests`（1—12）与`enableReflection`。`contextProvider`逐条取出本人已选记忆，请求前后复验身份、记忆revision及模型来源/配置revision；切换身份、模型或记忆修订即丢弃旧上下文，不把旧模型对话静默转发。已保存Skill重放不携带记忆、不构造模型requester、不要求页面外发同意。推广服务consent白名单同步接受`memory/memoryIds`，仅校验字段，不接收记忆正文。
- 现有四工具由`createBrowserToolRegistry`/`createToolExecutor`统一注册执行：严格输入/输出schema、执行前后授权复验、串行调用、由可信执行器生成证据ID，结果状态为succeeded/failed/uncertain/awaiting_user/denied。界面、模型或网页不能注册工具实现；不新增任意Shell、HTTP或JS执行；登录、凭据与MFA仍由可信主进程和人工接管；普通工具继续拒绝业务写入。
- `createTaskBudget`及store的`claimBudget/beginBudget/finishBudget`跨attempt累计模型请求、轮次、工具数、主动时间、修正与复核次数及输入Token估算；默认8次模型请求、12轮、45秒、1次修正、1次复核，Skill的modelRequests上限为0。继续或重启不刷新额度，旧任务缺budget以`AGENT_BUDGET_LEGACY`拒绝恢复。
- `verifyTaskResult`独立于模型措辞检查必要站点覆盖、动作后重新读取与页面证据。内建合成站点按月份做确定性校验返回verified；其他开放式网页任务为needs_review，任务进入`awaiting_review`，须经`agent.confirmResult{id,confirmed:true,expectedAttempt}`明确核对后才转为completed；`store.saveSkill`拒绝未完成或未核对结果的任务。工具循环返回的是任务状态，写入步骤时必须映射为合法步骤状态，不能把任务级状态直接落盘。
- B阶段错误分类：`classifyRecovery({code,effectState,correctionsUsed})`现由`runBrowserToolLoop`与`replayRecipe`共同调用，只返回`repair_once / handoff / stop`。仅`effectState==='not_started'`且`correctionsUsed===0`的`STALE_REFERENCE / INVALID_BROWSER_ACTION / AGENT_TOOL_INPUT_INVALID`允许一次修正；登录/MFA交人工接管；撤权、取消、越权/写入确认、来源或模型配置变化、提供方/额度/费用/限流/超时、未知回执、页面结构变化与预算耗尽一律停止。`onBudget`返回主进程累计预算，`used.corrections`为跨attempt唯一裁决依据，确定性引用恢复与可选模型复核不再各开一套计数；相同问题码或修正后重复同一调用立即以`AGENT_CORRECTION_NO_CHANGE`停止。
- 可选模型复核：仅在`agent.start.enableReflection===true`时启用，每任务最多一次，先预留`correction`与`reflection`预算，再向当前请求追加结构化反馈消息；反馈只含安全错误码、站点ID和限定指令，不含页面正文或模型推理。修正后的每个动作仍经过原工具schema、执行前后授权复验与`Verifier`；完成状态仍由独立验证决定，模型复核不能单独升级为"已验证完成"。
- 结构化修正记录：`task.reflections`最多5条，字段严格限制为`id / problemCode / evidenceIds / proposedCorrection / checkResult / nextAction`；`proposedCorrection`仅`REOBSERVE_CURRENT_SITE / CORRECT_TOOL_INPUT / NONE`，`checkResult`仅`pending / verified / needs_review / rejected`，`nextAction`仅`reobserve / deliver / await_user_review / stop`。证据ID来自可信执行器；记录不含网页正文、模型思维链或自由文本，`onReflection`在修正开始与复验结束时各写一次，任务卡展示问题、动作与复验结果。store按字段白名单校验，拒绝伪造字段、页面文本与超量；继续任务保留记录，迟到或取消后的结果不得落盘。
- 脱敏经验候选：`snapshot.memory.settings`新增独立开关`rememberLessons`（默认关闭，与`rememberEpisodes`分别控制）。仅本人已完成、存在`verified / needs_review`复验记录、且开关打开时，控制器才用安全错误码与复验结论生成一条`kind:'lesson'`候选；`confirmed:false`即`proposed`，7天未确认清理，必须`memory.confirm`后才生效。同一运行ID不重复生成；候选不能自动修改永久Skill、白名单、预算或权限，也不能作为可信业务规则。候选是尽力而为，保存失败不影响任务完成。W27的摘要检索、失效冲突与Skill推荐、以及真实模型/业务效果对照仍按[清单](PLAN.md)保留。
