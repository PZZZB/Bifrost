# Bifröst 网关与账号池

2026-11-01。管理界面和 Runtime 根据**当前连接的网关**返回的能力自动装配，不需要选择 Mac、公司内网或其他部署模式。账号池、接入用户与管理员是三种不同身份。

## 运行结构

```mermaid
flowchart LR
  UI[统一管理页] --> Admin[本机管理 API]
  Config[当前节点配置] --> Runtime[按实际启用的适配器装配]
  Runtime --> Pool[上游账号实例注册表]
  Admin --> Pool
  Pool --> Providers[各类型的授权与协议适配器]
  Providers --> Catalog[带实例归属的模型目录]
  Client[Codex / CodeBuddy / 其他客户端] --> Ingress[协议入口]
  Ingress --> Policy[调用者权限与余额校验]
  Policy --> Route[精确模型路由]
  Route --> Providers
  Catalog --> Ingress
  Admin --> Users[接入用户、Key 与账本]
```

- **上游账号池**管理提供模型的账号：名称、类型、启停和运行状态。不会创建客户账号或变更客户余额。
- **接入用户**管理使用本站服务的人、个人 Key、模型权限和余额。公司网关没有启用用户服务时，不显示这一区域，也不额外启动用户监听。
- **客户端接入**管理本机 Codex 的官方／网关连接配置。当前客户端登录从账号池移出；这一能力只在实际具备集成服务的节点显示。
- **管理员**继续使用本机回环管理会话、HttpOnly Cookie 和 CSRF；注册用户和普通模型 Key 没有管理权限。尚未实现独立管理员用户名登录。

当前 Mac 只装配受管 Claude 和既有用户服务，不再启动无关的 Codex RPC、CodeBuddy、Cursor 授权及目录查询。账号池只列隔离 Claude。公司 Windows 仍用原来的 Bifrost 快捷方式／`Start-Bridge.ps1`，管理页显示它自己配置的账号；可添加 Bifröst 用户来源，将 Mac Claude 合入原有模型列表。

## 模块与唯一配置

| 模块 | 职责 |
| --- | --- |
| `src/upstream-account-store.mjs` | 持久实例元数据、旧配置导入、原子写入、锁和 revision 冲突检测 |
| `src/upstream-accounts.mjs` | 实例管理、类型能力、安全快照、模型归属和请求启停校验 |
| `src/main.mjs` | 根据已登记账号装配已有授权与协议适配器，不把页面可见性当运行隔离 |
| `src/runtime/server-remotes*.mjs` | 远端 Bifröst 凭据引用、独立 Provider 生命周期与目录 |
| `src/model-policy.mjs` | 保留旧模型 ID、选择和权限，向管理页提供绑定账号的目录 |
| `public/account-pool.js` | 按服务端实际实例和可添加类型渲染列表、详情和创建表单 |
| `src/server.mjs` | 原管理会话保护下的节点／账号 API；不具备的旧管理能力不可调用 |

Server 的账号元数据统一保存在私有 `upstream-accounts.json`，不再与 `remote-sources.json` 双写。实际凭据仍由原适配器持有，不集中复制密码或 Token。示例仅展示无密钥的元数据：

```json
{
  "version": 1,
  "revision": 0,
  "accounts": [{
    "id": "legacy-claude",
    "kind": "claude",
    "name": "隔离 Claude",
    "enabled": true,
    "binding": { "slot": "Claude" },
    "createdAt": "2026-11-01T00:00:00.000Z"
  }]
}
```

远端记录的 `binding` 包含固定 HTTPS 用户 API、来源编号、协议及不透明 `credentialRef`。管理响应不返回该引用、凭据路径或完整 Key。Windows Key 继续用当前用户 DPAPI 加密；没有安全存储能力时不降级保存明文。浏览器中的 Key 只用于提交创建，随后清空，不进入 URL 或持久浏览器存储。

首次启动导入旧来源引用和已存在的本机账号槽位；保留原文件、授权和加密记录供回滚。存在规范配置时不回退读取旧配置；文件损坏则拒绝加载，不覆盖重建。重启保留实例 ID、名称和停用状态。写入先取得私有目录锁，再重新读取磁盘校验 revision；失败不修改内存快照。进程被强制结束遗留锁时，只能确认没有配置写入进程后再清理。

## 类型能力与当前边界

