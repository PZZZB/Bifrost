# Windows 个人混合网关

Desktop 运行在公司 Windows 电脑，客户端只连接 `http://127.0.0.1:43160/v1`。同一个 `/v1/models` 列表合并公司 CodeBuddy 和远端 Bifrost 的可用模型，直接选模型即可，无需切换内外网模式或客户端地址。

| 可见模型示例 | 实际请求路径 | 额度与权限 |
| --- | --- | --- |
| `local/codebuddy/CodeBuddy-<model>` | 客户端 → 本机 Desktop → 公司 CodeBuddy 的实际接口 | 公司员工授权及公司上游额度 |
| `remote/bifrost/Claude-sonnet` | 客户端 → 本机 Desktop → Mac Bifrost → 隔离 Claude | 本人的普通 Bifrost 用户 Key、模型权限及 Mac 账本 |

具体模型以账号授权和来源就绪情况为准。相同模型名可以同时出现，ID 和显示名称标明来源；不能把“本机转发”理解为已确认腾讯接口的所有网络流量都处于公司内网。架构与边界见 [混合网关架构](hybrid-gateway-architecture.md)。

## 初始化与公司授权

需要 Windows 和 Node.js 22.15 或更新的受支持版本。在此仓库目录中运行：

```powershell
npm ci
npm run desktop -- init
npm run start:desktop
```

初始化生成独立本地 API Key，显示一次并用 Windows 当前用户 DPAPI 保存。把这个 `bdk_` Key 填给本机客户端；以后可用 `npm run desktop -- key` 在本机查看。保留启动窗口，另开 PowerShell 完成公司授权：

```powershell
npm run desktop -- login
npm run desktop -- status
```

登录命令会打开现有员工 OAuth 官方授权页，由本人完成登录。目录在后台每 15 秒刷新，刷新不发推理请求；状态读取使用当前快照，不等待另一来源。也可主动刷新：

```powershell
npm run desktop -- refresh --source codebuddy
```

初始配置只有公司来源；不会读取远端 Key、联系 Mac 或要求 Mac 注册。Desktop 复用员工授权及协议模块，不启动 Server 的账号注册、余额账本、Codex RPC、VM 或隧道。

## 加入 Mac 来源

先在现有 Mac 网关注册普通用户，获得本人 `bfk_` API Key，并由管理员分配模型权限。公司电脑选择远端模型时，该 Key 与其他用户一样接受 Mac 的停用、限额、密钥轮换及计费规则；管理身份与使用身份分开。

按 Ctrl+C 停止本地 Desktop，然后运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Configure-DesktopRemote.ps1
```

依提示填远端 API URL 和本人用户 Key，Key 输入隐藏，不放进命令参数、剪贴板或明文配置。当前 Mac 的模型 URL 可从注册页复制；它与网页地址可以不同。模型 API 地址应以 `/v1` 结尾，例如 `https://gateway.example.com/v1`。

重新启动：

```powershell
npm run start:desktop
```

客户端仍填写同一个本地 URL 和本地 `bdk_` Key。Mac 已就绪且本人有权访问的模型会自动加入同一列表。列表刷新由客户端控制；部分客户端需要手动刷新模型目录。未登录 Claude 或没有模型权限时，远端列表为空，不生成虚假的占位模型。

远端的原生协议仍默认声明 Chat Completions、Messages；Desktop 现已通过通用适配器，将远端 Messages 转为 Responses，让 Codex 可以调用。Mac 服务器本身无需改变，适配不增加一次推理或第二本账。公司来源继续复用现有三种协议适配。

## 接入 Codex

先保持 Desktop 正在运行，在另一个 PowerShell 中启动 Codex CLI：

```powershell
npm run desktop -- client codex
```

它使用临时 Provider 参数，模型和目录均指向同一个本地网关，不写日常 Codex 配置、账号登录、审批或沙箱设置。首次从当前可用模型中选默认项，之后在 Codex 模型选择器直接选择本地或远端模型。Windows 启动器直接定位原生 `codex.exe`，避免脚本 shim 改坏参数引号；若自动定位失败，可将 `CODEX_BINARY` 指向已安装的 `codex.exe`。需要传 Codex 参数时放在第二个 `--` 后，例如：

```powershell
npm run desktop -- client codex -- --model remote/bifrost/Claude-sonnet
```

Codex 使用原生 `model_catalog_url` 读取合并列表，而不是把通用 `/v1/models` 当作 Codex 目录。来源每 15 秒独立刷新；Codex 自己有目录缓存，来源变化后可能需要刷新模型列表或重新启动客户端。

