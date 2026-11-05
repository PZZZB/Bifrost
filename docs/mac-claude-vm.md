# Mac 调用隔离 Linux VM 中的 Claude

此入口用于本机 CodeBuddy 等客户端调用虚拟机中的 Claude。原来的 Windows 部署入口保留；这里增加 Mac 回环网关、Chat Completions 适配和 Linux 服务模板。当前实例采用 Apple Virtualization.framework、Ubuntu ARM64，以及独立的 VPS 代理链路。

```text
CodeBuddy → Mac 127.0.0.1:43157 → Mac 127.0.0.1:3435
         → 192.168.160.2:3435 → Agent SDK → 官方 Claude CLI → VPS → Anthropic
```

## CLI 与 SDK

| 方式 | 职责和适用范围 |
| --- | --- |
| Claude Agent SDK + 官方 CLI | 本项目采用；SDK 启动固定 CLI，管理消息、流式事件、权限回调和持续会话；CLI 使用 VM 内的订阅登录；仍有 CLI 自动上下文 |
| 直接启动 `claude -p` | 可用于一次性脚本；复杂网关需要自行维护子进程、JSON 流、取消和工具续接；同样有 CLI 自动上下文 |
| 普通 Anthropic Client SDK（`@anthropic-ai/sdk`） | 直接调用 Claude API，使用 API 授权；不启动 CLI，消息由应用构造；会话历史和工具回合需由应用管理 |

这里的 SDK 是 Agent SDK，内部仍运行官方 CLI。保留这一组合能复用现有 Bifrost 的订阅认证、持续会话和 MCP 工具桥接。直接改为 `claude -p` 不会改善环境披露，还会增加进程与协议维护工作。

如果后续要求模型正文完全不含 CLI 自动添加的环境上下文，应考虑普通 API SDK 后端：由 Bifrost 明确构造请求消息，并使用 API 凭据。这是认证和后端的变更，需要另行实现及验收；当前没有启用。API 客户端本身仍可能发送平台/版本等 HTTP 元数据，不能据此承诺对服务端隐藏运行平台。依据：[普通 TypeScript SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript)。

运行依赖固定的 `@anthropic-ai/claude-agent-sdk@0.3.304` 和已验证的官方 Claude CLI 2.1.304。SDK 的 `pathToClaudeCodeExecutable` 明确指向 guest 的二进制；不解析交互终端画面。依赖安装使用 lockfile：

```sh
npm ci --omit=optional --ignore-scripts
```

