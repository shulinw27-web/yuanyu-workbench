# 元域工作台 Agent Harness 架构设计 v1（重构轨）

> 设计台账：2026-11-17 · yuanyu-workbench · v1 · 轨道=重构 · 审计材料=docs/PLAN.md、docs/CONTRACTS.md、docs/TEST_REPORT.md、docs/EDITIONS.md、README.md、src/model/tool-loop.mjs、src/tools/registry.mjs、src/tools/executor.mjs、src/model/gateway.mjs、src/agent/budget.mjs、src/agent/context.mjs、src/agent/verifier.mjs、src/browser/interactive.mjs · 独立评审：通过（两轮闭环——第一轮 5 通过/3 存疑已回修/0 证据不足；复审 4 通过/0 存疑）

## 0. 需求规格与已拍板决策

| 维度 | 内容 | 状态 |
|---|---|---|
| 目标与用途 | 企业个人用户跨系统重复工作 + 可核对交付物；个人开源版本地优先 | 已确认（物料） |
| 成功标准 | R01–R13 验收；合成回归 276/276；真实效果对照未开始 | 已确认（物料） |
| 验收来源 | 确定性校验（合成站）+ 人工核对 + 独立盲测题库（offline 已通，live 未跑） | 已确认（物料） |
| 任务结构 | 预设采购配方（零模型）/ 通用浏览器任务 / 示范录制→Skill / 附件多模态 | 已确认（物料） |
| 数据/资源边界 | 仓库外 dataDir、DPAPI、站点/路径白名单、PID 映像锁 | 已确认（物料） |
| 硬约束 | Electron 43.7.9 + 受控 IPC、页面无 Node、Node≥24、不自动重试费用/限流 | 已确认（物料） |
| 用户与场景 | Windows 桌面个人用户、BYOK 模型 | 已确认（物料） |
| 边界（不做什么） | 不业务写入（默认拒）、不任意手势录制、不适配任意网站、视频附件拒、不接 MCP | 已确认（物料） |
| 技术栈约束 | 原生 HTML/JS、零框架、SQLite 仅运营服务 | 已确认（物料） |
| 模型策略与成本 | 单一 BYOK profile（Chat Completions 兼容）；预算 8 请求/12 轮/45s/1 修正/1 复核 | 已确认（物料） |
| 效率与体感 | 45s 墙钟、可中断、无流式、缓存维度未设计 | 已确认（物料） |

**用户拍板决策（2026-11-17）**：
1. 范围 = 全景审计 + W14（真实模型接入）/ W15（工作流归纳）聚焦架构；W13/W16–W18 作边界适配项映射。
2. 模型组合 = 形态 A（单智能体 + 单 BYOK 模型）+ 任务-模型分派表 + 预留分档缝（opt-in）。
3. 智能体形态 = 保持单智能体；E 层增加受控并行工具调用（替代清单③）。
4. 版本范围 = 仅个人开源版；W16 身份桥仅作文档化预留。

**默认假设（可推翻）**：
- 假设 1：并行批量上限取 3（与站点选择上限 1–3 对齐），不是 5。
- 假设 2：压缩触发阈值默认 256KB（文本消息，不含首条附件消息），可配 64KB–1MB。
- 假设 3：归纳预算独立档 {modelRequests:3, rounds:6, tools:30, activeMs:90000}。
- 假设 4：BYOK 提供方 usage 的 cached token 字段各家不一，未报告时如实记 null，不推测。

---

## 1. 现状映射表

| 维度 | 现状实现 | 证据 | 备注 |
|---|---|---|---|
| E 执行循环 | `runBrowserToolLoop`：有界只读循环；maxSteps 8–12、maxModelRequests 8–12、timeoutMs 45000（AbortController 硬墙钟）；**单工具调用/轮**（`tool_calls.length!==1` 即拒）；终止由 `verifyResult` + `executor.canComplete(requiredSiteIds)` 裁决；错误仅一次修正额度（`reflect`），其余抛错终止；打转检测仅修正重复（`correctedCall` 指纹） | tool-loop.mjs L10–98 | 防跑飞三道保险（轮次/预算/超时）齐；无并行；错误回喂窄 |
| T 工具注册 | 4 工具封闭集（`BROWSER_TOOL_NAMES` 冻结序）：open/observe/act/handoff；closed JSON-schema 子集校验（`matchesToolSchema`）；`consent.pageContent` 单独授权 observe（注册≠披露≠授权成立）；输出消毒（`sanitizeBrowserText`）+ 输出 schema 校验 + ≤30000B + ref 唯一；凭证绝不进工具层（登录/MFA 走 handoff 人工） | registry.mjs L8–93 | 目录 4 条，远低于延迟加载阈值 |
| C 上下文管理 | messages：system（任务内固定）+ user（任务+附件 parts）+ user（workingContext 记忆≤6000B，标记 DATA）+ append-only assistant/tool 对 + 修正反馈尾部追加；尺寸检查 14MB；**无压缩/摘要**（上下文只增，靠预算截断）；**前缀稳定靠结构惯性而非显式契约**；workingContext 带 memoryRevision 失效检查 | tool-loop.mjs L21–22,51,92；context.mjs | 外部内容消毒达标（untrusted data 标记+sanitize） |
| S 状态存储 | 按身份 `agents/<company>/<user>/state.json`；单写者队列 + 原子替换 + PID 映像锁；attempt/budget claim-begin-finish 跨次累计；checkpoint 不存页面正文/推理；遗留 running→interrupted；附件落盘 600 权限 + 篡改拒绝；写入端口幂等键=审批 id | store.mjs（CONTRACTS）；budget.mjs | 会话恢复≠外部行动恢复已按"只读+幂等写入+回执核对"处理 |
| L 生命周期/安全 | `invoke()` 全局授权复验；身份切换重建/撤权即拒；consent 逐次（taskText/pageContent/memory 每任务每请求）；HITL：计划确认、外发同意、写入指纹确认、登录/MFA handoff、结果 awaiting_review 人工核对；模型配置指纹前后复验 | controller/main/gateway | 四档 HITL 实际齐全但未成文对照 |
| V 评估接口 | `verifyTaskResult`：必需站点覆盖 + 脏站点重读 + 页面健全性；合成站确定性判 verified，开放网页 needs_review→人工 confirm；模型自评完成被系统提示显式拒绝；`model:eval` 离线题库+独立评分模块（14 题，offline 已通） | verifier.mjs；evaluation.mjs | 验证强度=确定性规则（阶梯最高档）+人工兜底 |
| 范式 P | 扩展方式=嵌入式（封闭工具集，安全优先）；配置=声明式（站点/模型/记忆）+ 命令式控制器；部署=单机（运营服务不在桌面范围）；编排=中心化单智能体（与采购执行互斥）；能力供给=内置 + 用户 Skill（数据配方，非代码） | 全局 | 用户 Skill=受控动作轨迹，是本项目特有供给形态 |
| 模型组合现状 | 单一 BYOK profile 全步骤共用（规划/工具循环/修正反馈）；无分派表、无级联、无自动降级（失败即停，符合"不自动重试"政策）；Skill 重放零模型；推广额度桌面不接入 | gateway.mjs | 单档可辩护（步骤异质性当前低） |
| 框架外现状 | 预设采购配方（零模型管线）；示范录制（人工示范→Skill）；Mock 公司共享（IPC 层，无 UI）；运营服务（账号/额度，服务端保留） | 全局 | 归纳（W15）与真实模型验收（W14）为未开发项 |

