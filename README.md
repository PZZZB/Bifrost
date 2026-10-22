# Bifröst

Bifröst 是面向 Codex 与 Claude 的多渠道模型网关。Codex 支持账号 A/B 订阅分流与 CodeBuddy；Claude 支持第三方网关接入，按模型路由到独立 Claude CLI 订阅或 CodeBuddy。

当前 Codex 保持账号 A 登录，模型选择器保留原有模型，追加两个使用账号 B 订阅的模型及已授权的 CodeBuddy Opus 5.5。文件操作、终端命令、用户问答和权限确认继续由当前 Codex 执行。

| 选择的模型 | 推理账号 | 上游模型 |
| --- | --- | --- |
| 原有模型名称 | A，沿用原始 Provider 路由与授权 | 原模型名称 |
| `B-GPT-6 Astra` | B | `gpt-6-astra` |
| `B-GPT-6.1 Sol` | B | `gpt-6.1-sol` |
| `CodeBuddy Opus 5.5` | CodeBuddy 独立员工授权 | `claude-opus-5.5` |

两个新增模型的内部名称分别为 `B-gpt-6-astra`、`B-gpt-6.1-sol`。B 不可用时返回错误，不会改用 A。普通模型的请求不读取 B 的授权。

CodeBuddy 的内部名称为 `claude-codebuddy-opus-5-5`。启用并完成独立授权、目录就绪后，网关将它追加在 A/B 模型列表末尾；CodeBuddy 不可用时不会改用 A 或 B。原有 A/B 请求仍沿用原来的透传方式。

