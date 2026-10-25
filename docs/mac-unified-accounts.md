# Mac 注册页与主干账号统一

代码维护在主干。启用 `BRIDGE_MAC_CLAUDE_CONFIG=/absolute/private/mac-claude.json` 后，`src/main.mjs` 的 ClientAccess、ClientBilling、ClientAdmin 和 `/account/` 共用同一进程中的对象。禁止多个进程分别加载并写入同一 JSON：各实例的内存快照会互相覆盖。

```
微信浏览器 → 国内 HTTPS 443 隧道 → 127.0.0.1:43158
  /account/、动态 bfk_ key → 127.0.0.1:43159 → 同一账号 / 权限 / 计费
  模型调用 → 固定 127.0.0.1:43157 → 原隔离 Claude 路径
本机管理员 → 127.0.0.1:43155/#clients → 同一账号 / 权限 / 计费
```

43155 不经隧道代理。43159 仍只监听回环。外部入口仅转发明确的网页与模型路径，拒绝管理、CONNECT、Upgrade、任意目标、重复认证头和跨站模型请求。旧静态客户端 key 保留原路径与限流，它属于手工配置的兼容凭证，不是网页用户，不冒充已迁移用户账目。

`mac-claude.json`：

```json
{
  "version": 1,
  "upstreamPort": 43157,
  "gatewayKeyFile": "/absolute/private/gateway.key",
  "sessionKeyFile": "/absolute/private/External/session.key",
  "webAccountsFile": "/absolute/private/External/WebAccounts/config.json"
}
```

文件属于服务用户，权限 0600。原网页配置继续提供 origin、CSRF key、API 地址和默认容量 / 速率，不再决定账号库。`BRIDGE_STATE_DIR` 内的 `client-access.json`、`client-billing.json` 是唯一有效用户及账本文件。`client-gateway.json` 显式配置 127.0.0.1:43159、全部允许 Host 和主 HTTPS origin。外部 `gateway.json` 删除 `webAccountsFile`，添加 `"clientGatewayPort": 43159`；该字段不能与旧网页 / 微信账号配置同时启用。

Mac 服务使用独立的 `BRIDGE_CLIENT_CODEX_HOME`，不要指向日常 Codex 的目录。普通用户运行，launchd 管理后台及异常恢复。部署和维护不要把生产配置或账号库提交到仓库。

## 切换前验证

先创建并校验加密备份。停止旧外部入口与所有账号管理命令，重新读取用户、邀请码及 key 数量，确认没有切换期间的新注册。

当前提供的迁移脚本**只接受空旧用户库和唯一已知邀请码**，保留该码及截止时间，并转为主干的凭证摘要方案：

```sh
node scripts/migrate-empty-web-accounts.mjs /private/WebAccounts/config.json /private/WebAccounts/owner-invitation.json /private/UnifiedAccounts --writers-stopped
```

已有用户、未知邀请码或已存在目标文件时拒绝迁移。旧用户密码参数与 key 摘要方案不同，不能仅复制 JSON 或哈希后宣称 key 兼容；必须另做迁移及逐项验证。旧库写入迁移标记后，旧 WebAccountStore 与管理 CLI 拒绝操作，避免继续生成无效邀请码；回滚时先停止新写入者并核对新用户和账目，不能覆盖切换后的生产数据。

迁移后的新用户立即出现在主干本机“接入用户”中。新注册默认没有模型权限，只有邀请中明确选定的模型可以继承；未完成 Claude 登录时目录为空。管理员可分配模型、停用、撤销 / 续期 key、设置 Token 配额及余额限制。默认 key 授权 30 天；费率、充值及余额限制须管理员明确设置，默认只计量。

网页继续使用相同 Cookie / CSRF 校验及邮箱 DNS 检查，邮箱所有权始终未验证。主干使用其既有 scrypt 参数 N=32768、r=8、p=1、64 字节摘要；旧独立库参数不混用。网页 key 轮换原子撤销此用户全部旧 key。重新登录最多保留主干允许的 16 个会话，停用或改密码使所有会话失效。

推理在接收正文后、预留落盘后再次检查权限。Chat 流向固定上游请求最终 usage；客户端可能收到额外 usage 事件。Messages 使用实际协议用量。计量缺失、断流或重启保留待核对状态，不能按零费用完成。会话经私有 HMAC 绑定用户与客户端会话，账号间不能共用上游会话。注销删除登录及 key 记录，已有计费凭证按随机账号编号保留用于对账。

离线测试：`node --test tests/unified-web-accounts.test.mjs tests/mac-claude-client.test.mjs tests/client-billing*.test.mjs`。测试采用模拟上游，不登录或调用真实 Claude；真实模型推理必须在本人完成 Claude 登录后另验收。