## 2. 缺口清单

| # | 缺口 | 定级 | 判据来源 | 证据 |
|---|---|---|---|---|
| 1 | C 层无压缩/摘要策略：当前量级核算（12 轮 × ≤3×30KB 工具输出 ≈ 1.1MB 文本上限，距 14MB 拒绝线有 >10× 余量）下**收益低**；保留已设计规格但**条件触发、默认不实施**（触发条件见 §4.3.2）——独立评审回修：原"W15 前置风险"定级的量级依据不成立 | 优化（回修：风险→优化） | C 层必答 Q2/Q8；efficiency-and-caching「何时不用：会话极短勿付工程复杂度」 | tool-loop.mjs L51–52、L92；registry.mjs L60（输出 ≤30000B） |
| 2 | E 层错误回喂窄：除一次修正额度外错误直接终止；瞬时读取失败（网络/页面加载）无法作为观察回喂模型知情重试——W14 真实模型任务成功率受损 | 风险 | E 层必答 Q4；生产级 E 层"错误必须回喂" | tool-loop.mjs L74、L77 |
| 3 | W14 真实模型验收未接线（live 盲测未跑、每任务成本无核算） | 风险（路线图） | oracle 维度；模型组合必答 Q2 | TEST_REPORT：live not_run；gateway 丢弃 usage |
| 4 | W15 归纳无架构：示范→自然语言归纳→新流程执行未设计 | 风险（路线图） | task 维度 | PLAN W15 未勾 |
| 5 | 缓存纪律未显式化：append-only 结构天然适合前缀缓存，但无成文契约、无序列化确定性断言、无命中率/成本观测 | 优化（成本相关） | 生产级 C 层；经济性·缓存 | gateway.mjs L123–127 只返回 message，usage 丢弃 |
| 6 | 多站点读取串行：每站点独立 BrowserWindow 已具备并行条件，但循环单调用/轮导致墙钟浪费 | 优化 | E 层必答 Q8 | tool-loop.mjs L67；interactive.mjs L148/L215（Map 每站一窗） |
| 7 | 打转检测窄：仅修正重复检测，无通用"连续相同失败调用"检测（预算紧是兜底但非显式） | 优化 | E 层必答 Q5 | tool-loop.mjs L70 |
| 8 | 无任务-模型分派表与级联升级条件记录（单档可辩护但须显式质疑留痕） | 优化 | 模型组合必答 Q1/Q3 | gateway 单 requester |
| 9 | budget caps 单档：45s/8 请求不适配归纳场景（多步骤+归纳请求） | 优化 | E 层；模型组合 | budget.mjs L6 caps 常量 |
| 10 | 人工纠正次数统计口径未文档化（M6 真实对照验收依赖该数据） | 优化 | V 层必答 Q4 | store 有终态与步骤数据，口径未定义 |

**定级说明**：无阻断级（系统可用、276/276 全绿、生产级七项无确定性故障）；无成本浪费级（大量步骤已是确定性代码，不存在模型档位错配——单模型即单档）。

## 3. 重构决策卡

**改什么**（按 缺口定级与迁移顺序）：

| 步 | 改动 | 覆盖缺口 | 量级 |
|---|---|---|---|
| M-D1 | 前缀稳定契约成文 + 序列化确定性回归断言（零行为变更，先立护栏） | 5 | 小 |
| M-D2 | 错误回喂分级（A 类瞬时错误观察回喂 + B 类修正保持 + 打转指纹扩展） | 2,7 | 中 |
| M-D3 | 并行工具调用（observe 异站并行 + 非并行批量降级串行） | 6 | 中 |
| M-D4 | usage 透传 + 每任务成本核算（budget v2 / checkpoint 白名单扩展 / 任务卡展示） | 3,5 | 中 |
| M-D5 | 分段压缩（**条件触发，默认不实施**；中段摘要，头部前缀不动，失效记账——见 §4.3.2 触发条件） | 1 | 设计就绪/实施延后 |
| M-D6 | W14 验收接线（model:eval live 报告含成本；人工纠正统计口径文档化） | 3,10 | 小 |
| M-D7 | W15 归纳管线（induct.mjs 新模块 + recipe 严格 schema + 确定性试运行 + 用户确认） | 4,9 | 大 |

**不改什么（克制清单，及理由）**：
- 4 工具封闭集与 closed schema 子集——安全核心，T 层审计达标。
- consent 逐次机制、撤权复验、身份切换隔离——L 层是产品价值观且已达标。
- 单写者存储/PID 映像锁——刚修复白屏缺陷（M7/W31），不动。
- `verifyTaskResult` 确定性阶梯 + 人工兜底——V 层长处，不引入模型自评。
- 不接 MCP/第三方工具供给——边界（物料明确）。
- 不做自动级联重试——与"不自动重试费用/限流"政策一致；级联设计默认关。
- 不上多智能体——三条硬墙均不命中（上下文 12 轮内极小、无实测退化证据、4 工具目录不存在选错问题）；替代清单③（循环内并行工具）由 M-D3 承接。

