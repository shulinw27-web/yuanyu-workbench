# 账号与推广服务运维

本页用于开发者部署独立账号/推理服务。当前没有部署到公网，也没有在本轮调用真实或付费模型。唯一工作清单及需要用户准备的事项维护在[PLAN](PLAN.md)。

## 部署准备与预检

运行环境统一要求Node.js 24及以上。仓库提供三个待修改的样例：

- [service.example.json](../deploy/service.example.json)：每账号默认10万Token/月、20次请求/天；全局预算故意为0，提供方和模型是占位符。
- [Caddyfile.example](../deploy/Caddyfile.example)：HTTPS反向代理到本机15334端口，域名尚未配置。
- [yuanyu.service.example](../deploy/yuanyu.service.example)：Linux systemd服务模板，用户、路径和写目录需由部署者创建。

将服务配置复制到仓库外，填写真实数据目录、提供方、模型ID和密钥文件路径。密钥值只放服务器的独立文件，不写进JSON、Git或聊天。明确设置你批准的全局月Token预算；它是调用量限制，不是固定人民币费用上限。

```bash
# 先将以下占位域名和配置路径替换为你控制的真实值。
export YUANYU_PROMOTION_CONFIG=/etc/yuanyu/service.json
export PUBLIC_ORIGIN=https://accounts.example.invalid
npm run readiness -- --config "$YUANYU_PROMOTION_CONFIG" --public-url "$PUBLIC_ORIGIN"
```

预检不会联网、试调用模型、读取密钥内容或创建数据目录。它检查运行时、配置结构、HTTPS入口格式、仓库外路径、文件元数据、个人额度和全局预算。样例未经修改时应当返回`ready:false`；退出码0表示配置完整，1表示未就绪，2表示命令参数不正确。

通过预检后仍需实际配置DNS、80/443防火墙、TLS、服务账号及文件权限，并独立验证真实模型连接。Linux样例尚未在目标服务器部署；Windows文件ACL需要人工核实。反向代理后当前登录/注册IP限流按后端连接地址统计，试点前需验证并发容量，不能把配置预检当压力或生产安全验收。

确认配置后运行`npm run service`，或由你安装并启动systemd模板。普通启动不调用模型。桌面端的`product.local.json`应指向你的真实HTTPS入口，并设置`allowLocalDemo:false`、`autoStartLocalDemo:false`。

## 账号验证与人工找回

当前可先采用开发者人工核实账号的运营方式。`verify`标记已验证，`disable`停用账号并撤销旧会话，`enable`不会复活旧会话。

```powershell
$env:YUANYU_PROMOTION_CONFIG = 'D:/YuanyuService/service.json'
npm run service:admin -- list
npm run service:admin -- verify user@example.com
npm run service:admin -- disable user@example.com
npm run service:admin -- revoke user@example.com
npm run service:admin -- reset-password user@example.com
```

`reset-password`只能由服务器本机运营者在人工核实本人身份之后执行；工具本身不证明邮箱所有权。交互输入两次新密码，至少12位，输入不回显；不得把新密码追加到命令行或放在环境变量中。自动化调用只接受标准输入的两行一致密码，不会在输出中返回密码、盐、散列或会话令牌。

重置使用新的scrypt盐与散列，撤销所有旧会话，清除旧验证挑战，要求重新登录；不会启用停用账号、替未验证账号完成验证，也不会重置已用/预留额度。重置时尚在处理的旧会话推理不能返回迟到成功。

自助邮件验证、邮件找回、用户数据删除及留存期限仍需确定运营方案并继续接入，不能把人工CLI视为这些功能已上线。

## 一致性备份

桌面工作区备份不包含运营账号库；运营服务必须独立备份。以下命令使用同一`YUANYU_PROMOTION_CONFIG`的数据目录：

```powershell
# 备份目录的父目录须已存在，目标快照目录必须是全新目录。
npm run service:admin -- backup D:/YuanyuBackups/snapshot-2026-11-07
```

备份通过SQLite `VACUUM INTO`生成一致性快照，可以在服务WAL活跃、请求处理中执行；原服务不会被关闭。目录仅包含`promotion.sqlite`和`service-backup.json`，检查SHA256、数据库完整性和表结构，大小上限128MiB。不复制提供方配置、外部API密钥或浏览器数据。[SQLite官方说明](https://www.sqlite.org/lang_vacuum.html#vacuuminto)

数据库仍含邮箱、密码散列、会话散列和模型响应缓存，属于敏感运营数据。文件尝试限制为仅本人访问；备份的加密存储、异机保管、访问权限和保留周期需由运营者落实，不得上传到公开仓库。

## 恢复演练与正式切换

```powershell
# 只恢复到全新目录，绝不覆盖原库。
npm run service:admin -- restore D:/YuanyuBackups/snapshot-2026-11-07 D:/YuanyuService/restored-data
```

恢复会校验清单、哈希、文件类型、路径与数据库模式，撤销所有旧会话、删除验证挑战，将处理中请求转为`uncertain`并保留对应额度预留。用户须重新登录，同一不确定请求不会自动再次调用上游。

恢复只生成新数据库，不会修改原服务或自动切换流量。正式切换前停止原服务，核对恢复时间点、账号和额度，再将服务配置改为新数据目录并启动。不要让原库和恢复库同时对外服务，否则会形成两个独立额度副本。恢复点之前/之后发生的密码或额度变化需要核实；从备份恢复不能证明所有最新业务状态已保留。

## 尚待真实环境验收

公网注册、账号验证运营、客户端跨电脑登录、提供方限额与总预算、故障后的恢复切换、数据留存和隐私说明，都需要在你提供的真实环境中完成。配置文件和离线测试通过只证明本地实现，不代表已完成这些验收。

## 模型验收准备与调用预算

公共题库位于`src/model/planning-cases.json`，共14题，覆盖固定采购资料规划、月份冲突、含混任务和禁止审批/付款/写入等情况。先运行：

```powershell
npm run model:eval -- --offline
```

离线模式只验证题库；输出应为`not_run`、评分`null`、`networkRequests:0`。它不读取模型配置或密钥，不代表真实模型通过。

真实评测入口已经接到现有兼容网关，但本轮未执行。只有你确认提供方、模型和费用预算后才运行下面形式的命令：

```powershell
# 可能产生真实费用；此处model.local.json是模型配置，不是service.json。
# 先在仓库外按使用指南填写模型配置，再决定实际请求上限。
npm run model:eval -- --live --allow-paid --config D:/YuanyuService/model.local.json --max-requests 3
```

每题最多尝试一次，错误也占尝试预算；身份、额度、限流、超时、配置或取消错误会停止后续题目，不自动重试。模型只收到题目任务/月参数，不收到预期答案；报告只显示题目编号、结构检查/评分和安全错误码，不打印原始回复或密钥。报告同时区分尝试数与实际网络次数，并显示覆盖率；只跑部分题不能当作完整通过。

该题库仅测试固定采购配方的规划，不执行浏览器、不验证网页理解，也不证明任意业务或生产质量。真实浏览器效果和用户期望结果仍需独立验收。
