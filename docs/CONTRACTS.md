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

本分支不包含企业OIDC和HTTP共享适配器；本文相关契约保留为跨版本设计参考，实际代码在`codex/enterprise`。个人注册服务、模型配置与执行器保留，公司Mock仅作合成测试。详见[版本说明](EDITIONS.md)。