**迁移顺序**：M-D1 → M-D2 → M-D3 → M-D4 → M-D6 → M-D7；M-D5 为条件触发项，不阻塞任何后续步（独立评审回修：取消 M-D7 对 M-D5 的原依赖——归纳管线为短会话小输入，量级核算见 §2 缺口#1）。依赖关系：M-D1 是全部 C 层改动的护栏（先行）；M-D2 先于 M-D3（并行批量的部分失败合并依赖 A 类回喂与 executor 锁粒度改造）；M-D7 依赖 M-D2（归纳失败回喂复用 A 类路径）与 M-D6（归纳质量验收依赖盲测口径）。每步可独立验证并单独回滚，见 §4 风险表。

## 3.5 架构范式 P（目标）

| 子维度 | 决策 | 理由 |
|---|---|---|
| 扩展方式 | 嵌入式（封闭工具集，安全优先） | 4 工具封闭 + closed schema 是安全核心；W15/W17 扩展走版本化 schema + 站点策略白名单，不开插件面 |
| 配置方式 | 声明式（站点/模型 profile/记忆设置/loop 参数）+ 命令式控制器 | 现状保持；新增 `loop.parallelToolCalls`/`compactThresholdBytes` 进声明式配置 |
| 部署拓扑 | 单机（本机 Electron） | 个人开源版范围；运营服务不在桌面范围 |
| 编排模式 | 中心化单智能体（controller 串行互斥） | 多智能体裁决见 §5/§6：不上 |
| 能力供给形态 | 内置工具 + 用户 Skill（数据配方，非代码）+ 归纳配方（M-D7 产出数据） | 供给全部为"数据"而非"代码"——本项目特有形态，天然不可执行任意逻辑 |

## 3.6 技术栈选型（不变项）

| 项 | 选型 | 理由 |
|---|---|---|
| 语言 | JavaScript（ESM，零 TypeScript） | 现状；项目无构建链，语法检查靠 `npm run check` |
| 运行时/框架 | Node.js ≥24（v24.14.1 验证）+ Electron 43.7.9 | 现状；受控 IPC + 每站独立 BrowserWindow 是并行工具的既有条件 |
| 关键依赖 | node:fs/promises、node:crypto、AbortController/AbortSignal.any、Map | 全部标准库/平台能力，新增模块零新依赖 |
| 运行环境 | Windows 桌面（DPAPI 加密路径） | 现状；macOS/Linux 同等验证未做（物料边界） |

---

## 4. 目标架构六层设计（可编码规格）

### 4.1 E 执行循环

**设计决策**：
1. **并行工具调用（收紧式）**：模型一次响应可含 1–3 个 `tool_calls`。仅当全部调用为 `browser_observe` 且 siteId 两两不同时并行执行（有界池=调用数，每站独立 BrowserWindow 已具备条件）；其余合法多调用按返回顺序**降级串行**执行（保留单调用语义逐个走现有路径）；>3 个即 `AGENT_TOOL_REJECTED`。`browser_act`/`browser_handoff` 永不并行（页面状态依赖 + fresh_observation 约束）。
2. **错误回喂三分类**（扩展 `classifyRecovery`，新增第四个动作 `feed_back`）：
   - **A 类（观察回喂）**：`BROWSER_TIMEOUT`、`BROWSER_READ_FAILED`、`BROWSER_OPERATION_FAILED`、`BROWSER_NOT_OPEN` 且**失败工具为 `browser_open`/`browser_observe`**（纯读效应工具）——失败作为 tool 消息观察回喂（含错误码+重试提示），模型知情决策下一步；**不消耗 corrections 额度**，但计 rounds/tools 预算，天然有界。这不是 harness 自动重试，与"不自动重试费用/限流"不冲突（MODEL_* 费用/限流类仍 C 类立即终止）。**effectState 修正（独立评审回修）**：A 类成立的工程前提是 `src/tools/executor.mjs` 的 `provenNotStarted` 白名单扩展——open/observe 失败（上述四码）判定为 `not_started`（纯读无副作用）；`browser_act` 失败保持 `may_have_occurred`（点击可能已落点）→ 走 B/C 类路径（保守）。
   - **B 类（修正额度，现状保持）**：`STALE_REFERENCE`/`INVALID_BROWSER_ACTION`/`AGENT_TOOL_INPUT_INVALID` 走现有 `reflect()` 一次修正。
   - **C 类（立即终止，现状保持）**：费用/限流/鉴权/撤权/越权/写入拒绝/上下文变化/预算耗尽/页面结构变化/未知回执；含 `AGENT_TOOL_BUSY`（锁冲突，M-D3 后仅同站并发才会出现）。
   - A/B/C 分类表数据化于 `recovery-policy.mjs`，不写死在循环里。
3. **打转检测扩展**：维护 `lastFailureFingerprint`（name+arguments 指纹）；连续两次相同失败指纹 → `AGENT_LOOPS_DETECTED` 终止；任何成功或不同调用即重置。
4. 墙钟预算、三道防跑飞保险、可中断（bounded/AbortSignal）——现状保持。

**落地规格**：
- `runBrowserToolLoop` 签名新增 `parallelToolCalls=true`（布尔，可关以回滚）。
- **executor 锁粒度改造（M-D3 前置，独立评审回修）**：`src/tools/executor.mjs` 现为全局 busy 串行锁（`if(busy)throw fail('AGENT_TOOL_BUSY')`），直接并行 invoke 会立即锁冲突终止。改为**站点粒度锁**：`browser_open`/`browser_observe` 按 siteId 加站点锁（异站可并发）；`browser_act`/`browser_handoff` 取全局互斥锁（且要求站点锁空闲）。锁为内存态、随 attempt 生命周期，不落盘。
- 工具消息协议：assistant 消息含 N 个 tool_calls（原样保留），随后 N 条 tool 消息按 `tool_calls` 数组序对应（`tool_call_id` 匹配）——顺序固定即确定性序列化。A 类失败的 tool 消息 `content=JSON.stringify({error:code, effectState:'not_started', hint:'The page read failed without side effects. You may retry this read or choose another allowed action within the remaining budget.'})`。
- 并行执行：并行批经站点锁允许后 `Promise.allSettled` 包裹各 `bounded(executor.invoke(...))`；部分失败合并——成功的照常入消息，A 类失败入错误观察，B/C 类失败中断该批（已成功的 tool 消息保留后走对应错误路径）。
- 串行降级批：逐调用走现有单调用逻辑；批内任一 B/C 类错误即终止该批剩余调用。
- 预算：并行/串行批内每次 invoke 计一次 `tools`；批计一次 `rounds`、一次 `modelRequests`。
- system 提示追加一句：`You may include multiple browser_observe calls for different sites in one response to read them concurrently. Sequence browser_act one at a time.`（进稳定区，随 `PROMPT_VERSION` 递增）。