| 类型 ID | 当前上限 | 授权与新增方式 |
| --- | --- | --- |
| `codex` | 1 | 独立 Codex 订阅目录；添加后空闲重启，再进入原授权流程 |
| `codebuddy` | 1 | 原员工 OAuth 和安全存储；Windows 可添加 |
| `cursor` | 1 | 原 SDK／账号授权和安全存储；Windows 可添加 |
| `claude` | 1 | 当前受管隔离环境；由运行配置登记，页面不复制登录或创建假实例 |
| `with` | 1 | 已配置的旧 With 兼容适配器，不混同于 Mac Claude |
| `bifrost` | 8 | 固定 HTTPS 用户 API＋个人 Key；各实例独立凭据、目录和生命周期 |

类型列表由节点支持的适配器与安全存储能力决定，页面不提供不可用类型。新来源先保存配置，经原服务的空闲重启载入；创建成功不等于已授权或推理通过。未就绪显示“待重启加载”或“待授权”，不会伪装成第二个可用账号。

停用立即阻止**新请求**并从客户端发布目录移除；已接受的本机调用可以按原生命周期收尾。停用远端实例同时关闭它的 Provider；再次启用需空闲重启。停用不删除账号、Key、模型选择或账本。并发页面提交旧 revision 返回 409，不能覆盖新配置。

未知套餐额度显示“上游未提供可靠余额”，不显示为 0，也不由 Token 统计估算。远端用户额度以远端账本为准，与公司套餐或本站客户余额分开。

## 模型与请求边界

管理目录为每个模型返回 `sourceAccountId` 和显示名称；改名不改变实例或模型 ID。保留原来的 `B-*`、CodeBuddy、Cursor、`Claude-*` 和 `remote/<来源>/<模型>` 别名。模型开关与账号停用分别保存：停用账号不会永久关闭其模型偏好，保存可见模型选择也不会清除未加载来源的旧选择。Mac 的模型开关同时控制其用户入口。

每次请求只进入精确登记的来源。公司流量留在公司；选择远端 Claude 才发送到 Mac。远端只使用该用户的 Key，不携带公司登录或管理凭据。故障、零余额、限流和断线不回退到其他账号。工具由发起请求的客户端执行，状态继续绑定原来的用户、会话、来源、模型和授权版本。

当前只统一了实例元数据、装配、发布归属与开关。原生 A/B、CodeBuddy、Cursor 的成熟协议分支继续保留；尚未全部改成一个通用 ModelRouter。既有用量／诊断记录仍主要按渠道和准确模型区分，不改写历史。需要独立凭据与生命周期的同类多账号，以及全面的实例级用量／授权版本迁移，需后续分别实现；当前不开放超过适配器能力的实例数。

虚拟机的 VPS 出口、DNS、IPv6／UDP 限制和无直连回退保持原配置。账号池仅引用既有受管接口，不提供任意命令、路径或宿主端口转发。支付验收继续暂停，公开充值保持关闭。

## 当前管理 API

所有接口仅在本机管理会话下可用，写操作另外校验 CSRF、Origin、空闲重启状态和字段白名单。

```text
GET  /api/node                       节点能力与管理会话校验值
GET  /api/upstream-account-types     类型、容量和授权方式
GET  /api/upstream-accounts          安全实例快照与绑定模型
POST /api/upstream-accounts          按类型创建（本机官方授权或远端用户 Key）
POST /api/upstream-accounts/:id      revision + name / enabled
GET  /api/model-settings             当前节点模型与已保存选择
POST /api/model-settings            revision + disabledModels
```

`/api/client-admin` 继续独立管理下游用户和账本。原类型授权接口作为兼容编辑器保留，页面只在选中对应实例时打开。新增账号不能通过表单提供凭据文件路径或执行命令。

## 验证与更新

自动测试覆盖旧配置导入、多个远端独立引用、损坏配置拒绝、并发冲突、磁盘写入失败回滚、停用与恢复、模型选择、请求不回退，以及管理会话／CSRF／Origin 边界。隔离进程测试实际启动 `src/main.mjs`：不给可执行 Codex、残留外部渠道配置仍只加载 Claude；停用和重启后保持测试用户原 Key、余额及模型偏好。

浏览器验收使用真实管理服务与前端、隔离存储和模拟 Provider 元数据，检查页面操作、动态类型、重命名转义、停用恢复、无手动环境切换及 360px 布局。它不代替 Windows DPAPI 或公司员工账号的现场验证。真实用户入口另在 Mac 更新后核对，不将模拟上游结果说成真实推理或支付验收。

部署前备份代码与私有状态；空闲关闭唯一写入进程后更新，再由原监督服务恢复。回滚使用旧代码与备份配置，不并行启动第二份生产用户账本进程，不重新发 Key 或重复增加余额。