Bifröst 的名字取自北欧神话的桥，见《埃达》[Gylfaginning 第 13 章](https://heimskringla.no/wiki/Gylfaginning)。文件夹和 GitHub 仓库使用 ASCII 拼写 `Bifrost`。项目目录为 `D:\Bifrost`；运行数据继续使用 `~/.codex-account-bridge/`，账号授权仍保存在原位置。后台服务注册随项目路径更新，已有服务脚本文件名保持兼容。

运行依赖 Node.js 22.15+；Codex 后端使用官方 Codex CLI，Claude 订阅后端使用官方 Claude Agent SDK 与官方 Claude CLI。

## 启动

Windows PowerShell：

```powershell
& D:\Bifrost\Start-Bridge.ps1 -Open
```

启动器默认复用已有服务。更新代码后需要重启时，运行 `Start-Bridge.ps1 -Restart -Open`；桌面的 `Bifrost - Restart` 快捷方式使用此参数。等共用网关的当前任务结束后再重启。

也可在项目目录执行 `npm start`。Windows 下这两个入口均由当前用户的 `Bifrost` 后台任务启动或复用服务；任务由 Windows 任务计划程序托管，关闭启动终端或 Codex 桌面应用后继续运行，登录 Windows 后自动启动。管理页面默认是 <http://127.0.0.1:43155>。

首次运行会固定 Node 的绝对路径，并将官方 Codex CLI 二进制按 SHA-256 校验后保存在项目 `.state/runtime/codex/`；此处不保存账号凭证。原账号和网关配置继续使用已有目录。任务使用当前用户的登录身份，不保存登录密码；无限运行时限、异常退出后最多重启三次，间隔一分钟。后台配置位于运行数据目录的 `service/service.json`，日志仍为项目 `.state/server.log`、`.state/server-error.log`。

```powershell
& D:\Bifrost\scripts\AgentBridgeService.ps1 -Action Status
& D:\Bifrost\scripts\AgentBridgeService.ps1 -Action Restart
# 确认没有任务依赖网关后，才执行 Stop。
& D:\Bifrost\scripts\AgentBridgeService.ps1 -Action Stop
```

`npm run start:foreground` 用于前台调试，需要先停止占用同一端口的服务。后台任务采用 Windows 的[当前用户登录身份](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks)；注销 Windows 会结束该用户任务，与关闭 Codex 桌面应用不同。

Linux：安装 Node.js 22.15+ 和官方 Codex CLI 后，运行 `bash start.sh`。纯服务器可通过 SSH 转发管理和模型端口：

```bash
ssh -L 43155:127.0.0.1:43155 user@server
```

保持 SSH 连接，在自己的电脑打开 <http://127.0.0.1:43155>。浏览器登录使用的 1455 回调端口也需要指向运行 B 后端的机器，例如增加 `-L 1455:127.0.0.1:1455`。当前先交付本机版本；内网部署仍需在目标机器完成登录与验证。

## 接入

1. 在管理页点击“登录账号 B”，在 OpenAI 官方页面选择账号 B 及它的订阅工作区。
2. 核对管理页显示的邮箱和套餐，点击“确认此账号为 B”。
3. 点击“验证推理”。只有同一个网关返回 `response.completed` 和非空回复才算通过；模型列表不算验证证据。
4. 点击“接入本机 Codex”；已安装旧版本时点击“更新模型路由”。程序保留现有 Provider ID 和默认模型，配置网关地址、HTTP/SSE、独立网关认证头及模型目录地址。
5. 重启 Codex，使现有进程重新加载配置与模型目录。原有模型走 A，选择新增的两个 B 模型时走 B。

不在电脑前时，可点击“手机授权”。在手机浏览器打开页面提供的 OpenAI 官方设备授权链接，登录账号 B，再输入一次性设备码。电脑上的原生 Codex 会接收授权，无需把密码或验证码发给网关或聊天。个人账号需在 ChatGPT 安全设置启用设备代码登录，Team/Business 工作区可能需要管理员启用对应权限。手机授权无需转发本机 1455 回调端口。

管理页可“恢复接入前配置”。恢复只处理程序改过的四个字段，并检查它们有没有被其他程序或用户再次修改。旧版本的三个字段恢复值会在升级时保留。A/B 的模型请求都经过本机网关，请先恢复配置，再停止网关，以便后续 Codex 请求继续走原来的连接。

当前自动接入适配已经使用 `requires_openai_auth=true` 的自定义 Provider。本机当前配置符合这一条件。项目没有修改账户 A 的登录凭证，也没有复制 A 的聊天或登录文件。

## 登录与存储

- A：仍由现有 Codex 管理。
- B：官方 `codex app-server`，独立 `CODEX_HOME`。官方程序处理浏览器或设备码登录、保存授权和刷新。
- A 路由：从恢复信息重建原始 Provider 地址，保留客户端的 A 授权、工作区、请求正文与压缩字节，移除网关自己的认证头。
- B 路由：仅匹配两个明确别名；通过本机原生 RPC 在内存里取得 B 的有效授权，替换入站的账号授权和工作区头，将别名改成对应上游模型。工具内容和 SSE 响应保持不变。B 的授权不会交给浏览器、前端 Codex 或日志。
- 模型目录：保留 A 的完整目录，追加 B 的两份完整模型元数据，保留上下文、工具能力与推理选项。B 目录刷新有时间预算，B 离线不会阻止 A 的模型目录返回。
- 身份绑定：绑定 B 的账号及工作区；登录变化后暂停转发，重新核对后才能启用。
- 网关密钥：本机随机生成，和 B 的 OpenAI 授权分开。

运行数据默认在当前系统用户的 `~/.codex-account-bridge/`，不放进 Git。包含本机网关密钥、B 的独立 Codex 目录、配置字段的恢复清单，以及推理验证结果。验证记录仅保存短回复、账号标识和用量，不记录日常请求内容。网关在内存中保留最近 256 个会话的 A/B 路由计数、模型名和完成状态，以验证单个会话的请求归属；不保存日常请求正文或凭证。

## Codex 使用 CodeBuddy

在管理页完成 CodeBuddy 的独立员工授权后，部署当前服务并重启 Codex，选择 `CodeBuddy Opus 5.5`。已经接入本网关的 Codex 无需更改 Provider、账号 A 登录或网关密钥。CodeBuddy 与 Claude Messages 渠道共用现有授权和自动续期；此功能不依赖虚拟机。

Codex 发送 Responses 请求；网关转换为 Anthropic Messages，再复用现有 CodeBuddy Chat Completions 适配器。工具名称、命名空间、参数与结果在转换中保留，工具仍在当前 Codex 执行；自定义工具的完整原始输入封装为字符串传递。支持文本、内嵌图片、函数与自定义客户端工具、流式回复及后续工具回合。未适配的内容或字段返回明确错误。

CodeBuddy 使用 adaptive 思考，支持 `low`、`medium`、`high`、`xhigh`，默认 `high`。当前桥接上下文保守设为 200k、最大输出为 32768 token。隐藏思考和扩展元数据沿用现有加密、账号与模型绑定机制，经带 `bifrost-codebuddy-responses-v1:` 前缀的自有封套在 Responses 历史中续接；这不是 OpenAI 的加密凭证，也不会发送给 A/B。此模式暂不显示思考摘要。

OpenAI 托管的联网搜索、服务端压缩、服务端会话存储及结构化输出保证不在此适配范围。Codex 默认附带但未使用的 `web_search` 声明会被移除，同时明确告知模型此能力不可用；强制选择搜索或包含托管工具历史的请求会报错。模型仍可使用实际提供的客户端联网工具。系统及 developer 更新保留原顺序，以标记内容和顶层优先级说明转换；并行工具尚未全部返回时，更新随紧接的工具结果传递。

建议为 CodeBuddy 新建聊天。A/B 的 OpenAI 加密思考历史不能转换为 CodeBuddy 的接续状态；CodeBuddy 状态也不能转给 A/B，切换渠道遇到此类历史会提示新建聊天。普通本地总结继续通过 `/responses` 完成，不伪造 `/responses/compact` 的成功。

Token 统计合并 CodeBuddy 的 Codex 与 Claude 渠道，按真实上游 `usage` 记录；缺失分项保持未知，协议占位值不计入账本。管理页同时显示 Codex 入口和合计请求数。

可运行 `node scripts/verify-codebuddy-codex-offline.mjs` 做独立本地协议检查：它使用空白 Codex 配置、本地模拟上游和临时文件，不使用真实账户或发送模型推理。真实质量、实时模型权限和扣费仍需用户验收。

## 账号剩余额度

管理页并列显示 A、B 的官方剩余额度、重置时间、套餐、查询时间及可用的 Credits 余额。额度通过各自登录目录中的官方 `account/rateLimits/read` 查询，不发送模型请求；它包含该账号在其他设备的消耗，与本网关的请求历史和 Token 累计分开。

按接口实际返回的窗口长度显示周额度、5 小时额度或其他窗口。Business 的个人限额单独标注，不作为整个工作区余额。未返回的窗口、余额和重置时间保持未知，不推算成 0 或 100%。查询失败只影响对应账号的额度展示，不影响模型转发。

页面打开时查询一次，之后仅通过“刷新额度”按钮手动查询，不定时轮询，也不在切回页面时自动查询。服务按账号合并并发查询，成功结果最多缓存 30 秒，失败最多缓存 10 秒；账号变更时清除对应缓存。`GET /api/account-quotas` 仅允许本机管理会话访问，不返回账号标识、原始响应或凭证。CodeBuddy 与 With 的剩余额度查询尚未接入。

## Token 统计

管理页显示输入、输出、总 token，以及 A/B/With/CodeBuddy 分项和最近请求。管理 API 另提供按模型汇总。缓存命中属于输入的一部分，思考 token 属于输出的一部分，均单独列出而不重复加总。统计读取上游返回的 `usage`；With 使用原生 AGUI 的 `token_usage`。缺失的字段保持未知，中断或失败的请求也只记录已经收到的用量。

用量逐条追加到 `~/.codex-account-bridge/usage.jsonl`，重启时重建汇总。文件只保存时间、账号、模型、会话/请求标识、状态和规范化的 token 数，不保存提示词、回复正文或凭证。管理接口 `GET /api/token-usage` 需要本机管理会话。页面时间使用 `America/Los_Angeles`，文件时间为 UTC。

统计从启用记录时开始，无法补回此前的请求；它表示经过本网关且上游返回的 token 用量，不等同于订阅剩余额度或实际费用。记录文件写入异常会在管理页显示，模型转发继续运行。

## 配置

环境变量：

| 变量 | 用途 |
| --- | --- |
| `CODEX_BINARY` | 官方 Codex 可执行文件路径；默认从 PATH 查找 |
| `BRIDGE_PORT` | 本机端口，默认 43155 |
| `BRIDGE_STATE_DIR` | Bridge 私有数据目录 |
| `BRIDGE_CLIENT_CODEX_HOME` | 当前账号 A 的 Codex 配置目录 |
| `BRIDGE_DEFAULT_MODEL` | B 验证模型，默认 `B-gpt-6.1-sol` |

Codex 和管理服务只监听 `127.0.0.1`。管理操作有会话 Cookie、CSRF 和 Host 检查；模型请求使用单独密钥。启用下面的 With 接入后，另开启仅供指定虚拟机使用的端口。

## 虚拟机 Claude 使用 With

本机 With 已登录时，网关通过同一 Windows 用户的 With daemon 管道复用当前登录态。虚拟机 Claude Desktop 使用第三方模型配置，With 模型为 `claude-opus-5-5`，上游为 With 的 `claude-opus-5.5`。With 的登录凭证留在 With 内；虚拟机持有独立生成的网关密钥。下方 CodeBuddy 接入与它共用虚拟机入口，模型别名独立。

Claude Desktop 的第三方模型连接属于 3p 模式，使用独立的历史和模型目录；这里配置的 With、CodeBuddy 模型不会追加到原订阅模式的模型列表中。切换连接时，应按所选模式查看对应历史。

已配置的虚拟机可安装两个桌面快捷方式：**Claude - Account**（原账号模式）和 **Claude - CodeBuddy**（网关模式）。在宿主机执行：

```powershell
& D:\Bifrost\scripts\Install-ClaudeVmModeShortcuts.ps1 -Action Apply
```

双击快捷方式会设置对应的下次启动模式。Claude 未运行时，快捷方式会打开官方应用；正在运行时，会提示先从托盘退出再重开，保留当前任务。两种模式继续使用各自的历史和设置，网关地址、授权和模型配置保留。安装快捷方式本身不会切换模式或启动应用。

网关配置启用 `claudeAiImport: { "enabled": true }` 后，可在网关模式的 **Settings → Import & export → Import…** 使用[官方历史导入向导](https://claude.com/docs/third-party/claude-desktop/import)。先从托盘完全退出 Claude，再双击 **Claude - CodeBuddy**；在 Chats 步骤点击 **Sign in to claude.ai…**，用原账号授权一次性导出，返回点击 **Fetch export**。随后在 Cowork & Code 步骤选择本机会话，经过 Review 后点击 Import。首次续聊时确认 **Trust and resume**，回复使用已配置的 CodeBuddy 网关。

导入复制历史，原会话保留；之后不会自动同步。聊天附件和项目知识文件的内容不包含在个人数据导出中，需重新添加。主题等界面设置继续按模式保存。

本机已核查的 Desktop 原生地址校验只接受 HTTPS 或 HTTP loopback。原配置 `http://192.168.168.1:43157` 会被客户端拒绝，即使网络和模型目录可达。Desktop 应配置 `http://127.0.0.1:43157`，由虚拟机内的 TCP 端口转发连接宿主 `192.168.168.1:43157`。TCP 转发保留原始 Host；宿主网关只额外允许 `127.0.0.1:43157` 这个 Host，仍检查真实来源为指定虚拟机及独立网关密钥。

| 端口 | 用途 |
| --- | --- |
| `127.0.0.1:43155` | 原有 Codex A/B 与本机管理页 |
| 虚拟机 `127.0.0.1:43157` | Claude Desktop 配置地址；TCP 转发至宿主模型网关 |
| 宿主 `192.168.168.1:43157` | 仅允许虚拟机 `192.168.168.10` 访问的 Anthropic Messages 入口 |
| `127.0.0.1:43158/mcp` | With 与虚拟机工具之间的本机 MCP relay |
| 宿主 `192.168.168.1:17890` | 现有虚拟机联网代理 |

17890 的网络代理与 43157 的模型网关用途不同。保留现有 Mihomo 对宿主 `192.168.168.1/32` 的绕行规则，无需为这条 TCP 转发修改现有代理或其他出口规则。

With 提供智能体会话接口，因此这里使用会话与 MCP 桥接。初次请求携带外部客户端的系统指令、历史和工具定义；工具请求先作为 `tool_use` 返回虚拟机，由虚拟机 Claude 执行及处理权限，下一次请求的 `tool_result` 再释放等待中的 MCP 调用。网关会检查会话、工具定义和参数是否匹配。With 配置只添加 `codex_vm_gateway` 一项，重复启动会核对并复用它，冲突时停止 With 接入。

当前适配文本、流式回复及客户端工具。初始图片、Anthropic 服务端工具、同一工具结果消息附带额外文本，以及权威 `count_tokens` 暂未适配，会明确返回错误。`max_tokens`、温度、停止词等参数没有逐项映射到 With 智能体；With 自身系统规则仍会参与。工具等待时间配置为 30 分钟，链路其他超时仍需实际使用验证；重启网关会丢失等待中的工具会话。

纯聊参数不构成 With 原生工具的执行白名单。适配器不会自动批准 With 的原生工具确认，发现其他工具开始事件会取消该会话；这不能证明事件送达前原生工具尚未开始执行。完整工具兼容和此边界由真实回合验收。

已有虚拟机安装先修复连接。以下命令在宿主 PowerShell 执行，使用已有安全管理通道，无需在命令行传递网关密钥：

```powershell
& D:\Bifrost\scripts\Repair-ClaudeVmGateway.ps1 -Action Plan
& D:\Bifrost\scripts\Repair-ClaudeVmGateway.ps1 -Action Apply
```

`Plan` 只读本机计划；`Apply` 准备虚拟机 loopback TCP 转发，并将已有 Gateway 配置地址改为 `http://127.0.0.1:43157`。该修复保留当前模式及历史。它不终止正在执行的 Desktop 或 CLI 任务；需要重新加载配置时，在任务完成后由用户退出并重开 Desktop。

新装流程先准备转发，再创建第三方模型配置：

```powershell
& D:\Bifrost\scripts\Initialize-With.ps1
# 重启本网关以加载私有 with.json；当前用户请求应先完成。
# 以下命令在管理员 PowerShell 执行，不包含任何密钥正文：
& D:\Bifrost\scripts\Repair-ClaudeVmGateway.ps1 -Action Apply -ForwardOnly
& D:\Bifrost\scripts\Configure-WithVm.ps1 -Action Apply `
  -GatewayBaseUrl http://127.0.0.1:43157 `
  -GatewayKeyFile D:\Bifrost\.state\with-vm\gateway.key `
  -GatewayProgram (Get-Command node.exe).Source
```

配置脚本先检查对应渠道的登录就绪状态和模型目录，再准备虚拟机 Desktop 配置；可以在 Desktop 运行时准备，下次完整退出并重开后生效。它保留已有 MCP、偏好及 Claude Code 设置，不终止任务。宿主防火墙仅为 VMnet1、指定虚拟机、指定 Node 程序开放 TCP 43157；保留原有代理、IPv6、UDP 和其他端口规则。

只撤销连接修复时，执行 `Repair-ClaudeVmGateway.ps1 -Action Restore`，恢复其管理的地址和 TCP 转发到修复前状态；这不会切换 Desktop 模式。新装后完整移除 VM 接入时，在管理员 PowerShell 中先恢复第三方配置与宿主防火墙，再撤销转发：

```powershell
& D:\Bifrost\scripts\Configure-WithVm.ps1 -Action Restore
& D:\Bifrost\scripts\Repair-ClaudeVmGateway.ps1 -Action Restore
```

还原检查程序管理的字段及防火墙规则是否被再次编辑，保留无关配置。恢复清单和原文件备份位于宿主 `.state/with-vm` 及虚拟机 `%LOCALAPPDATA%\CodexWithGateway\with-vm`，不要删除后再执行恢复。配置恢复后，在任务完成时由用户退出并重开 Desktop。要暂停 With，将私有 `with.json` 的 `enabled` 改为 `false` 后在空闲时重启网关；已有独立授权且启用的 CodeBuddy 可以继续使用 43157，不需要启动 With daemon 或 43158 MCP relay。

连接准备中的 `/health` 和 `/v1/models` 检查只证明渠道状态与目录可读，不能证明聊天或工具回合成功。With 与 CodeBuddy 的真实推理、完整工具回合及额度消耗由用户操作验收。Desktop 第三方配置字段参考 [官方配置说明](https://claude.com/docs/third-party/claude-desktop/configuration)。

## 通用 Anthropic Messages 网关

`src/anthropic-gateway.mjs` 提供与部署环境无关的 Messages 网关。它按完整模型 ID 选择提供商，处理认证、SSE、取消和用量；未知模型和提供商失败均不回退。提供商接收原始请求字节和解析后的请求，负责自己的上游认证及必要转换。核心不包含虚拟机地址、安装目录或特定提供商名单。

`src/with-gateway.mjs` 是已有虚拟机接入的兼容适配，保留旧地址约束及 CodeBuddy 路由。客户端可以是本机、其他电脑或虚拟机；部署层显式提供监听地址、Host/来源白名单、独立网关密钥和模型表。

原 Claude 订阅与 CodeBuddy 是两个独立后端。Claude Desktop 的 3p 模式使用网关认证，不会自动携带 1p 的订阅登录。原订阅可使用已独立登录的 Claude Code CLI 后端；这不是将 Desktop 原请求原样发给 claude.ai，也不把 API 用量算作订阅额度。Codex 继续使用原有 Bridge 路由。

原 Claude 模型由本项目的 `ClaudeCliHub` 调用官方 Claude Agent SDK 和官方 Claude CLI。Magpie 仅作为实现参考，不是运行依赖。CodeBuddy 继续使用本项目已有的转换。模型目录列出配置的模型，不能据此证明账号有每个模型的调用权限。

### 准备独立 Claude CLI 后端

CLI 安装、账号登录和协议适配分别管理。`OfficialClaudeCli.ps1` 固定安装官方 Claude CLI 2.1.304，校验官方 manifest、文件大小和 SHA-256，使用独立配置目录。`Plan`、`Status` 不发起模型请求，`Prepare` 安装，`Login -Interactive` 由本人在可见窗口完成官方订阅登录。普通电脑可指定自己的安装目录；当前部署必须在虚拟机内执行。

```powershell
# 在运行 CLI 的电脑上执行，安装目录按该电脑填写。
$installer = '.\scripts\OfficialClaudeCli.ps1'
$cliRoot = 'D:\AgentTools\OfficialClaudeCli'
$plan = & $installer -Action Plan -Root $cliRoot | ConvertFrom-Json
& $installer -Action Prepare -Root $cliRoot -PlanHash $plan.PlanHash
& $installer -Action Login -Root $cliRoot -Interactive
& $installer -Action Status -Root $cliRoot
```

`SubscriptionAuthenticated=true` 要求官方 CLI 明确报告 `loggedIn=true`、`authMethod=claude.ai`，且配置目录与隔离目录一致。该状态不保证每个配置模型的权限或剩余额度。Claude Desktop 的网页登录不会自动替这个隔离 CLI 完成登录。

协议适配入口为 `node scripts/run-claude-relay.mjs <绝对配置路径>`，依赖固定版本 `@anthropic-ai/claude-agent-sdk@0.3.304`。每个会话使用持续的 SDK 输入流和 CLI 原生 session ID；完整客户端工具 schema 通过本地 MCP 交给模型，工具调用仍由客户端执行，工具结果按原生 tool-use ID 返回。后台关闭本机原生文件、命令工具和自动压缩，避免另行执行客户端工作。

当前虚拟机场景把官方 CLI、SDK 和本项目 relay 都放在虚拟机内。宿主的通用网关通过独立 TCP 通道调用虚拟机 relay，CodeBuddy 由宿主已有适配器处理。Claude 的 OAuth 凭证和原生会话留在虚拟机，宿主只持有专用网关密钥。VM relay 使用指定 host-only IP，仅允许宿主访问；MCP 仅监听虚拟机回环地址。

授权也在虚拟机里完成。使用虚拟机内的 `Claude CLI - Login` 快捷方式打开官方 CLI 交互窗口，选择原订阅账号；出现手动授权码时，在同一窗口完成。不要用宿主旧登录页替代本次虚拟机授权。部署适配脚本为 `scripts/Deploy-ClaudeCliVm.ps1`，与通用模型路由和协议转换分开。

relay 的私有配置包含 `version=1`、`listener`（明确的 IP、端口、Host 和来源白名单）、`gatewayKeyFile`、`models`（`id/name/upstream`）、`cli`（`binary/configDir/profileDir/stateDir` 的绝对路径）和回环 `mcpPort`。各路径必须指向运行 CLI 的电脑。部署脚本管理 VM 特有的文件传输、进程和端口规则，通用协议模块不依赖 VMware。

先在项目目录执行 `npm ci --omit=optional --ignore-scripts` 安装固定 SDK 依赖；CLI 使用前述单独校验的官方二进制。普通 Windows 部署可通过 `scripts/ClaudeRelay.ps1` 管理自研 relay；显式传入 `Root`、`NodeBinary`、`ConfigPath` 和 `EntryScript`。先执行 `-Action Plan`，再将当前 `PlanHash` 传给 `-Action Start`。`Status` 读取运行和就绪元数据；`Stop` 核对进程归属后通过认证的本机命名管道关闭，无新增 HTTP 管理端口。

现有 VM 使用两个独立适配器：`Deploy-ClaudeCliVm.ps1` 安装官方 CLI 和本人登录入口，`Deploy-ClaudeRelayVm.ps1` 部署本项目源码、固定 SDK、Node、自研 relay 配置及限定来源的端口规则。二者都先 `Plan`，再携带当前 `PlanHash` 执行 `Prepare`。CLI 的 `Prepare` 不登录；relay 的 `Prepare` 不启动，随后另行 `Start`。VM 桌面的 `Claude Relay - Start`、`Claude Relay - Stop` 管理自研服务，`Claude CLI - Login` 管理订阅授权。

宿主在 `claudeCli` 中配置 relay 的专用密钥文件及可选 TCP 通道，通道随 Bridge 启停。该密钥只用于调用 relay，不能保存 Claude OAuth 凭证。下面的地址对应现有虚拟机部署；其他部署填写自己的目标。通道只绑定宿主回环地址，保持原始字节、半关闭和取消行为。

```json
{
  "baseUrl": "http://127.0.0.1:3435/v1",
  "apiKeyFile": "C:\\Users\\jiahaoguo\\.codex-account-bridge\\claude-vm-gateway.key",
  "cacheMode": "cli",
  "tcpForward": {
    "version": 1,
    "listener": {"address": "127.0.0.1", "port": 3435},
    "target": {"ip": "192.168.168.10", "port": 3435}
  }
}
```

### 配置模型分流

通用配置位于 `%USERPROFILE%\.codex-account-bridge\messages-gateway.json`；指定 `BRIDGE_STATE_DIR` 时跟随该目录。缺少此文件才启用已有 With/CodeBuddy VM 兼容部署。文件存在却无效、端口冲突或上游指向自身时，该通道停止，Codex 主入口继续运行。

以下是本机部署模板。`gatewayKey` 必须换成至少 40 字符的独立随机密钥，并限制配置文件访问权限；已有客户端可继续使用原 Messages 入口密钥。`model.id` 是客户端菜单中的精确 ID，`model.upstream` 必须来自独立 Claude 后端的 `/v1/models`。示例中的 `REPLACE_FROM_VERIFIED_CLI_CATALOG` 只是占位值，登录后核实真实目录再填写。CodeBuddy 需要先在管理页完成独立授权。

```json
{
  "version": 1,
  "listener": {
    "address": "127.0.0.1",
    "port": 43157,
    "allowedHosts": ["127.0.0.1:43157"],
    "allowedPeers": ["127.0.0.1"]
  },
  "gatewayKey": "REPLACE_WITH_A_PRIVATE_RANDOM_KEY_AT_LEAST_40_CHARACTERS",
  "claudeCli": {
    "baseUrl": "http://127.0.0.1:3435/v1",
    "apiKeyFile": "C:\\Users\\YOUR_USER\\.codex-account-bridge\\claude-relay.key",
    "cacheMode": "cli"
  },
  "routes": [
    {
      "account": "Claude",
      "provider": "claude-cli",
      "model": {
        "id": "claude-opus-5-5",
        "name": "Opus 5.5",
        "upstream": "REPLACE_FROM_VERIFIED_CLI_CATALOG"
      }
    },
    {
      "account": "CodeBuddy",
      "provider": "codebuddy",
      "model": {"id": "claude-codebuddy-opus-5-5", "name": "CodeBuddy Opus 5.5"}
    }
  ]
}
```

可增加多条 `claude-cli` 路由，每个客户端 ID 必须唯一，`upstream` 必须匹配 relay 目录。relay 配置中的 `upstream` 是交给官方 CLI 的模型别名或明确模型 ID。客户端只连接 Messages 主入口并使用其网关密钥；宿主调用 relay 时使用另一把独立密钥，不转发客户端认证。CLI HTTP 上游仅支持 HTTPS 或 HTTP 回环地址；远程内网访问由可选 TCP 通道完成。`cacheMode` 只接受省略或 `cli`，提示缓存由官方 CLI 管理。

写入后，在所有请求完成时重启 Bridge。恢复兼容部署时，将 `messages-gateway.json` 改名保留，再于请求空闲时重启；保留原 `with.json`、CodeBuddy 授权及客户端恢复清单。`Start-Bridge.ps1` 仅启动或复用服务，不会重载运行中的配置。

虚拟机使用同一配置格式，只在部署文件中填宿主监听地址、实际来源和 Host 白名单，沿用既有 loopback 转发与防火墙限制。CLI 登录完成、目录核对及宿主网关加载后，可更新已安装的 VM 模型表：

```powershell
# 按实际已配置并可见的模型 ID 填写；不发送真实推理。
& D:\Bifrost\scripts\Configure-WithVm.ps1 -Action Plan `
  -InferenceModels @('claude-opus-5-5', 'claude-codebuddy-opus-5-5')
& D:\Bifrost\scripts\Configure-WithVm.ps1 -Action Apply -ModelsOnly `
  -GatewayBaseUrl http://127.0.0.1:43157 `
  -GatewayKeyFile D:\Bifrost\.state\with-vm\gateway.key `
  -InferenceModels @('claude-opus-5-5', 'claude-codebuddy-opus-5-5')
```

`-InferenceModels` 显式替换受管理模型列表，接受模型 ID 字符串或官方模型对象；对象的 `name` 必须匹配网关目录中的精确 ID，`labelOverride` 只控制菜单名称。也可用 `-ModelsJsonFile D:\path\models.json` 读取 UTF-8 JSON 数组，便于通过 PowerShell 5 的 `-File` 入口传递对象。两种参数互斥，也不能与旧 `-CodeBuddyOnly`、`-IncludeCodeBuddy` 开关合用。脚本保留条目顺序和完整模型对象，先验证渠道状态和精确目录，并保留最初恢复值及其他配置的冲突检测。将 CodeBuddy 条目放在数组最后即可追加到菜单末尾。

模型对象支持[官方配置字段](https://claude.com/docs/third-party/claude-desktop/configuration#models) `name`、`labelOverride`、`anthropicFamilyTier`、`isFamilyDefault`、`supports1m`、`prefer1m`、`maxEffort`；拒绝未知字段、重复 ID 和重复的同族默认模型。仅对已确认支持 1M 上下文的部署声明 `supports1m`。模型目录检查不会发送推理请求；此脚本针对现有虚拟机部署，通用网关核心不依赖 VMware。

例如，模型文件可以保留原模型的正式 ID 和名称，把 CodeBuddy 追加到最后：

```json
[
  {"name": "claude-opus-5-5", "labelOverride": "Opus 5.5", "anthropicFamilyTier": "opus", "isFamilyDefault": true},
  {"name": "claude-codebuddy-opus-5-5", "labelOverride": "CodeBuddy Opus 5.5", "anthropicFamilyTier": "opus"}
]
```

VM relay 部署也接受 `-ModelsJsonFile`，文件是由 `id`、`name`、`upstream` 组成的数组。`Plan` 和 `Prepare` 传入同一目录；模型 ID、名称、上游和顺序都纳入 PlanHash。客户端正式 ID 可以直接对应官方 CLI 的明确版本，菜单无需使用 `native` 路由别名。模型来源应为已登录 CLI 的初始化目录，桌面名称和排序可参照官方模型目录；公共目录不等于账号模型权限。3p 模式仍使用自己的列表配置，不能承诺与原账号的菜单分组、权限和默认偏好自动同步。

CLI 会话恢复、官方历史导入和服务端提示缓存分别验证。已有 Desktop 历史首次交给 CLI 时，以明确标注角色的历史内容导入一次；后续匹配会话只提交新增用户消息并保留原生 session ID。这并非替换 CLI 的原生 assistant 历史。缓存标记的位置变化不会重建内容相同的会话；缓存由官方 CLI 管理，不能承诺迁移 1p 的缓存或相同命中率。网关记录原始流中的 `cache_read_input_tokens`、`cache_creation_input_tokens`，不重复累计 SDK 的整段会话统计。

目前映射文本、图片和文档输入、客户端工具、普通追问、adaptive/disabled 思考及 effort。未知参数、未适配内容块、服务端专用工具和缺失的原生工具标识返回明确错误。CLI 没有本项目可调用的权威 `count_tokens` 接口，该路由返回 501；`max_tokens` 映射到 CLI 的最大输出设置，仍受 CLI 和模型限制。单轮回复上限为 64 MiB，慢客户端会对流读取施加背压。

底层 API 消息完整地以 `max_tokens` 结束时，网关保留这条消息的截断状态和用量，并取消 CLI 的自动续写。该原生会话及恢复索引会被丢弃，防止下一次请求恢复到客户端未见的续写历史；后续请求按已有历史重建，不承诺这类截断后的缓存复用。普通完整回复继续等待 SDK 成功结束，并沿用原有会话复用。

普通文字追问可通过会话续接；结构化提问和权限确认则要求客户端提供并处理对应 `tool_use/tool_result`。CLI 后端只调用转回客户端的工具，不应在网关主机执行客户端的命令或替用户批准操作。首次启用前应分别验收多轮追问、用户提问、拒绝权限、工具成功、等待用户后续接、缓存用量以及进程重启恢复；完整真实回合由用户执行。

工具链等待期间，客户端须保持 `max_tokens`、effort 和 thinking 一致；改变这些参数返回 409，已有工具仍等待原参数的结果，不会替用户生成答案。普通文字回合之间可以改变这些参数，并恢复同一个原生会话。`tool_choice` 仅接受 `{ "type": "auto" }`；尚未映射的禁止并行或强制调用限制返回 400。

当前自定义模型 ID 没有宣告 1M 上下文支持，Desktop 会按未识别模型的默认窗口处理。需要 1M 时，先由用户在真实部署中验收，再为对应官方模型 ID 配置 `supports1m` 等信息；不能仅凭目录中的名称认定长上下文已验证。说明见官方 [模型目录与上下文](https://claude.com/docs/third-party/claude-desktop/gateway#models)。

在已有会话中切换渠道也需要单独验收。原 Claude 的 thinking 签名和 CodeBuddy 的本地接续标记不能互换；CodeBuddy 对原生非空签名仍明确拒绝。同一菜单出现两个渠道，不代表任意历史都能跨渠道无损续聊。

官方依据：[3p 网关](https://claude.com/docs/third-party/claude-desktop/gateway)、[订阅与 SDK/CLI](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)、[用户交互](https://code.claude.com/docs/en/agent-sdk/user-input)、[提示缓存](https://code.claude.com/docs/en/prompt-caching)。

## 虚拟机 Claude 使用 CodeBuddy

管理页新增 CodeBuddy 卡片，通过官方员工 OAuth 独立授权，并自动刷新、加密保存本网关的凭证。请求直接调用 CodeBuddy 的模型接口，不需要保持本地 IDE 进程打开。同一个 VM 入口按模型精确分流：

| 虚拟机模型 ID | 渠道 |
| --- | --- |
| `claude-opus-5-5` | With |
| `claude-codebuddy-opus-5-5` | CodeBuddy |

先在管理页完成 CodeBuddy 官方 IOA 登录，确认 Opus 5.5 目录来源。已有安装先按上面的连接修复步骤准备 loopback 入口。仅使用 CodeBuddy 时，升级虚拟机的第三方模型配置：

首次授权会启用 CodeBuddy；若本次运行启动时尚未启用，应在请求空闲时重启本网关，再执行配置命令。后续重新登录沿用已启用的通道。

```powershell
& D:\Bifrost\scripts\Configure-WithVm.ps1 -Action Apply -CodeBuddyOnly -ModelsOnly `
  -GatewayBaseUrl http://127.0.0.1:43157 `
  -GatewayKeyFile D:\Bifrost\.state\with-vm\gateway.key
```

`-CodeBuddyOnly` 只保留 `claude-codebuddy-opus-5-5`，并仅检查 CodeBuddy 的登录和目录；Desktop 的启动测试也会选中该模型。需要同时使用两个渠道时，改用 `-IncludeCodeBuddy`，两项参数不能同时使用。

`-ModelsOnly` 仅用于已安装的虚拟机网关，复用既有端口和防火墙配置，不需要扩大网络权限。升级保留最初恢复值；任何受管理字段被外部修改都会停止覆盖。完整退出并重开虚拟机 Desktop 后加载新列表；原订阅模式保留自己的模型列表和历史。

模型 ID 优先取远程配置。当前独立授权返回的配置仅含功能项，因此读取本机 CodeBuddy CN 的模型目录缓存，严格匹配本网关已登录员工的 UID。SQLite 以只读方式定点投影模型元数据，保留原始保存时间，最多接受 30 天内的记录；不读取原生登录凭证、模型密钥或自定义认证头。目录过期后需更新本机 CodeBuddy 目录。远程明确拒绝或明确返回空模型列表时，不使用缓存。

本机目录中 Opus 5.5 的实际 ID 为 `claude-opus-5.5`，`credits` 标注为 `x2.17`。管理页显示“本机目录已确认 / 待本人实测”；缓存内容只证明该账号的原生目录曾包含此模型，实际权限、聊天、工具回合及计费由用户验收。

CodeBuddy 的兼容转换支持文本、SSE、客户端工具、图片和已经解析的文本附件。图片接受 JPEG、PNG、GIF、WebP 的 base64 数据或公开 HTTPS 引用。嵌入图片解码后每张最多 5 MiB，每次请求最多 100 张，包含重发的历史、附件及工具结果中的图片。网关校验嵌入图片的编码、大小及 MIME 签名；HTTPS 图片只转交引用，不由网关下载，远程内容的实际格式、字节和像素限制由上游检查。

`document` 支持 `source.type=text` 且 `media_type=text/plain` 的正文，以及 `source.type=content` 的字符串或 text/image 内容块。标题和上下文用明确文本前缀保留，正文及图文顺序保留；单份文档的 UTF-8 文本合计最多 32 MiB，含标题、上下文前缀。`tool_result` 同样支持这些图文内容。原始 base64 PDF、Office 二进制、文档 URL、视频、音频和 `file_id` 返回 400，必须先解析为文本或图片。文档的 `citations.enabled=true` 也返回 400。这些能力由本地适配器转换实现，当前没有原始文件上传、下载或解码通道。

思考使用 `thinking.type=adaptive`，强度由 `output_config.effort` 选择 `low`、`medium`、`high` 或 `xhigh`，默认 `high`。设置 `thinking.display=summarized` 可显示摘要；默认及 `omitted` 隐藏摘要。隐藏摘要不会关闭内部思考；`thinking.type=disabled`、`enabled` 加 token budget，以及 `effort=max` 均明确返回 400。

可见摘要取自 Chat 返回的 `reasoning_content`，以空 `signature` 兼容本网关生成的历史回放。默认或 `display=omitted` 隐藏摘要正文，同时返回空 `thinking` 块：其 `signature`（SSE 中为 `signature_delta`）携带 `bridge-codebuddy-v1:` 前缀的 AES-GCM 密文接续标记。客户端须原样保留，并在下一轮回传该块，网关才可恢复工具回合所需的思考内容。

CodeBuddy 原生客户端还会保留响应中最后一个非 `null` 的 `extra_fields` 值，并在下一轮随对应 assistant 消息回传。网关将这项元数据放入额外的加密接续块；即使没有思考摘要，或设置显示摘要，也需要客户端保留该块。元数据的空对象、空数组、空字符串、`false` 和 `0` 均完整保留，不合并或展开其内部字段。未知的其他响应字段仍明确报错。

该标记属于本网关的本地接续状态，不是 Anthropic 厂商签名。密文绑定当前登录 UID 和真实上游模型，跨账号或模型回放返回 403。原生 Anthropic 非空签名和 `redacted_thinking` 仍返回 400。单块接续状态的完整 JSON 最多 32 MiB，整个入口请求 JSON 最多 64 MiB。

独立加密密钥默认保存在 `%USERPROFILE%\.codex-account-bridge\codebuddy-thinking-key.dpapi.json`，随 `BRIDGE_STATE_DIR` 改变，使用 Windows DPAPI CurrentUser 保护；网关不在磁盘保存隐藏摘要明文。同一 Windows 用户保留同一密钥后可跨网关重启续接。密钥按需加载，损坏时拒绝 CodeBuddy 模型请求，管理页、A/B 与 With 启动保持可用。真实客户端对空思考块及接续标记的保留、回传，以及图片理解、思考展示和附件工具回合仍待本人验收。

停止序列和权威 Token 计数尚未适配。合法缓存提示经过校验后忽略，不保证 Anthropic 原生显式缓存行为。CodeBuddy 用量单独记录，缺失用量保持未知；目录活动价不直接换算员工 Token 倍率。接入和凭证细节见 [EMPLOYEE-AUTH.md](EMPLOYEE-AUTH.md)。

收到尚未适配的附件内容时，网关返回 HTTP 400 及具体错误，不会丢掉该附件后继续调用模型。Claude 客户端的展示取决于其错误界面；管理页 CodeBuddy 卡片同时显示最近一次已脱敏的渠道错误，并累计失败次数。下一次成功会清除卡片的最近错误；用量历史保留时间、渠道、HTTP 状态和完成状态，不保存错误正文或附件内容。如果客户端发送前就没有附带文件内容，网关无法据此发现遗漏。

## 验证与边界

```bash
npm test
npm run check
```

完成管理页的真实推理验证后，还可执行 `npm run verify:codex`：它使用当前 Codex 的原生身份和临时 Provider 覆盖，经网关请求 B，并要求模型通过当前电脑的 shell 工具读取随机验证文件。成功条件包括原生 turn 完成、确实出现工具调用、最终回复与随机文件完全匹配。这个检查不安装全局配置；结果保存在项目 `.state/client-proof-*/result.json`。

接入配置后，执行 `npm run verify:codex -- --installed` 可检查已保存的配置；此时不传入临时 Provider 覆盖。两种检查都对照原生 CLI 的 `thread.started.thread_id` 与网关会话记录，要求该会话仅在选定账号完成推理，同时确认绑定账号保持一致。可分别检查三个路由：

```bash
npm run verify:codex -- --installed --model gpt-6.1-sol
npm run verify:codex -- --installed --model B-gpt-6-astra
npm run verify:codex -- --installed --model B-gpt-6.1-sol
```

测试覆盖账号绑定、过期刷新、认证替换、流式字节转发、工具参数保留、未完成推理、token 记录与重启恢复、原生网页搜索路由、管理接口保护，以及原配置的安装、冲突和恢复。真实的 B 登录与推理只能在账号持有者完成官方登录后验证。

网关提供 `/backend-api/codex/models`、`/backend-api/codex/responses`、`/backend-api/codex/responses/compact` 和原生网页搜索 `/backend-api/codex/alpha/search`，以及 `/v1` 路径别名。网页搜索遵循同样的 A/B 模型与授权路由，不计为 Responses token 记录。使用 HTTP/SSE；不提供 WebSocket 或音频接口。compact 路由需要目标账号实测，不能以基本文本推理成功代替验证。

本版本采用现有官方 Codex 登录和 app-server RPC；这些 RPC 在不同 Codex 版本间可能变化。Business/Team 账号必须本身拥有 Codex 权限，工作区策略继续生效。

官方文档说明了网关、模型别名与本地 app-server 的接口。独立登录 B 后在网关按模型名替换推理账号是本项目的自定义实现；技术验证不代表官方对跨账号替换方案提供兼容承诺。

## 官方依据

- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [ChatGPT 认证与凭证隔离](https://learn.chatgpt.com/docs/auth)
- [通过网关使用 ChatGPT 登录](https://learn.chatgpt.com/docs/enterprise/sign-in-with-chatgpt-through-a-gateway)
- [Business / Enterprise Codex access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens)：这是另一个授权入口，当前版本先使用原生浏览器登录。