### 4.2 T 工具注册

**设计决策**：封闭集不动；披露顺序契约成文（`BROWSER_TOOL_NAMES` 冻结序=披露序）；W15/W17 动作目录扩展预留 = 新动作类型必须先扩 `actionSchema` + `BROWSER_TOOL_VERSION` 递增 + 站点策略（interactive-policy）白名单裁决，维持注册≠披露≠授权链。第三方供给（MCP）明确不做。

**落地规格**：
- `browserToolDefinitions` 返回顺序断言进 M-D1 回归测试（两次调用字节相同）。
- `descriptor()` 的 `retryPolicy:'no_automatic_retry'` 语义文档更新：A 类回喂是模型知情重试，非 harness 自动重试。

### 4.3 C 上下文管理

**设计决策**：
1. **前缀稳定契约（成文+断言）**：稳定区 = [system（版本化）| user（任务+附件）| user（workingContext 记忆，带 memoryRevision 失效）]；可变区 = append-only assistant/tool 对 + 尾部修正反馈。禁令：稳定区禁时间戳/随机 id/集合遍历序；序列化确定性=同语义必同字节（对象字面量固定键序、工具定义冻结序）。`PROMPT_VERSION` 常量记录进任务终态（可审计，提示变更即缓存失效依据）。
2. **分段压缩（条件触发，默认不实施——独立评审回修）**：**触发条件**（满足其一才实施 M-D5，且触发判定依赖 M-D4 观测数据）：① M-D4 观测显示真实任务文本消息字节持续 > 阈值（如连续任务 P95 > 128KB）；② 未来演进放宽轮次上限或引入多轮归纳-执行长会话。实施时规格：文本消息字节（排除首条附件消息）> 阈值（默认 256KB，可配 64KB–1MB；0=禁用）时，把最早的 assistant/tool 对段（保留最近 6 轮不动）替换为一条 synthetic user 消息，格式为 `Compacted summary of earlier steps (v1):` 前缀 + 模型生成的摘要正文（≤4000 字，走 gateway 校验）；摘要由主模型独立请求生成（同 requester）。压缩是中段重写（头部前缀不动）；每任务 ≤2 次，计 budget `compactions`；**二次压缩时，此前生成的 synthetic 摘要消息并入"最早段"可被再压**（总量仍受 ≤2 次约束——独立评审附注补充）。
3. **缓存与成本观测**：提供方 usage 透传（`prompt_tokens`/`completion_tokens` 跨提供方标准；cached 字段提供方各异、未报告记 null）；压缩/换 profile = 失效事件记账（失效字节数进 checkpoint）。
4. 外部内容消毒、workingContext DATA 标记、memoryRevision 版本化失效——现状保持。

**落地规格**：
- 新增 `test/context-stability.test.mjs`：同输入两次构造 messages/definitions → `JSON.stringify` 字节相等断言。
- 压缩实现在 tool-loop 内：`maybeCompact(messages, budget)` → 替换段构造 + `onCheckpoint({kind:'compaction', fromIndex, toIndex, bytesBefore, bytesAfter})`。

### 4.4 S 状态存储

**设计决策**：存储机制不动（单写者/原子/PID 锁刚验证）；扩展 budget schema v2（新增 `compactions` 键，limit 2）与任务终态 usage 汇总字段；checkpoint 白名单扩展 `parallel`（本轮并行 siteId 数组）与 `compaction` 事件。

**落地规格**：
- `budget.mjs`：keys 增加 `'compactions'`；`claimTaskBudget` kind 映射增加 `compaction→compactions`；schemaVersion 1→2，store 侧原子迁移（先例：workflow schema1→2），遗留 v1 视为 compactions:0。
- **caps 与归零规则 v2（独立评审回修——消除与现有校验的三处冲突）**：caps 从全局单档改为 **profile 分档天花板**：`caps={standard:{modelRequests:12,rounds:12,tools:100,activeMs:45000,corrections:1,reflections:1,estimatedInputTokens:14_000_000,compactions:2}, induction:{modelRequests:12,rounds:12,tools:100,activeMs:90000,corrections:1,reflections:1,estimatedInputTokens:14_000_000,compactions:2}}`；profile 默认 limits 低于 caps（induction 限 3 请求/6 轮/30 工具/90000ms/2M tokens/reflections 0/compactions 0）。现有规则"非 modelRequests 键 limits 不得为 0"扩展为 **profile 允许归零清单**：`zeroable={standard:['modelRequests','compactions'], induction:['modelRequests','reflections','compactions']}`（reflections:0/compactions:0 仅在声明档合法）；`validateTaskBudget` 按任务绑定的 profile 校验 limits ∈ [0（须在 zeroable）… caps[profile]]。
- 任务终态记录新增白名单字段：`usage:{promptTokens,completionTokens,cachedTokens}`（null=提供方未报告）、`promptVersion`、`compactions`。
- 归纳预算档：`createTaskBudget({maxModelRequests, skill, profile})`，induction 档默认 limits 见上。

### 4.5 L 生命周期钩子

**设计决策**：零功能改动；补**人在回路四档对照表**成文（这是审计达标项的显式化）：

| 档 | 动作 | 现状机制 |
|---|---|---|
| 自动执行 | 已同意站点内的只读 open/observe/act | 工具循环内执行 |
| 执行前确认 | 计划确认、任务文本外发、页面内容外发、记忆外发、写入指纹/期限、模型连接测试 | consent 逐次 + 预览确认 |
| 执行后告知 | 步骤状态 checkpoint、任务终态 | onUpdate/snapshot |
| 直接阻断 | 业务写入、凭据/OTP 工具填充、越权来源、跨身份 | 浏览器策略 + 工具校验 + invoke 复验 |

W16 桥接点（仅文档化预留）：身份提供方抽象 seam = `invoke()` 全局授权复验 + 身份切换重建；企业 OIDC/目录桥接沿用 CONTRACTS 契约，不在本设计实现范围。