如果使用 Codex 桌面 App 或 IDE 扩展，可先生成本机适用的原生配置：

```powershell
npm run desktop -- client-config codex
```

输出无秘密的 TOML 配置项，需合并到该客户端实际使用的用户级配置根层，不能盲目附加到已有 TOML 表格中或覆盖其他设置。配置以 `auth.command` 调用当前 Node 和本地 `desktop.mjs key`，仅获取本地 `bdk_` Key；不把 Key 写进 TOML、命令参数或永久环境变量。移动仓库或 Node 路径后应重新生成。不同 Codex 界面和版本读取配置的时机仍需现场确认，可能需要重启。

可先运行 `npm run verify:desktop-codex` 检查已安装版本的目录、认证及完整协议能力；它使用临时目录和模拟上游，不登录真实账号、不消耗模型额度。客户端扩展机制见[客户端适配边界](client-adapters.md)。

## 配置、凭据与状态

私有目录默认为 `%USERPROFILE%\.bifrost-desktop`，可通过 `BIFROST_DESKTOP_STATE_DIR` 指定。公开形态见 [`config/desktop.example.json`](../config/desktop.example.json)。配置只含端口、来源编号、类型和固定远端 HTTPS URL，不接受内嵌 Key 或监听地址。

- `identity.dpapi.json`：本地 Key 与状态封套密钥。
- `remote-<source>.dpapi.json`：该远端的普通用户 Key，独立 DPAPI namespace。
- `sources/<source>/`：该公司来源自己的 CodeBuddy OAuth 与思考状态密钥。

这些是网关自己创建的凭据，不读取其他软件的登录密钥。DPAPI 绑定当前 Windows 用户；不能把加密文件拷到另一台电脑或另一用户后当成可直接复用的登录。其他系统当前明确拒绝启动，不保存明文替代品。

已鉴权本地状态为 `GET /desktop/status`，只返回来源状态、客户端适配列表、合并模型快照和进行中的请求数，不包含上游 Key、主机地址、请求正文或对话记录。第一版配置使用 CLI；网页设计、来源设置界面及 Windows 自动启动可后续接入，当前不会修改已有网页 UI。

## 调用边界与故障

- 仅监听 `127.0.0.1`，严格校验 Host；API 需要本地 Key，拒绝浏览器 Origin、跨站请求、管理代理、CONNECT 和 WebSocket。
- 推理按登记模型唯一分派。请求正文、metadata、转发请求头和模型前缀不能指定网络目标。
- 本地公司调用不联系 Mac 的推理接口、不传公司凭据给 Mac、不写 Mac 账本。混合部署会独立查询 Mac 模型目录，这与发送对话内容不同。
- 远端调用仅使用本人 Mac Key，TLS 校验开启，拒绝重定向；Mac 继续唯一预留、结算。Desktop 不重复扣费或维护余额副本。
- Mac 不可达或目录请求卡住时，本地目录和推理仍可用。本地 401、403、429、超时及断流不会自动转去 Mac，推理也不自动重放。
- 当前并发上限为 4，超过返回 429、“本地网关繁忙，请稍后重试”和 `Retry-After: 2`。调用方自行决定重试，不应自动重放已开始的推理。
- 带 `X-Session-Id` 的会话绑定具体模型及授权；切换来源或换号需要新建聊天。没有该头时，状态封套与既有 Chat 工具缓存仍隔离。不要把一个来源的工具或隐藏状态直接搬到另一个模型。
- 支持 SSE、背压及客户端取消；Messages 分片思考签名完整汇合后再加封套，保留上游终态和用量。

## 验收状态

`node --test tests/desktop-*.test.mjs` 使用真实 HTTP 回环监听和既有 CodeBuddy 协议适配器，配合模拟公司/远端上游，验证合并目录、三种本地协议、单次远端分派、凭据与状态隔离、故障不回退和取消传递。

上述离线测试没有登录真实公司账号，也没有消耗模型额度。另已用当前 Mac 的实际 Codex 程序完成合并目录、命令式认证、两种来源的真实本地工具往返和加密状态接续。2026-11-01 又在 Mac → VM relay 上完成真实 Claude 验收：Sonnet／Opus 文本、Chat SSE、客户端工具请求和同会话结果续接均通过，见 [VM 验收记录](mac-claude-vm.md#登录与验证)。公司 Windows 的 DPAPI 真正往返、员工登录、真实内网路由及额度、桌面客户端模型展示，以及通过公司本地网关调用远端 Claude 的完整链路仍需现场验收；Mac 后端通过不能代替公司环境验收。