依据：[官方比较](https://code.claude.com/docs/en/agent-sdk/overview)、[非交互 CLI](https://code.claude.com/docs/en/headless)。`--bare` 会跳过 OAuth 凭据读取，不能直接加到本项目的订阅登录模式。[Claude 计划说明](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) 当前允许个人通过 Agent SDK 和 `claude -p` 使用订阅限制；账号实际可用模型、额度和计费来源需登录后确认。

## 访问和网络边界

| 入口 | 限制 |
| --- | --- |
| Mac `127.0.0.1:43157` | 本机 API，检查来源、Host 和独立客户端密钥 |
| Mac `127.0.0.1:3435` | 固定 TCP 通道；源地址绑定 `192.168.160.1`，只连接 VM `192.168.160.2:3435` |
| VM `192.168.160.2:3435` | 只允许宿主 `.1`，要求另一份 relay 密钥 |
| VM `127.0.0.1:3436` | 每个会话使用单独认证的客户端 MCP |
| 宿主 `.1:17890` | 仅供 guest 代理使用的独立 Mihomo；不能作为任意宿主访问入口 |

VM 仅保留 host-only 网卡，不配置物理网卡的公网默认网关。宿主关闭 IPv4/IPv6 转发，不启用 VM NAT、桥接或共享目录。guest 防火墙只允许 Mihomo 用户通过指定宿主端口出网，额外允许 relay 对宿主已建立 API 连接的回复。

系统 DNS 指向 guest `127.0.0.1:53`；Mihomo 接管 TCP/UDP 53，上游 DoH 明确经过宿主专用代理和 VPS。代理配置没有普通 DNS、DIRECT 回退；禁用 IPv6，拒绝非 DNS UDP。**这些是独立的系统与代理策略，单独启动 Bifrost 不会建立网络隔离。**

CodeBuddy 的文件、终端和问答工具仍在客户端所在电脑执行，权限由客户端控制；这部分不在 guest 的隔离范围内。Mac 普通用户可读取本机网关密钥，因此回环认证也不是针对同一 macOS 账号内恶意程序的隔离。

## 减少环境披露

SDK worker 关闭原生 Bash、读写文件和其他内置工具，只允许客户端 MCP 工具。它不加载用户/项目设置、CLAUDE.md、自动记忆、IDE 连接、hooks 或云端 MCP；对客户端消息使用 `verbatimPrompts`。同时关闭自动附件、非必要网络流量和官方插件市场自动安装。

客户端没有提供非空系统提示时，worker 使用一个简短的客户端工具与权限提示；非空提示保持原文。**自定义系统提示和关闭附件都不能消除 CLI 单独插入的环境消息。**固定版本的实际 CLI 离线检查中，有、无客户端系统提示的首轮和工具续接请求，均带有工作目录、Linux 平台与内核版本；未发现主机名或 Apple 虚拟化平台标记。

这只能减少不必要的披露，不能承诺模型无法推测或识别虚拟机。客户端主动提供的提示、日志和工具结果会照常交给模型。CLI 的平台/版本、会话标识等传输元数据也不承诺从服务端隐藏。底层 Apple 虚拟化特征仍存在；给模型 guest 终端或系统文件读取能力后，可能据此识别虚拟机。部署模板中的模型别名采用 `claude-sonnet`、`claude-opus`，不在别名中附加 VM/VPS 标签。

参考：[系统提示和自动上下文](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts)、[非必要流量开关](https://code.claude.com/docs/en/env-vars)。

## 部署模板

模板位于 [examples/mac-claude-vm](../examples/mac-claude-vm/)。当前 Mac 已安装的实例无需重新安装。新部署必须先准备上述网络策略、官方 CLI、固定 Node、SDK 依赖及私有可写目录。

guest 以 `claude` 普通用户运行，程序安装到 root 所有的 `/opt/bifrost`。`/etc/bifrost/relay.json` 和 relay 密钥是 root:claude 0640；OAuth 配置目录 `/home/claude/.claude`、运行状态和 XDG 子目录均为 claude 所有的 0700。

```sh
node /opt/bifrost/scripts/run-claude-relay.mjs /etc/bifrost/relay.json
```

Mac 配置的所有路径必须换成当前账号的绝对路径，客户端密钥与 relay 密钥必须独立生成。宿主代码放在 `~/Library/Application Support/ClaudeVPS/Bifrost/app`；Node 和私有配置放在相邻目录。网关只接受固定 host-only 目标，配置路径必须为绝对路径。

```sh
node scripts/run-mac-claude-gateway.mjs /absolute/private/gateway.json
```

Mac 使用系统 LaunchDaemon，并用 `UserName` 指定普通用户，`KeepAlive` 自动恢复进程。系统服务安装需要 macOS 管理员认证；网络进程保持普通用户权限。这样与 [Apple TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy) 的系统 daemon 网络规则一致，不修改隐私数据库。

CodeBuddy 使用 `http://127.0.0.1:43157/v1/chat/completions` 和独立客户端密钥。模板中的密钥占位符不能直接使用；请在本机填入实际值，文件权限设为 0600。远程电脑接入需要另设认证通道，当前端口只面向同一台 Mac。

公网客户端可通过独立的回环入口和 Tailscale Funnel 接入这台 Mac，使用单独密钥、会话身份和并发限制；不直接发布本机内部网关。配置和验证范围见 [公网接入](mac-external-access.md)。

## CodeBuddy 客户端

2026-11-01 已在 Mac ARM64 的 CodeBuddy IDE 4.12.3 中完成真实 Opus 聊天、本机文件工具和同一聊天续接验收。使用本人 CodeBuddy 登录与本机回环网关密钥；Claude 的订阅凭据仍留在 VM 中。CodeBuddy 自己的账号登录与 Claude 订阅登录相互独立。

用户级配置为 `~/.codebuddy/models.json`，可参考 [配置模板](../examples/mac-claude-vm/codebuddy-models.example.json)。填写真实本机网关密钥，保留完整的 `/v1/chat/completions` 路径，文件权限为 0600。配置位置、项目级覆盖及能力字段见 [CodeBuddy 官方说明](https://www.codebuddy.cn/docs/ide/Features/models)。模板中的占位符不能用于实际调用，也不能把真实密钥提交到 Git。

显示名采用与其他渠道相同的“来源＋模型＋版本”规则：`Claude Sonnet 5.5`、`Claude Opus 5.5`，版本来自本次 CLI 实际模型记录。保留 `claude-sonnet`、`claude-opus` API ID，兼容现有调用端。CodeBuddy 的自定义模型选择器会显示 `name:id`，例如 `Claude Opus 5.5:claude-opus`；冒号后是客户端展示的 API ID。上游仍使用订阅默认 `sonnet`／`opus` 别名，默认版本改变后应重新核对显示名，这些名称不表示已经固定上游版本。

两项 Claude 配置均启用 `supportsToolCall` 和 `supportsReasoning`，不设置 `temperature`。当前 CodeBuddy 对未指定温度的推理模型会省略其自动温度参数；这解决了客户端默认附带温度而 CLI 无法调整该参数的冲突。能力声明不代表每次都开启思考，实际思考请求仍按网关支持的 `reasoning_effort` 处理。网关对显式传入的不支持采样参数继续报错。

实际工具验收发现，CodeBuddy 会将纯工具调用的空 assistant 文本补为 `-`。Chat 适配器仅在原回复没有文本且确有工具调用时，额外索引这一精确占位形式；恢复原生历史时保留私有思考块。模型、系统提示、工具定义、调用者、消息前缀、工具 ID 与参数仍须匹配，其他文本改写不作等价处理。

本次测试在独立的 Mac 目录读取随机标记文件，客户端可见读取工具卡，最终标记与原文件一致；下一轮不再使用工具仍正确复述。文件内容不事先写入模型提示，没有给 VM 增加共享目录或原生文件工具。124 项相关回归测试通过。受保护的 guest 程序经正常关机、保留本机回退副本、离线更新后重新启动，普通用户权限与 VPS 出口检查通过。

随后已修复全库测试夹具：临时目录创建后解析为真实路径，保留生产代码对符号链接的拒绝；Cursor 模拟超时在 SDK 运行实际启动后，通过可控时钟触发，避免与文件系统耗时或无 socket 的模拟环境竞争。在这台 Mac 的默认环境下运行 `npm test`，1319 项通过、0 失败、0 取消，2 项 Windows 专属测试按平台条件跳过。

这次客户端验收使用内部回环入口；公司 Windows、公司内网额度，以及独立用户经公网 API Key 接入的完整链路仍需分别验收。

## 登录与验证

由本人打开 VM 的 `claude` 用户终端，执行：

```sh
claude auth login --claudeai
```

按官方 CLI 提示完成订阅登录，手动授权码填回同一 VM 终端。不要把授权码或 OAuth 文件交给客户端或上传仓库。若授权网页由 Mac 浏览器打开，那一段浏览器访问使用 Mac 的网络环境，需要另行保证符合所需出口；VM 的网络限制不会自动接管 Mac 浏览器。

当前 Mac 默认使用本人日常 Chrome 完成授权。先在 VM 内发起登录，原样打开该会话生成的官方链接；本人开启宿主全局代理后，在同一个 Chrome 中独立核对公网出口，不能用 VM 的出口检查代替。完成网页授权后，通过隐藏输入或私有 stdin 将完整授权码送回原 CLI，会话过期则重新发起并使用新链接。不要自动切换到临时浏览器或自动化窗口。这个流程不需要给 VM 安装桌面，也不复制宿主 Cookie 或持久凭据到 VM。

以下专用登录工具保留为可选维护方式，只有明确选择它时才运行；它不是日常 Chrome 流程的前置步骤：

```sh
node scripts/open-mac-claude-login.mjs
```

它读取既有私有维护配置，在 `127.0.0.1:17892` 临时启动独立代理，并打开使用独立临时配置的 Chrome 无痕窗口。浏览器固定使用 SOCKS5，没有 DIRECT 回退，禁用本地 DNS 解析、QUIC 和不经过代理的 WebRTC UDP；宿主日常 Chrome、全局代理及 VM 的网络策略不变。每次打开授权页前，先在这个浏览器里核对真实公网出口，再停止该临时代理、验证公网 IP 请求失败，恢复代理并复核同一出口。这里验证的是该专用浏览器的请求路径；没有给浏览器额外套 macOS 系统网络沙箱，Chrome 自带沙箱保持启用。

VM 中的登录助手以普通 `claude` 用户启动官方 `claude auth login --claudeai`，生成带 PKCE 的授权链接。浏览器原样打开这条官方链接，由本人完成登录与同意授权。授权回传绑定同一登录状态；只有 CLI 要求的精确 guest loopback 地址才可转发，官方授权码则经本机串口的私有 stdin 送回原 CLI。没有给客机增加 SSH、图形环境或网络监听端口；Chrome 调试只使用私有管道。官方支持浏览器登录及把授权码粘回终端的流程，见[认证说明](https://code.claude.com/docs/en/authentication)。

CLI 的持久凭据写入 VM 的既定配置目录。Mac 浏览器在登录期间仍会持有自己的网页会话，因此宿主是本次授权流程的可信部分；这与浏览器本身也必须放在 VM 内是不同的隔离要求。工具在完成、超时、退出或失败后关闭专用浏览器和代理，清理临时浏览器配置。密码、验证码、一次性授权码和 token 不写日志、Git 或命令参数；官方页面若不能自动回传，使用本机隐藏输入框粘贴一次性授权码。

授权页打开后，工具等待可见的邮箱输入框或登录／授权控件，按进程 PID 将独立 Chrome 和对应标签页移到前台，并记录是否实际获得前台。仅加载出网页标题不算表单就绪；没有可见控件时记录 `authorization_page_needs_attention`，继续检查延迟加载的表单。网页尚在加载时保留窗口；会话失败时状态同步写为 `failed`，避免窗口已关闭而状态仍显示等待登录。加载诊断只记录资源域名、公开 JS/CSS 路径、状态码和错误类别，不保存请求参数、响应正文或登录表单的值。

仅检查网络、暂不发起登录时可运行 `node scripts/open-mac-claude-login.mjs --headless-preflight`。登录期间另一个终端可用 `python3 scripts/claude-vm-login-bridge.py status` 查看不含链接或凭据的状态；`get-url` 是浏览器控制器的私有 IPC，不作为人工诊断输出。会话有互斥锁，重复启动不会另开登录。普通元数据串口工具不用于收集授权码。

若授权网页持续停在安全验证，可改用普通的专用 Chrome 流程，排除自动化控制对网页的影响：

```sh
python3 scripts/open-mac-claude-login-manual.py
```

这个入口不启用 CDP、远程调试、设备模拟或网页脚本注入。独立代理临时监听 `127.0.0.1:17894`，其余 VPS、DNS、IPv6 和禁止直连的参数保持同一约束。通过 macOS 辅助功能读取公网探针页面的非表单文本，实际验证出口、停止代理后公网 IP 请求失败、恢复同一出口，再由 VM CLI 生成授权链接；探针检查完成后才开始本人登录。辅助功能检测仅返回布尔结果，不输出网页正文、账号或输入值。

窗口按进程 PID 的索引引用置前，避免多个 Chrome 实例时选到日常浏览器。为可靠读取探针，临时 Chrome 启用原生无障碍树，公网出口探针使用纯文本而非 Chrome 的 JSON 查看器；这不会启用浏览器调试或改变网络出口。每轮开始先清除旧网络检查结果，失败只记录固定格式错误类别。

本人使用 Google、Apple 或邮箱登录，并亲自完成网站要求的安全验证。这个流程不能保证网站放行，也不自动解决真人验证；安全验证循环的排查依据见 [Cloudflare 官方说明](https://developers.cloudflare.com/cloudflare-challenges/troubleshooting/challenge-solve-issues/)。403 只说明请求被拒绝，不能单独据此认定账号或 IP 被封。

在另一个终端运行同一脚本的 `status` 动作查看安全状态。官网显示授权码后，执行 `python3 scripts/open-mac-claude-login-manual.py code`，本人把码粘到本机隐藏输入框，代码经私有 stdin 交给原 VM CLI。授权码不放命令参数或聊天。若 CLI 会话过期，保留同一浏览器网页会话，执行 `authorize` 动作重新衔接；它不等于已登录。`close` 动作关闭这一组临时进程。浏览器最长保留两小时；本人关闭窗口、退出、失败或确认 VM 登录成功后清理临时浏览器配置和代理。该流程不改变宿主日常浏览器设置，也不读取现有浏览器的 Cookie。

2026-10-31 已在实际 Chrome 和 VM 中复核同一 VPS 出口，浏览器代理停止与恢复检查通过；当时 CLI 正等待本人授权。这些网络结果和离线测试都不能代替登录成功或真实模型调用验收。

2026-11-01 本人已完成官方网页授权，原 VM CLI 确认登录成功。授权回填前核对官方 `/oauth/code/callback` 页面及原登录状态；一次性授权码只经进程私有管道和串口 stdin 送回 VM，没有写入聊天、日志或文件。CLI 凭据由 guest 普通用户持有，配置目录为 0700、凭据文件为 0600。临时 Mac 浏览器、独立代理和临时配置已清理，VM 的强制 VPS 网络和宿主日常浏览器保持原设置。

本次在实际部署的 Mac → host-only VM relay 上完成了有界真实推理：`claude-sonnet` 文本请求、OpenAI Chat SSE 完整终止、客户端工具请求与同一会话的工具结果续接，以及 `claude-opus` 文本请求均通过。单次 Sonnet 文本约 2.3 秒、Opus 约 4.1 秒；这是当次短请求测量，不是延迟保证。工具验收使用无文件、Shell 或网络能力的标记回显，没有执行 guest 原生工具。监测状态为 `healthy`，列出两个模型，VM HTTPS 出口复核通过。这一结果覆盖 Mac 与 VM 后端；公司 Windows 登录、内网额度及客户端完整链路仍须现场验证。

```sh
node --test tests/claude-login-session.test.mjs tests/mac-vm-console.test.mjs
```

后台在几秒内重读登录状态。`/health` 和 `/v1/models` 仅用于元数据检查；未登录时健康响应是 200/`ok:false`，模型列表为空。VM 关机时，Mac 入口返回 503。只有实际文本、流式、工具权限和多轮调用通过后，才能认定模型接入验收完成。

### 登录持久化和续期

服务由 systemd 常驻，登录凭据保存在 VM 的持久磁盘；断开终端、断网重连及正常重启不应要求重新登录。短期访问令牌到期后，官方 CLI 使用已保存的续期凭据更新授权。健康检查只读指定配置目录的凭据状态，不运行 `claude auth status`、`doctor` 或自建 OAuth 续期请求。存在续期凭据时，访问令牌到期不会被直接当作退出登录。存储不可读与凭据缺失分别报错，不把文件故障误报为需要本人登录。元数据查询复用进程，常规探活不写凭据、不发送推理提示。中继日志仅在授权状态变化时记录时间、状态分类及是否存在续期能力，不记录令牌或账号身份。

这项改动移除了短命探活进程干扰续期的已知风险模式，不能保证上游授权永久有效。2026-11-05 排查确认过本机访问和续期令牌同时为空；当时没有足够日志证明发生原因。与之高度相关的[上游问题报告](https://github.com/anthropics/claude-code/issues/95822)描述了短命 CLI 在续期写入完成前退出、使已轮换令牌丢失的情况，不能仅凭相似症状断言本机根因。若续期凭据已被撤销或丢失，仍须本人重新授权一次；重启服务不能恢复它。[官方认证说明](https://code.claude.com/docs/en/authentication)。

2026-11-05 本人用日常 Chrome 和宿主全局代理完成重新授权，同一浏览器的公网出口已与 VM 的 VPS 出口核对一致。原 VM CLI 确认登录成功，访问及续期凭据已持久保存，私有目录恢复全部 12 个模型，公网账号可见 Sonnet 和 Opus，订阅用量接口正常。本轮登录检查没有发送模型推理请求；跨令牌到期的自动续期仍需后续观察，不能把元数据检查当作完整调用验收。

## 协议范围和检查

支持 `/v1/messages`、`/v1/messages/count_tokens`、`/v1/chat/completions`、`/v1/models` 和 `/health`。Chat Completions 支持文本、用户图片、普通 function 工具、`tool_choice: auto/none`、JSON 或 SSE。原始思考签名和历史索引留在 VM 内。

OpenAI Responses → Claude、强制指定工具、strict schema 和 JSON schema 输出尚未映射；CLI 不提供的 `temperature`、`top_p`、`stop` 选项传入时明确报错。relay 重启不能恢复正在等待客户端工具结果的活跃回合，该情况返回冲突错误。

相关单元测试：

```sh
node --test tests/openai-chat-gateway.test.mjs tests/claude-vm-gateway.test.mjs \
  tests/claude-cli-provider.test.mjs tests/claude-sdk-worker.test.mjs \
  tests/anthropic-gateway.test.mjs tests/anthropic-http-provider.test.mjs \
  tests/tcp-forwarder.test.mjs tests/relay-control.test.mjs
```

实际 CLI 的离线环境检查在安装好同一固定版本 SDK 的目录运行：

```sh
node scripts/verify-claude-context-offline.mjs /absolute/path/to/claude
```

它使用临时空白配置和 loopback 模拟 API，检查有/无客户端系统提示及完整工具回合，不读取原有账号凭据，不请求真实模型；输出仅含验证元数据及已遮盖路径的环境片段。报告分别列出协议检查、环境上下文和虚拟化标记，命令正常完成不代表环境上下文已消除。加 `--require-no-environment` 可严格要求无自动环境信息，当前固定版本会因此失败。环境检查不能替代目标账号的真实推理验收。