### 4.6 V 评估接口

**设计决策**：确定性阶梯保持；W14 验收接线补两件事——盲测 live 报告含每题成本（usage 汇总），人工纠正统计口径文档化（M6 真实对照的数据定义）。

**落地规格**：
- `evaluation.mjs` live 报告新增字段 `costTokens:{promptTokens,completionTokens}`（每题+汇总）。
- 统计口径文档（进 TEST_REPORT 附录）：人工纠正次数 = awaiting_review 终态被用户拒绝次数 + handoff 次数（store steps 已有 status 数据）；修正次数 = budget.used.corrections；复现口径 = 每任务跑 ≥2 次。

## 5. 模型组合与任务分派表（形态 A + 分档缝）

- **形态判定**：A（单智能体 + 单 BYOK 模型）。显式质疑记录：任务异质性当前低（只读循环步骤单一、经验候选/摘要已是确定性代码），分档是条件触发优化非默认义务（依据：h-framework 模型组合四分类与形态判定规则）；但 W15 归纳将引入异质步骤，故预留缝。**为什么不是形态 B**：BYOK 单 key 体验更简单、月成本未实测（无分档必要性证据）；**为什么不是形态 C**：编排决策卡三条硬墙均不命中（上下文 12 轮内极小无退化实测、无并行推理需求只有并行工具需求、4 工具目录无选错问题），替代清单③由 M-D3 承接。
- **任务-模型分派表**：

| 步骤 | 档位 | 理由 | 成本/延迟预算 |
|---|---|---|---|
| 预设任务识别（task.plan） | 确定性代码 | 封闭答案集，不把关键词当 LLM 理解（PLAN 明文） | 0 token |
| 模型规划（proposeModelPlan） | 强力 LLM（用户主模型） | 任务理解开放推理，W14 主战场 | ≤1 请求/1200 max_tokens |
| 工具循环主推理 | 强力 LLM | 开放推理+工具选择+摘要 | 5 请求（默认 8 的 62.5%） |
| 修正反馈（reflect） | 强力 LLM（同模型） | 一次额度，单模型避免配置复杂度 | 1 请求 |
| 压缩摘要（M-D5） | 强力 LLM（同模型） | 同 requester 独立请求 | ≤2 请求（12.5%×2） |
| 修正分类（classifyRecovery） | 确定性代码 | 规则表封闭集 | 0 token |
| 经验候选/episode 生成 | 确定性代码 | controller 安全码+结论，非模型 | 0 token |
| 归纳（M-D7） | 强力 LLM | 配方归纳开放生成，严格 schema 校验 | induction 档 3 请求 |
| Skill 重放 | 确定性代码（零模型） | 现状，预算 modelRequests=0 | 0 token |
| 验证（verifyTaskResult） | 确定性代码 + 人工 | 阶梯最高档+人工兜底 | 0 token |
| 独立盲测（model:eval live） | 独立会话同一模型 + 确定性评分 | W14 验收，评分是代码非模型 | 显式 --max-requests，预算外独立 |

- **token 预算按档位分配**：默认 8 请求 = 主推理 5 + 修正 1 + 压缩 ≤2（评估/验证=确定性代码 0 token，不占模型预算；盲测预算独立显式）。estimatedInputTokens 14M 上限保持。
- **级联升级条件（设计成文，默认关）**：启用条件三重——月 token 支出超用户阈值（成本敏感）+ W15 后归纳/摘要步骤异质出现 + 用户主动配置第二 profile。触发后仅对"压缩摘要/归纳修正"步骤路由到辅助档；主推理不降档。级联升级率监控口径：`auxRequests/totalRequests`，超 30% 回查分派表。
- **降级链**：提供方错误（MODEL_RATE_LIMITED/PAYMENT/AUTH/PROVIDER_FAILED）→ C 类立即终止（不自动重试——政策）；用户手动切换 profile（profiles.mjs 多 profile 已支持）后显式重跑；Skill 重放不受影响（零模型）。
- **评估者档位与生成者关系**：产品内评估=确定性代码（便宜且独立）；W14 盲测=独立会话+确定性评分模块（生成会话与评分分离，评分不看生成过程只看答案）。
- **缓存与重算账**：append-only 结构命中提供方前缀缓存（M-D1 契约保障）；失效事件=压缩（中段，记 bytesBefore）、换 profile（全失效）、PROMPT_VERSION 递增（全失效）；观测=任务终态 cachedTokens 与 compactions 计数。

## 6. 多 Agent 编排（不适用 + 理由）

**不适用**。编排决策卡裁决记录（§5 形态判定已含，此处汇总）：
- 三条硬墙均不命中：①上下文退化——任务上限 12 轮/45s，无实测退化证据；②可丢弃新鲜上下文做并行——需要的是并行**工具调用**（M-D3 承接）而非并行**推理**；③工具选不对/指令冲突——4 工具封闭目录，无选择歧义。
- 替代清单五项：①上下文渐进披露（记忆按需≤5 条已实现）；②工具延迟加载（4 条不需要）；③循环内并行工具（M-D3）；④循环内多档模型（形态 B 缓，级联条件未触发）；⑤组合（M-D3+压缩）。
- **评估面（多 Agent 专属）**：N/A——无路由准确率/嵌套循环账/回传损失指标义务；单循环口径下以"调用了正确的工具+确定性验证通过"为验收面。

## 6.5 W15 归纳管线设计（新模块）

**管线五步**（模块 `src/agent/induct.mjs`，`export async function induceWorkflowRecipe({demonstration, goal, requestModel, budget, onCheckpoint, signal})`）：

1. **输入**：示范轨迹（demo 完成后的安全 trace：每步 `{siteId, action:{type,role,name,value?}}`——契约保证 trace 无页面正文/凭据）+ 用户目标文本（≤2000 字）。
2. **归纳请求**（主模型，induction 预算档）：system（归纳策略+schema 约束）+ user（轨迹 JSON+目标）。模型必须返回单个 `propose_recipe` tool call，走 `matchesToolSchema` 风格闭集校验，自由散文拒绝（`INDUCTION_OUTPUT_INVALID`）。
3. **确定性校验**：每个 step 的 siteId ∈ 示范站点集；action 的 (role,name) 必须在该站点被示范过；fill/select 值必须来自示范值或引用已声明参数槽（≤3 槽）。
4. **确定性试运行**：候选配方经 `replayRecipe` 在原站点重放一次（登录/MFA 照常 handoff）→ `verifyTaskResult` 确定性验证。
5. **用户确认**：任务卡展示配方步骤+试运行结果 → 确认后走现有 `agent.skill.save`（verified 状态）路径；参数化沿用 `agent.skill.edit` 契约（stepIndex+fill/select）。

