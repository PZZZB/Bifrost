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

## 登录与验证

由本人打开 VM 的 `claude` 用户终端，执行：

```sh
claude auth login --claudeai
```

按官方 CLI 提示完成订阅登录，手动授权码填回同一 VM 终端。不要把授权码或 OAuth 文件交给客户端或上传仓库。若授权网页由 Mac 浏览器打开，那一段浏览器访问使用 Mac 的网络环境，需要另行保证符合所需出口；VM 的网络限制不会自动接管 Mac 浏览器。

后台在几秒内重读登录状态。`/health` 和 `/v1/models` 仅用于元数据检查；未登录时健康响应是 200/`ok:false`，模型列表为空。VM 关机时，Mac 入口返回 503。只有实际文本、流式、工具权限和多轮调用通过后，才能认定模型接入验收完成。

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