**失败处理**：试运行失败 → 失败步骤+错误码回喂归纳器一次修正额度（复用 reflect 模式）→ 再试运行 → 仍失败终止（不自动改配方）。

**边界保持**：归纳产物=数据配方（动作序列），非代码；重放仍过工具 schema/站点策略/consent 全链；"任意手势录制/任意业务学习"仍在边界外（归纳的是工作台内示范动作）。

**recipe schema（闭集）**：
```
propose_recipe: {type:'function',function:{name:'propose_recipe',
  parameters:{type:'object',additionalProperties:false,
    properties:{
      name:{type:'string',maxLength:80},
      description:{type:'string',maxLength:300},
      steps:{type:'array',minItems:1,maxItems:30,items:{type:'object',additionalProperties:false,
        properties:{siteId:{type:'string'},action:{/* closed action schema: click/fill/select + role/name/value */},
          parameterSlots:{type:'array',maxItems:3,items:{type:'object',additionalProperties:false,
            properties:{name:{type:'string',maxLength:40}},required:['name']}}},
        required:['siteId','action']}}},
    required:['name','steps']}}}
```

## 6.7 模块 / 目录结构（改动骨架）

```
src/
├── agent/
│   ├── induct.mjs          ★新增 M-D7：归纳管线（请求→schema 校验→试运行→确认）
│   ├── recovery-policy.mjs  M-D2：classifyRecovery 增加 feed_back 动作与 A 类码表
│   ├── budget.mjs           M-D4/M-D7：schema v2（compactions 键、induction 档）
│   └── store.mjs            M-D4：终态 usage/promptVersion/compactions 白名单 + v1→v2 迁移
├── model/
│   ├── tool-loop.mjs        M-D2/M-D3/M-D5：并行批、错误回喂、打转指纹、分段压缩、parallelToolCalls 参数
│   ├── gateway.mjs          M-D4：requestBrowserModel 返回 {message, usage}
│   └── evaluation.mjs       M-D6：live 报告 costTokens
├── tools/registry.mjs        M-D1：披露顺序契约注释（行为不变）
├── tools/executor.mjs         M-D2/M-D3（独立评审回修新增）：站点粒度锁（observe/open 异站并发，act/handoff 全局互斥）+ provenNotStarted 白名单扩展（open/observe 四码→not_started）
├── controller.mjs            M-D7：agent.induct 动作通道（复用现有互斥/授权模式）
├── ui/app.js                 M-D4：任务卡成本展示；M-D7：归纳确认视图
└── ui/index.html             M-D4/M-D7：对应 DOM 挂载
test/
├── context-stability.test.mjs ★新增 M-D1：同输入两次构造→字节相同断言
├── recovery-feedback.test.mjs ★新增 M-D2：A 类回喂/打转/B 类保持
├── parallel-tools.test.mjs    ★新增 M-D3：异站并行/串行降级/部分失败合并
├── budget-v2.test.mjs         ★新增 M-D4：compactions 额度/迁移/usage 字段
├── compaction.test.mjs        ★新增 M-D5：阈值触发/头部不变/失效记账
└── induct.test.mjs            ★新增 M-D7：schema 校验/确定性校验/试运行失败→一次修正
```

**可编码三门槛自查**：①类型完整——§7 签名与 §8 数据结构逐字段定义（budget keys 枚举、usage 三字段可 null、checkpoint 白名单字段清单）；②API 真实——全部引用现有真实函数（`runBrowserToolLoop`、`classifyRecovery`、`claimTaskBudget`、`requestBrowserModel`、`replayRecipe`、`agent.skill.save`），错误码均取自源码提取的真实清单；③标准可达——每项改动附合成回归测试条目（上表），验证路径=现有 `npm test`/`npm run test:desktop` 流水线。

---

## 7. 关键接口签名（改动点汇总）

```javascript
// src/agent/recovery-policy.mjs —— classifyRecovery 返回动作集扩展
classifyRecovery({code, effectState, correctionsUsed})
  // 返回 {action:'repair_once'|'feed_back'|'handoff'|'stop', retry:boolean}
  // feed_back 类码表：BROWSER_TIMEOUT / BROWSER_READ_FAILED / BROWSER_OPERATION_FAILED / BROWSER_NOT_OPEN（effectState==='not_started'）

// src/model/tool-loop.mjs —— 签名演进（完整参数，其余现状保持）
runBrowserToolLoop({task, allowedSiteIds, requiredSiteIds=allowedSiteIds, consent, browser,
  requestModel, checkContext, onCheckpoint, onBudget, onEvidence, onReflection, verifyResult,
  workingContext='', enableReflection=false, signal, maxSteps=8, maxModelRequests=8,
  timeoutMs=45000, attachmentParts=[],
  parallelToolCalls=true,          // M-D3：可关以回滚并行
  compactThresholdBytes=262144})   // M-D5：0=禁用压缩（回滚开关）
  // 返回值新增：usage:{promptTokens,completionTokens,cachedTokens}|null、compactions:number

// src/model/gateway.mjs —— requestBrowserModel 返回值扩展
requestBrowserModel({messages,tools,signal})
  // 返回 {message, usage}（usage 映射：prompt_tokens/completion_tokens 标准；cached 取
  // prompt_cache_hit_tokens ?? cached_tokens ?? null——提供方各异，未报告记 null，不推测）

// src/agent/budget.mjs —— schema v2
createTaskBudget({maxModelRequests=8, skill=false, profile='standard'})
claimTaskBudget(input,{kind:'round'|'model'|'tool'|'correction'|'reflection'|'compaction', inputBytes=0})

// src/tools/executor.mjs —— M-D2/M-D3：锁粒度与 effectState 推导（独立评审回修复补）
createToolExecutor({registry, signal, checkContext, onBudget, onEvidence})
  // 内部变更1：busy 全局锁 → 站点粒度锁（browser_open/browser_observe 按 siteId 并发；
  //           browser_act/browser_handoff 全局互斥且要求站点锁空闲）
  // 内部变更2：provenNotStarted 白名单扩展——browser_open/browser_observe 失败的
  //           {BROWSER_TIMEOUT, BROWSER_READ_FAILED, BROWSER_OPERATION_FAILED, BROWSER_NOT_OPEN} → effectState='not_started'
  //           browser_act 失败保持 may_have_occurred（点击可能已落点，保守）

// src/agent/induct.mjs —— 新模块
induceWorkflowRecipe({demonstration, goal, requestModel, budget, onCheckpoint, signal})

// src/model/evaluation.mjs —— live 报告扩展
// 报告新增 costTokens:{promptTokens,completionTokens}（每题+汇总）
```

## 8. 核心数据结构变更

- **budget v2**：`keys=[modelRequests,rounds,tools,activeMs,corrections,reflections,estimatedInputTokens,compactions]`；caps 改 profile 分档（standard/induction 天花板，见 §4.4 权威规格）+ zeroable 允许归零清单；store 原子迁移 v1→v2（遗留 v1 补 `compactions:0`，归 standard 档）。
- **任务终态白名单新增**：`usage`（见上）、`promptVersion`（number，随代码常量）、`compactions`（number）。
- **checkpoint 白名单新增**：`parallel?:[siteId,...]`（≤3）、`kind:'compaction'` 事件 `{fromIndex,toIndex,bytesBefore,bytesAfter}`。
- **recipe 结构**（induct 输出，见 §6 schema）。

## 9. 配置文件格式（声明式，仓库外）

```jsonc
// 模型 profile（现有 model-profiles 结构不动），预留分档缝（默认缺省=形态A）
{
  "schemaVersion": 2,
  "activeProfileId": "deepseek-main",
  "profiles": [
    {"id":"deepseek-main","provider":"deepseek","baseUrl":"https://api.deepseek.com/v1","model":"deepseek-chat","apiKeyFile":"C:/Users/me/secrets/deepseek.key","dataScope":"selected_pages","enabled":true},
    // 可选辅助档（默认不配置；配置后也仅路由压缩摘要/归纳修正，见 §5 级联条件）
    {"id":"aux-cheap","provider":"custom","baseUrl":"https://compatible.example/v1","model":"cheap-model","apiKeyFile":"C:/Users/me/secrets/aux.key","dataScope":"task_text","enabled":false,"role":"auxiliary"}
  ],
  "loop": {"parallelToolCalls": true, "compactThresholdBytes": 262144}
}
```

## 10. 层间交叉检查

| 关系 | 说明 |
|---|---|
| E∥C | 多调用消息成对保序（N tool_calls ↔ N tool 消息按数组序）；压缩只动中段、头部前缀不动 |
| E∥S | 并行部分失败经单写者队列原子写回；批内每 invoke 计 tools；A 类回喂不改 attempt 语义 |
| T∥L | 新动作类型必须先过 actionSchema 扩展 + 站点策略白名单 + consent（注册≠披露≠授权链保持） |
| C∥V | 压缩不影响验证：V 只看 observations/evidence，不看 messages——已解耦，回归断言覆盖 |
| 模型组合∥E | 压缩/归纳请求共享任务预算（防预算外支出）；盲测预算独立显式 |
| S∥V | usage 统计绑定 profile 指纹（换 profile 分段统计，不混算） |
| E∥L | 并行批量内 handoff 触发即整批终止（awaiting_user 语义不变） |

## 11. 六层决策表

| 层 | 决策 | 依据 | 状态 | 有意不做（理由） |
|---|---|---|---|---|
| E | 收紧式并行 + 错误三分类回喂 + 打转指纹 | 六层必答 Q4/Q5/Q8；替代清单③ | 设计 | 流式输出（45s 短任务 TTFT 收益小）；动态脚本模式（任务结构固定） |
| T | 封闭集 + 披露顺序契约 + 动作扩展预留 | 目录 4 条远低于延迟加载阈值 | 设计 | MCP/第三方供给（边界）；任意动作（安全） |
| C | 前缀契约成文 + 分段压缩 + usage 观测 | 生产级 C 层；efficiency-and-caching 模式（prefix-stable/cache-aware-invalidation/deterministic-serialization） | 设计 | 全量重写压缩（缓存失效代价）；语义缓存（提供方前缀缓存已够） |
| S | budget v2 + 终态 usage + checkpoint 白名单扩展 | 模型组合必答 Q2（评估成本入预算） | 设计 | 数据库化（单写者 JSON 已验证）；WAL（无多写者） |
| L | 四档对照表成文 + W16 桥接预留 | 生产级 L 层；范围决策 4 | 设计 | 企业身份实现（范围外） |
| V | 确定性阶梯保持 + 盲测成本接线 + 统计口径 | V 层必答 Q1/Q3；oracle | 设计 | 独立模型裁判进产品（确定性规则+人工已覆盖；模型裁判仅用于本设计的独立评审流程） |
| P | 嵌入式 + 声明式配置 + 单机 + 中心化单智能体 + 内置/数据配方供给 | 现状审计 + 决策 3 | 保持 | 插件化（安全优先）；多智能体（硬墙不命中） |

## 12. 生产级必答项

| # | 必答项 | 结论 |
|---|---|---|
| 1 | 执行环境/凭证 | 工具在主进程受控执行；业务页面无 Node/IPC；凭证只在 DPAPI 凭据库与受控填充，**不进执行环境**（现状保持，审计达标） |
| 2 | 错误回喂 | A 类瞬时错误以观察回喂（M-D2）；B 类一次修正；C 类终止+错误码可查；分类表数据化，不吞异常 |
| 3 | 打转检测/熔断 | 修正重复检测（现有）+ 连续同指纹失败检测（M-D2）+ 三道防跑飞保险（现有） |
| 4 | 记忆治理 | proposed→confirm、7 天清理、失效/冲突 diff、版本绑定、级联遗忘——现状达标 |
| 5 | 外部副作用幂等 | 只读为主；写入端口幂等键=审批 id + 未知回执仅核对——现状达标；W17 真实回执适配为边界项 |
| 6 | 证据版本绑定 | siteRevision/memoryRevision/profile 指纹前后复验——现状达标；usage 绑定 profile 指纹（M-D4） |
| 7 | 生成者/评估者分离 | 产品内=确定性代码+人工；盲测=独立会话+确定性评分；本设计文档交付前走独立评审子智能体 |
| 8 | 前缀稳定与缓存命中 | 稳定区/可变区成文 + 序列化确定性断言（M-D1）；失效事件=压缩/换 profile/PROMPT_VERSION 递增并记账；命中率观测=cachedTokens/compactions（M-D4） |

## 13. 遗留问题与未知区（诚实标注）

1. **各 BYOK 提供方 usage cached 字段名差异**——知识库未收录各家字段名（DeepSeek `prompt_cache_hit_tokens` 为代码注释中已知一例）；落地时以提供方官方文档为准，未报告记 null。**独立评审确认：证据不足项**。
2. **附件 data URL 的提供方兼容上限**——14MB/5M 字符是否被所有兼容端接受未实测；W14 盲测时验证，超限走 gateway 拒绝（现有 `MODEL_INPUT_INVALID` 路径）。
3. **45s 墙钟对真实模型+真实站点够用性**——依赖 W13 环境适配（SSO/CDN）；本设计预算上限 60s 可配（timeoutMs 100–60000 现有参数），归纳档 90s（caps 分档后合法）。
4. **归纳质量依赖主模型能力**——形态 A 单模型归纳质量未知；W14 盲测与 W15 试运行验证交叉覆盖；若质量不足触发 §5 级联条件三重判定再上辅助档。
5. **前缀缓存实际收益**——各提供方前缀缓存计价倍数与门槛不写死（知识库纪律：不代厂商承诺）；收益以 M-D4 观测数据回填。
6. **多调用批量的模型行为差异**——真实模型是否稳定输出批量 tool_calls 未实测（合成 mock 先行）；M-D3 回归用合成多调用驱动。
7. **A 类码表的路径核对（独立评审回修补充）**——`BROWSER_READ_FAILED` 现出自 Mock 站管线（driver.mjs），交互真实站路径的瞬时错误码清单以实现时从 `src/browser/interactive.mjs`/`policy.mjs` 实际抛出为准提取；设计中的四码为已核实存在于 src/browser 的候选集，最终表以实现核对为准。
8. **M-D5 压缩实施时机**——默认不实施，触发条件与观测口径见 §4.3.2；若长期不触发，该规格保留为演进备件不进入迁移清单执行。

## 14. 参考架构图（文字）

```
UI（渲染层，无 Node）
  │  受控 IPC（invoke/onUpdate）
  ▼
Controller（中心化单智能体调度 · L 层：consent 逐次/撤权复验/身份切换）
  ├─ 预设采购管线（零模型，确定性）
  ├─ 示范录制 demo.*（人工示范 → 安全 trace）──→ induct.mjs（M-D7：归纳 → recipe → 试运行 → 用户确认）
  │                                                  │（induction 预算档：3 请求/90s）
  ├─ 通用浏览器任务 agent.start ──→ runBrowserToolLoop（E 层）
  │        │  messages（前缀稳定区 | append-only 可变区 | 压缩中段）
  │        │  tools：4 工具封闭集（冻结披露序）
  │        ├─→ 并行批（observe 异站 ≤3，M-D3）──→ 每站独立 BrowserWindow（受控会话）
  │        ├─→ 错误三分类（A 回喂 / B 修正 / C 终止，M-D2）
  │        └─→ requestModel（gateway：指纹锁定 + usage 透传 M-D4）
  │                  └─→ BYOK 兼容提供方（形态 A 单档；预留 aux 档缝）
  ├─ Skill 重放（零模型，确定性）
  ├─ verifyTaskResult（V 层：确定性规则 + awaiting_review 人工）
  └─ Store（S 层：单写者/原子/PID 锁/budget v2 跨 attempt 累计）
```

---

## 15. 独立评审记录

**第一轮（2026-11-17，独立上下文子智能体，评审范围=缺口定级 §2 + 重构决策卡 §3 抽查 8 项）**：
- 通过 5 项：D1（错误回喂窄=风险级）、D4（不改清单/编排决策卡使用正确）、D6（压缩模式对照贴切、"何时不用"被尊重）、D7（形态 A+分派表+级联默认关）、D8（无成本浪费级定级成立）。
- 存疑 3 项（已回修）：D2——压缩缺口"风险"定级量级依据不成立（12 轮域距 14MB 有 >10× 余量，W15 归纳为短会话小输入）→ 回修：定级降为优化、M-D5 转条件触发默认不实施、取消 M-D7 对 M-D5 依赖；D3——executor 全局 busy 串行锁使并行规格不可用 → 回修：executor.mjs 纳入改动骨架，站点粒度锁规格（observe/open 异站并发、act/handoff 全局互斥）；D5——A 类 effectState 条件与 executor 推导矛盾（四码均判 may_have_occurred，A 类永不触发）→ 回修：provenNotStarted 白名单扩展（open/observe 四码→not_started，act 保持保守）。
- D7 附注（不改判定）：budget v2 与现有校验三处冲突（caps.activeMs、归零规则、induction 档）→ 已随 §4.4 迁移条款显式声明（profile 分档 caps + zeroable 清单）。
- D6 附注（不改判定）：二次压缩时首条 synthetic 消息并入最早段可再压 → 已补进 §4.3.2。
- 证据不足 0 项（唯一无对照物处 §13.1 已自行如实标注）。
- 复审（第二轮）结果：见下。

**第二轮（同子智能体复审，范围=3 项存疑回修 + D7 附注条款）**：
- 复审通过 4 项（D2/D3/D5 回修 + D7 附注条款），仍存疑 0 项，证据不足 0 项。
- 量级核算被复核确认（12 轮 × ≤3×30KB ≈ 1.1MB vs 14MB，>10× 余量）；executor 站点粒度锁与循环层并行规则双层一致、AGENT_TOOL_BUSY 冲突消解；A 类推导链闭合（白名单扩展后四码可触发，act 保守保持）；budget v2 三处校验冲突全部消除。
- 一处文档一致性备注（§8 措辞与 §4.4 同步）已顺手对齐。
- **结论：两轮评审闭环，独立评审通过（第一轮 5 通过/3 存疑已回修/0 证据不足；复审 4 通过/0 存疑/0 证据不足）。**
