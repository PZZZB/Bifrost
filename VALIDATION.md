# 当前验证记录

起始日期：2026-10-18。项目初始位置为 `D:\CodexAccountBridge`，2026-10-20 已迁移到 `D:\Bifrost`。以下按发生时间记录。

## 已验证

- Node.js v24.16.0；本机官方 Codex CLI 为 `0.162.0-alpha.17.2`。
- `node --test tests/*.test.mjs`：91 项通过，包含模型分流、完整目录合并、zstd 压缩、B 离线时保留 A、会话归因、配置迁移、token 持久化、原生网页搜索路由及既有授权/代理检查。
- `npm run check`、后端模块及原生客户端验证脚本的语法检查通过。
- 独立审查覆盖 A/B 授权隔离、别名映射、模型目录、压缩请求、离线等待预算与会话归因。发现的问题已修复并增加回归检查：真实 thread-id 优先于缓存亲和性 session-id。
- 使用真实 Codex app-server 和临时独立 CODEX_HOME 验证配置安装及恢复，保留注释与无关配置。这没有修改真实用户配置。
- 本机服务启动，健康检查通过；真实管理 API 可读取现有 Provider ID，并确认可接入。
- 浏览器可显示管理页面，禁用尚未满足条件的验证及安装按钮。
- “登录账号 B”可启动独立的原生 OAuth 流程，并打开 OpenAI 官方账号选择页面。
- “手机授权”可调用本机原生设备码流程，返回 `auth.openai.com/codex/device` 官方入口及一次性代码。
- 账号 B 已完成官方登录、绑定及真实推理验证；同一网关返回了非空的 `response.completed` 回复。
- 原生 Codex 使用临时 Provider 覆盖完成本机 shell 工具调用，读出随机验证文件，最终回复完全匹配。
- 已将当前 `custom` Provider 更新为四字段配置：网关地址、HTTP/SSE、网关认证头、模型目录 URL。旧版三个字段的原恢复值保留；原账号 A 的登录凭证保持原位置。
- 使用真实隔离 app-server 验证了 v2 安装/恢复，以及 v1 升级/恢复。实际用户配置已升级完成，`needsUpgrade=false`。
- 真实原生 `model/list` 返回 11 项，包含原有 `gpt-6.1-sol` 与恰好两个新增别名及正确显示名。证据：`.state/catalog-proof.json`。
- 以下三条实际路线均通过 `npm run verify:codex -- --installed --model ...`，没有临时 Provider 覆盖。每个会话完成 1 次本机工具调用和 2 次对应账号的模型请求，随机文件内容完全匹配，同一会话另一个账号的请求数为 0。

| 模型 | 实际路由 | 证据 |
| --- | --- | --- |
| `gpt-6.1-sol` | A | `.state/client-proof-1792322115189-5418ca/result.json` |
| `B-gpt-6-astra` | B | `.state/client-proof-1792322115195-a0e474/result.json` |
| `B-gpt-6.1-sol` | B | `.state/client-proof-1792322047538/result.json` |

并行验收中确实存在其他 A 流量，因此通过 CLI 的 `thread.started.thread_id` 与网关对应会话计数归因，不用全局请求增量判断账户串用。

## Token 记录验证

- 独立端口 43156 使用真实 A/B 授权验证新版本，未改动主网关地址或用户配置。B 返回输入 27、输出 8、总计 35 token；A 原生客户端完成本机 shell 工具回合，两个模型请求共返回输入 44,658、输出 80、总计 44,738，其中缓存输入 35,584。A 的会话证据：`.state/client-proof-1792330271476-41e1bd/result.json`。
- 管理 API 汇总包含上述三个真实请求，每个请求都有上游 usage。原始 attribution 未持久化，记录只含允许的元数据与规范 token 字段。
- 停止独立验证服务后重新打开实际 `usage.jsonl`，三个请求的总量及 A/B 分项与停止前的管理 API 快照完全一致。快照：`.state/token-proof.json`。
- 单元测试覆盖完整/缺失用量、失败及中断、重复终止事件、缓存与思考子集、并发去重、重启重放、损坏尾行修复、中间损坏拒绝、写入失败隔离、下游失败后保留已完整接收的 JSON 用量，以及管理接口认证。
- 原生网页搜索的 `/alpha/search` 路径已补充，mock 验证 A 原始正文和授权、B 别名及授权替换。新版主网关运行后，当前 Codex 的真实网页工具已成功读取官方网页并查找页面内容。
- 主服务于 `2026-10-18T13:40:44Z` 等待空闲后完成更新，恢复此前三个真实验证请求的 token 记录。生产管理 API `/api/token-usage` 已返回后续真实 A 流量和既有 B 验证记录，无记录错误。部署及线上快照：`.state/token-deploy.json`、`.state/token-live-proof.json`。

## 等待桌面应用验证

- 当前已打开的 Codex 桌面应用需要保存工作后重启，才会重新加载接入配置。尚未重启或结束用户的当前对话。
- 重启后检查桌面模型选择器显示 `B-GPT-6 Astra`、`B-GPT-6.1 Sol`，并检查现有长会话续接。新启动的原生 CLI 已通过模型目录及三条已保存配置路线验证。

原有模型现在沿原 A 地址与授权转发；只有两个明确的 B 别名替换授权及上游模型名。B 不可用时拒绝 B 请求，不回退到 A。网关服务目前在本机后台运行；没有创建开机自启任务，A/B 模型请求均需要网关继续运行。

尚未验证的边界包括另一台内网主机部署、压缩上下文接口，以及 Codex 桌面应用重启后的完整操作。它们不能用 mock 测试或模型目录成功代替。

## With / 虚拟机准备（2026-10-19）

- 当前 Windows 用户的 With daemon 通过原生 pipe 只读确认已登录，目录含可用的 `claude-opus-5.5`。没有导出 With 登录凭证。
- 原生 MCP 单项注册成功，其他已有项保留。实际 owner 配置的 URL、streamable-http、Bearer 和 30 分钟工具等待配置在内存中核对；`mcp_status_get` 返回已连接、无错误、1 个 relay 工具。重复准备已实证走零连接、零注册的复用分支。
- 管理服务在 A/B 请求空闲后更新，PID 与 43155 / 43157 / 43158 三个监听一致。新服务重放原用量文件，With 使用同一个 `UsageLedger` 写入和汇总。
- 用户确认 Windows 管理员弹窗后，脚本准备了 VMnet1 的指定源地址 / 指定 Node 程序 / TCP 43157 放行及恢复清单。IPv6、UDP、原代理和其他端口配置保留。
- 虚拟机原生第三方配置读回：部署模式 3p，唯一模型 `claude-opus-5-5`，默认模型固定；未发现覆盖此配置的 managed provider。虚拟机持有独立网关密钥。已有 UE CLI 和 ADB 环境配置保留，Desktop 继续运行，等待用户退出并重开。
- 从虚拟机使用专用认证读取 `/health` 和 `/v1/models`，确认登录和 relay 就绪、模型目录仅一项；不调用 `/v1/messages`。准备证据：`.state/with-deploy.json`、`.state/with-vm-final-proof.json`。
- 新增测试覆盖原生 pipe 与业务封装、MCP 注册幂等和并发保护、网关隔离、SSE/用量、工具暂停和结果接续、取消、篡改拒绝及坏 With 配置对 Codex 启动的隔离。虚拟机安装/恢复脚本在 PowerShell 5 和 7 的 15 项离线检查通过。

按用户要求，本轮没有发送 With 真实推理、创建 With 聊天或执行真实工具回合。当前 With 推理请求数为 0。完整回合、实际工具命名及协议兼容由用户第 5 步验证；不能把上述准备检查当成推理或工具验收通过。会话桥不提供原生 Anthropic 的全部参数/模态保真，也没有证实 With 原生工具的执行前硬白名单，具体边界见 README。

## CodeBuddy 渠道准备（2026-10-19）

- 官方员工 OAuth 已完成，本网关核实用户名 `jiahaoguo`，自身取得的授权使用 DPAPI CurrentUser 加密保存。更新主服务后自动恢复认证；没有复制原生 CodeBuddy 的登录凭证。
- 当前独立授权对 `/v3/config` 的请求返回 HTTP 200 / code 0，但仅有功能配置，缺少模型列表。读取当前 CodeBuddy CN 的同 UID 目录缓存后，确认实际模型 ID 为 `claude-opus-5.5`、名称 `Claude-Opus-5.5`、`credits=x2.17`。目录原始保存时间为 `2026-10-19T09:24:19.577Z`，不是实时权限或最后刷新成功时间；实际员工 Token 倍率仍未验证。
- 公开别名为 `claude-codebuddy-opus-5-5`，与 With 共用 `192.168.168.1:43157`。按模型固定渠道，With 与 CodeBuddy 用量分别记录。目录缺失才允许读取同 UID、30 天内的只读缓存；HTTP / 业务拒绝、明确空列表、注销或取消均不能使用缓存。
- 232 项 JavaScript 检查通过，包含模拟模型协议、多轮工具、断流/取消、凭证竞态、实际本机 DPAPI 往返和 SQLite 元数据读取。SQL 定点投影模型元数据；测试覆盖不同账号、过期、非法禁用标记、嵌套非白名单字段及原数据库不变。
- 独立审查发现的折扣字段类型及 HTTP 状态校验问题已修复并复核。虚拟机脚本修正了重复设置所有者引起的非管理员权限错误，仅更新 DACL 并保留可信所有者。PowerShell 5 和 7 各 19 项离线检查通过，未在测试中调用虚拟机或修改防火墙。
- A/B、With 与 CodeBuddy 活跃数均为 0 时，将主进程从 PID 108436 更新到 PID 121196。A 的配置和认证文件 SHA256 保持一致；With 登录、B 绑定和 CodeBuddy 认证恢复正常。证据：`.state/codebuddy-catalog-deploy.json`。
- 已执行 `-IncludeCodeBuddy -ModelsOnly`，安装脚本成功更新虚拟机 8 个配置文件。随后用只读取模型字段的独立命令检查这 8 个文件，两个模型配置均恰好包含 `claude-opus-5-5` 与 `claude-codebuddy-opus-5-5`。证据：`.state/codebuddy-vm-readback.json`、`.state/codebuddy-vm-configured.json`。已有端口与防火墙规则没有在此升级中改写。
- 管理页显示已登录、本机目录已确认、`x2.17` 源数据及“待本人实测”；截图：`.state/codebuddy-ready.png`。虚拟机 Desktop 仍在运行，需要用户完整退出并重开后加载新模型列表。

本轮 With 与 CodeBuddy 的真实模型请求数均为 0。按用户要求，真实聊天、工具回合、实时权限及实际扣费留给用户验收。CodeBuddy 的图片、附件和思考兼容更新见下节；With 的模态和会话边界保持前述记录。有效缓存提示经过校验后忽略，命中与用量以服务端实际返回为准。

## CodeBuddy 图片、附件与思考兼容更新（2026-10-19）

- 本地图片转换支持 JPEG、PNG、GIF、WebP 的 base64 数据或公开 HTTPS 引用，输出 Chat Completions `image_url` 内容块。嵌入图片解码后每张最多 5 MiB；单次请求最多 100 张，计入历史、文档和工具结果。HTTPS 引用不由网关下载，未在本地核实远程图片的真实格式或尺寸。
- 文档支持纯文本 `document` 和预解析 text/image 内容，保留 title/context 文本前缀、原始正文及图文顺序；工具结果使用同一转换。未经解析的 PDF、Office 二进制、视频、音频、文档 URL 和 `file_id` 返回安全 400，须先解析为文本或图片。原始文件上传、下载、宿主文件读取和文档引用生成均未接入；`citations.enabled=true` 返回 400。
- 思考采用 adaptive；display 为 summarized 时展示 Chat `reasoning_content`，可见摘要仍以空 signature 回放。默认及 omitted 隐藏摘要正文，并返回空 thinking 块及 `bridge-codebuddy-v1:` 前缀的 AES-GCM 密文接续标记，SSE 使用 signature_delta。effort 支持 low、medium、high、xhigh，默认 high；enabled + budget、disabled、effort=max 均返回 400。
- 接续标记属于本网关状态，不是厂商签名；其密文绑定登录 UID、真实模型和隐藏摘要，跨账号或模型回放返回 403。原生非空签名及 redacted thinking 仍返回 400。完整接续 JSON 上限 32 MiB，入口请求 JSON 上限 64 MiB。
- 独立密钥默认保存于 `%USERPROFILE%\.codex-account-bridge\codebuddy-thinking-key.dpapi.json`，使用 DPAPI CurrentUser 按需加载，磁盘不保存隐藏摘要明文。同一密钥跨重启恢复所需的 DPAPI 保存、重载及密文恢复已在本机离线验证；未发送模型请求。密钥损坏时拒绝 CodeBuddy 模型请求，管理页、A/B 与 With 启动保持可用。
- 新增的图片、文档及思考转换检查使用离线 fixture，覆盖顺序、编码与大小、私网 URL 拒绝、缓存提示计数、附件失败及思考参数和签名拒绝。它们验证转换和拒绝行为，不能作为模型理解图片、解析附件、展示思考或完整工具回合已成功的证据。
- 最终全量 `npm test` 为 277/277，`npm run check` 通过。独立复审确认取消、文档分隔、隐藏摘要接续和账号/模型校验闭环。最终日志：`.state/codebuddy-media-tests.log`。管理页 HTML 检查确认 111 个 ID 唯一且现有 JavaScript 绑定完整。
- 真实客户端能否在隐藏摘要时保留空 thinking 块、完整回传本网关接续标记并继续工具回合，仍待本人验收；离线密文往返不等同于客户端或真实模型回合已通过。
- 管理页保留 `native-cache` 来源、原始保存时间、`x2.17` 目录源数据和“待本人实测”。此次能力更新没有重新发起员工登录，也没有调用真实模型或修改虚拟机。
- 两次确认 A/B、With、CodeBuddy 均无活跃请求后，主进程从 PID 121196 更新到 PID 8848。A 的配置和认证文件 SHA256、B 绑定均核对一致，原用量账本恢复；43155、43157、43158 三个监听属于新主进程。With 登录和 CodeBuddy 认证、目录就绪状态恢复，两个渠道真实模型请求数仍均为 0。部署证据：`.state/codebuddy-media-deploy.json`。
- 已刷新管理页并核对 CodeBuddy 登录、目录来源、新能力说明和请求数，页面证据：`.state/codebuddy-media-ready.png`。With 路由本身仍使用原来的文本及工具会话适配。

## CodeBuddy 错误展示修复（2026-10-19）

- 修复管理状态遗漏渠道 `lastError` 的投影：原有页面现可显示 JSON、SSE 或连接失败产生的最近一次已脱敏错误。成功请求会清除最近错误，累计失败数保留。
- 离线测试覆盖附件拒绝文案、对象字段白名单、凭证脱敏及恢复清空；独立复审通过。全量 `npm test` 为 278/278，`npm run check` 通过，日志为 `.state/codebuddy-error-tests.log`。
- 两次空闲检查后更新主进程 8848 至 37632。A 配置和认证、B 绑定及账本恢复验证通过，三个监听端口一致；With 和 CodeBuddy 真实模型请求仍为 0。部署证据：`.state/codebuddy-error-deploy.json`。已通过管理 API 核对新 `lastError` 字段存在。
- 用量历史仅保留请求时间、渠道、HTTP 状态、完成状态及用量，不保存错误正文或附件。客户端未发送的文件内容不在网关可检测范围内；真实 Claude 客户端的报错展示仍由用户验收。

## Claude Desktop 本地网关地址修复（2026-10-19）

- 当前安装版本的原生 Gateway URL 校验仅接受 HTTPS 或 HTTP loopback；此前 `http://192.168.168.1:43157` 因而触发 provider setup 警告。实际原生代码的 `inferenceGatewayBaseUrl` 使用 `gs({allowLoopbackHttp:true})`，loopback 集合包含 `127.0.0.1`、`localhost` 和 `[::1]`。此错误与第三方模式的独立历史目录是两件事。
- 宿主服务额外允许且仅允许 `Host: 127.0.0.1:43157`，仍绑定 VMnet1 的 `192.168.168.1:43157`，要求实际来源 `192.168.168.10` 和专用网关密钥。伪造转发头不能改变来源校验。
- 修复前虚拟机只读预检确认 IP Helper 正在运行且启动类型为 Automatic，43157 没有已有转发规则或监听。实际 Mihomo 配置仍排除 `192.168.168.1/32`，物理内网路由及到宿主 43157 的 TCP 连接成功；无需修改现有 TUN 或 VPS 链路。证据：`.state/claude-loopback-preflight.json`。
- 更新后的 JavaScript 全量检查为 282/282，`npm run check` 通过，日志为 `.state/claude-loopback-js-tests.log`。包含真实来源、专用密钥、错误或重复 Host 的离线授权矩阵。
- 修改前另记录八个受管理配置文档的非 URL 字段摘要、guest 恢复清单的非 URL 摘要及三个历史目录的文件元数据摘要。历史分别为原生 Desktop 233 项、3p Desktop 198 项、Claude Code 57 项；没有读取聊天正文。基线：`.state/claude-loopback-scope-before.json`。
- 修复脚本的隔离 fixture 在 PowerShell 5、7 分别通过 21 项，配置脚本分别通过 20 项；宿主与 guest AST 均无语法错误。覆盖重复 Apply/Restore、未知映射及监听、权限/服务、元数据失败、部分写入、中断恢复、并发 manifest 编辑及原恢复信息保留，测试没有调用实际 VM、网络、服务或防火墙。
- 两次确认请求空闲后，主进程从 37632 更新至 74684；A 配置与认证文件、B 绑定和用量账本核对通过，三个监听均属于新进程。With 与 CodeBuddy 登录及目录恢复，真实模型请求仍均为 0。证据：`.state/claude-loopback-deploy.json`。
- 实际执行 Repair Apply 成功，使用 guest 现有专用密钥经 `127.0.0.1:43157` 只读检查 `/health`、`/v1/models`；两个 profile 与 guest/host manifest 的已安装 URL 均迁移为本地入口。原生 Windows portproxy 仅监听 guest `127.0.0.1:43157`，后端固定为宿主 `192.168.168.1:43157`。修复结果：`.state/claude-loopback-applied.json`。
- 独立读回对比确认八个配置文档除 URL 外的所有字段、guest manifest 除已安装 URL 外的所有恢复信息、Mihomo 配置及三个历史目录的文件名/大小/修改时间摘要一致。精确映射与本地监听存在，IP Helper 的原运行和启动状态保留。证据：`.state/claude-loopback-final-proof.json`、`.state/claude-loopback-postflight.json`。
- 宿主 manifest 与修复 journal 均为 installed，With 和 CodeBuddy 状态就绪、真实请求数均为 0：`.state/claude-loopback-provider-proof.json`。没有修改 Claude 安装程序、切换模式、导入历史或执行模型回合；Desktop 目前未运行，重新打开后的黄色提示和真实聊天/工具回合由用户确认。

## 暂停 With，仅使用 CodeBuddy（2026-10-19）

- 用户重新打开 Desktop 后，原地址格式错误已转为 Gateway 测试失败。该次自动测试选择较短的 With alias，发送 `max_tokens:1`、用户文本 `.` 的非流式 Messages 请求。With 记录一次 HTTP 502 和通用会话中断，CodeBuddy 当时请求数为 0；此提示不能直接证明余额或认证问题。随后用户要求暂停 With，不再继续其会话错误调查。
- 共享 VM 入口支持 CodeBuddy 独立运行：私有 `with.json.enabled=false` 仅暂停 With，保留原专用密钥及其他配置；CodeBuddy 使用自身启用状态和独立授权。停用 With 时不创建或连接其 daemon，不启用 43158 MCP relay，不注册 With 模型路由，CodeBuddy 失败也不回退 With。
- 新增 `Configure-WithVm.ps1 -CodeBuddyOnly`；它与 `-IncludeCodeBuddy` 互斥，允许已有双渠道列表缩减为唯一 `claude-codebuddy-opus-5-5`。连接修复及安装脚本按所选模型检查对应渠道，不要求 With 就绪；最初的 Original、Backup 和恢复所有权保留。
- JavaScript 全量 292/292、`npm run check` 通过；PowerShell 5 和 7 分别通过 Configure 25 项、Repair 22 项。独立复审及 35 项共享网关/服务 mock 检查通过。离线验证原生 Desktop 的非流式探测格式可被 CodeBuddy 适配器接受；真实上游能否在其 8/10 秒测试预算内完成尚未验收，没有伪造测试成功。
- 两次确认空闲后，主进程从 74684 更新至 8676。A 配置及认证、B 绑定和账本核对通过；只保留 43155 与 43157 监听，43158 已停止。CodeBuddy 独立授权与目录就绪。部署证据：`.state/codebuddy-only-deploy.json`。
- 实际执行 `-Action Apply -ModelsOnly -CodeBuddyOnly` 成功更新 VM 8 个受管理文档；两个 profile 均只列 CodeBuddy alias，默认模型启用，地址仍为 `http://127.0.0.1:43157`。认证 GET 读回的模型目录及 provider 均只有 CodeBuddy。除模型列表外的配置字段、原恢复信息、Mihomo 配置和三个历史目录的文件元数据摘要均一致。证据：`.state/codebuddy-only-vm-applied.json`、`.state/codebuddy-only-final-proof.json`。
- 本轮没有发送 CodeBuddy 真实推理；最终计数和状态见 `.state/codebuddy-only-provider-proof.json`。Desktop 当前正在运行，需由用户完整退出并重开，加载单渠道列表后再验证启动测试、聊天和工具回合。

## CodeBuddy SSE 结束标记兼容修复（2026-10-19）

- 单渠道配置生效后，用户触发的 Desktop 启动检测确实进入 CodeBuddy：记录一次 HTTP 502，最近错误为“CodeBuddy 返回了未支持的结束原因”。这只能证明原转换器严格枚举拒绝了响应，原始标记未保留，不能据此判断额度或模型权限。
- 本地 Magpie 源码 `internal/gateway/chattidy.go` 明确记录 copilot.tencent.com 在未结束片段使用 `finish_reason:""`。转换器现将空字符串视为未结束，与 `null` 一致；已结束状态检查与终态赋值使用同一规范值。仍要求 `stop/length/tool_calls` 中的明确终态及 `[DONE]`，不会把空标记、断流或未知原因当作成功。
- 原生 `finish_reason:error` 明确报错，仅投影安全整数 `status_code/code`；其他未支持值只显示已知枚举或类型/字符串长度，避免将任意上游消息、正文或凭据放入错误。没有新增未经证实的终止别名成功映射。
- 新增 5 组回归覆盖流式与非流式、空标记片段、工具参数片段、缺失终态或 DONE、终态后的额外内容、原生错误码及未知值脱敏。provider 26/26、全量 297/297、`npm run check` 通过，独立审查通过。日志：`.state/codebuddy-finish-js-tests.log`。
- 两次确认空闲后更新主进程 8676 至 82660。A 配置/认证及暂停 With 的配置哈希、B 绑定和账本核对通过；CodeBuddy 运行及目录就绪，仅保留 43155、43157。没有修改虚拟机连接、模型列表、主题或历史。部署证据：`.state/codebuddy-finish-deploy.json`。
- 一次固定输入的启动检测脚本已准备但尚未执行，已询问用户是否允许此单次最小实测；没有重放模型请求。原始失败标记及修复后的真实检测结果仍待用户选择或客户端重试，不能用离线检查替代。

## 经授权的单次 Desktop 检测及字段诊断（2026-10-19）

- 用户明确允许一次最小启动检测后，从 VM 使用原生配置中的专用密钥发送一次固定请求：`max_tokens:1`、用户文本 `.`、非流式、无工具。脚本使用 CreateNew 尝试标记阻止重放，没有重试。结果为 HTTP 502、7618 ms，错误变为“CodeBuddy 返回了尚未支持的内容类型”。计数读回为请求 1、失败 1、活跃 0。证据：`.state/codebuddy-desktop-once-result.json`、`.state/codebuddy-desktop-once-channel.json`。
- 新错误唯一来自 delta 中存在白名单外且不为 null/空字符串的字段。旧错误没有保留字段名；只读核对 Magpie 与 CodeBuddy 官方安装源码后仍不足以确定该次真实字段，不据此猜测签名、元数据或音频映射，也不将未知内容丢弃后报成功。
- 已补安全结构诊断：最多列出 8 项受控公开字段名及类型、字符串/数组长度；动态字段名仅报名称长度和值类型。全部字段值、正文和子对象隐藏，原来的拒绝条件保持。未知音视频、扩展内容仍明确失败。
- 新增 4 组双模式 fixture 验证公开字段名、动态密钥名称与字段值脱敏、诊断上限及旧拒绝行为。provider 30/30、全量 301/301、`npm run check` 和独立审查通过。日志：`.state/codebuddy-delta-js-tests.log`。
- 两次空闲检查后更新主进程 82660 至 82976；A 配置/认证、暂停 With 的配置、B 绑定和账本核对通过，CodeBuddy 就绪，仅监听 43155、43157。部署仅增加错误诊断，没有修改 VM 配置或运行额外模型检测。证据：`.state/codebuddy-delta-deploy.json`。
- 单次授权已用完。已另询问最多 2 次同样最小检测，分别用于取得字段信息和修复后验证；未获得新的明确答复前不执行。当前仍未通过真实 Desktop 检测，不能将 301 项离线测试或目录就绪当成推理已成功。

## CodeBuddy 扩展元数据接续修复（2026-10-19）

- 用户另行明确授权最多 2 次相同的最小检测。首个请求已从 VM 发出，仍为 `.`、`max_tokens:1`、非流式、无工具、无重试。结果 HTTP 502、5201 ms；安全诊断为字段名长度 12、值类型 object，不保留动态字段名、字段值或回复正文。证据：`.state/codebuddy-budget2-1-result.json`。预算和两个独立尝试 ID 记录于 `.state/codebuddy-probe-budget-2.json`，最终结果见下文。
- 对本机官方 CodeBuddy CN 扩展代码的只读检查确认，原生流提取器保存最后一个非 `null`、可序列化的 `delta.extra_fields`，并在下一轮通过对应 assistant 的 `providerOptions.openaiCompatible.extra_fields` 回传。空对象、空数组和其他 JSON 值没有省略特判。此字段名长度与诊断相符，但首个诊断本身尚不能确认真实字段名。
- 转换器据原生合同增加元数据接续：使用现有 AES-GCM 标记加密保存并逐 assistant 还原，继续绑定登录 UID 和真实上游模型；不解释或展开元数据内部字段。代码检查、部署和剩余一次真实检测的结果见下文。没有修改 VM 配置、历史或客户端安装文件。
- 现有三字段接续标记继续兼容，新标记可含 `extra_fields`；完整 JSON 仍限 32 MiB，元数据嵌套最多 256 层。无思考内容、显示摘要和隐藏思考三种情况均有元数据接续路径，不重复回放摘要；同一 assistant 的重复元数据标记拒绝。终态后允许已知的空占位和元数据，仍拒绝新增正文、工具或未知字段。空 `tool_calls:[]` 不再分裂连续文本块。
- 状态模块 22 项、provider 37 项离线检查通过；全量 `npm test` 为 317/317，`npm run check` 通过。覆盖加密、账号/模型绑定、最后非 `null` 覆盖、空容器及标量、跨消息隔离、原型键安全、非 JSON/无限数/过深结构、UTF-8 限值和未知字段失败。日志和最终源码哈希：`.state/codebuddy-extra-fields-js-tests.log`、`.state/codebuddy-extra-fields-test-proof.json`。这些检查没有调用真实 CodeBuddy 模型。
- 最终实现与 fixture 独立复审通过。两次确认空闲后，主进程从 82976 更新至 19700；A 的配置和认证、B 的绑定、暂停 With 的配置哈希及账本恢复均核对通过，只保留 43155、43157。部署证据：`.state/codebuddy-extra-fields-deploy.json`。部署后源码和测试哈希与通过检查时一致。
- 使用本批剩余的一次授权，从 VM 发送相同固定请求，HTTP 200、4899 ms，消息完整结束为 `end_turn`。结果仅保留内容块类型、状态、耗时及用量，不保留回复正文或密文接续标记。证据：`.state/codebuddy-budget2-2-result.json`。本批已发 2 次、剩余 0，未重试，后续没有再调用模型。
- 成功请求的上游实际报告输入 407、输出 81、合计 488 token，账本中的模型为 `claude-codebuddy-opus-5-5`，真实上游模型为 `claude-opus-5.5`，HTTP 200、状态 completed。`max_tokens:1` 是发送的请求参数，不据此假定只消耗一个输出 token；缺失的缓存和思考分项继续保持未知。失败检测未返回的用量也不视为零。最终证据：`.state/codebuddy-extra-fields-final-proof.json`。
- 读回渠道为请求 1、成功 1、失败 0、活跃 0、最近错误为空；以上渠道计数从本次进程启动起计算，历史记录仍在账本。此结果证明从 VM 经真实网关的最小 Messages 请求已通过，未直接操作 Desktop 的“Check again”，完整聊天、客户端接续标记保留及真实工具回合继续由用户验收。

## 临时切回 Claude 原账号模式（2026-10-19）

- 用户为对比工作区虚拟化提示而要求切回原模式。核对原安装配置发现 `disableDeploymentModeChooser=true` 隐藏了 Claude.ai 登录入口；官方源码同时确认该限制优先于本地 `deploymentMode:1p`，所以仅改模式不足以保证切回。
- 已在 VM 的两个既有 profile 将该限制设为 `false`，并将 LocalAppData 与 MSIX 映射中的四个模式配置设为 `1p`。只修改六个受管理 JSON 的对应字段，并同步 guest manifest 的 Installed 值；原 Original 恢复值、网关地址、模型、密钥、其余配置均保留。host manifest、转发、网络、虚拟化设置和会话目录没有修改。
- 一次性脚本复用现有安装脚本的 JSON、字段校验和原子写入函数；实际执行前已通过语法检查和独立复审。写入前检查受管理字段及文件哈希，七个原始文件备份留在 guest 原私有状态目录下的 `mode-switch-*` 子目录；失败时仅在当前内容仍匹配本次写入时回滚。
- 执行后逐文件读回及恢复清单字段校验通过。报告确认下一次为 `1p`、Claude.ai 登录入口允许、原恢复值和网关配置保留。没有停止或启动 Desktop，也没有发送模型请求；读回时 Desktop 已不在运行。用户从虚拟机开始菜单重新打开 Claude 后自行对比。证据：`.state/claude-return-1p-result.json`。原模式是否仍出现工作区提示尚未验证。

## Claude Desktop 模式切换快捷方式（2026-10-19）

- 已在现有虚拟机 `C:\Users\Developer\Desktop` 安装 `Claude - Account.lnk` 和 `Claude - CodeBuddy.lnk`。两者使用系统 PowerShell 调用用户私有 tools 目录中的切换器，分别设置原账号 `1p` 和 CodeBuddy 网关 `3p`，并保留中文提示。
- 切换器仅更新六个受管理配置的模式及 chooser 字段，并同步 guest 恢复清单的 Installed 值。原恢复值、网关授权、地址、模型及其他设置保留。切换使用互斥、哈希检查和有界事务记录；遇到并发修改时拒绝覆盖。两种模式继续使用各自的历史和设置。
- Claude 未运行时，用户点击快捷方式会通过当前官方 MSIX 的稳定 AppUserModelId 打开应用；正在运行时只保存模式并提示从托盘退出后重开，不强制停止进程。安装器自身不切换模式、不启动应用、不调用模型。
- 核心 fixture 在 PowerShell 5、7 分别通过 17 项；最终快捷方式 fixture 在两个引擎分别通过 12 项。覆盖双向切换、重复执行、恢复信息、并发修改和中断处理，以及实际隔离目录中的 COM 快捷方式读回、同名冲突、写入回滚、诊断脱敏和不启动应用。最终源码经过独立复核。
- 首次实际安装在最终快捷方式读回阶段失败并完整回滚。独立 guest Temp 诊断确认：同一份、相同 SHA256 的 `.lnk` 使用 ASCII 文件名时读回正确，使用两个中文文件名时 WSH 返回空 Target、Arguments 和 WorkingDirectory。此证据仅限当前 VM 的 Session 0 环境；最终改用 ASCII 文件名，保留原来的严格校验。证据：`.state/claude-link-diagnostic.json`。
- 最终实际安装成功。独立读回确认两个快捷方式的目标、参数、工作目录和隐藏窗口设置正确，已安装脚本 SHA256 与最终源文件一致。随后在 VM 执行已安装切换器的 `-Mode Account -Quiet -NoLaunch`，结果为成功、Changed=false、Started=false；没有切到网关模式或打开应用。
- 安装及上述验证前后，六个受管理配置文件和 guest manifest 的完整哈希、Original 恢复值摘要均一致，四个模式字段仍为 `1p`。本轮模型请求为 0，未改变用户正在对比的原账号模式。证据：`.state/claude-mode-shortcuts-final-proof.json`、`.state/claude-mode-shortcuts-installed.json`、`.state/claude-mode-shortcuts-verify.json`。实际双击后的界面与完整聊天仍由用户验收。
- 自动审批拒绝清理旧临时 harness，理由为 `blocked by policy`；该单个 `.state` 测试脚本保留，不属于已安装的运行文件。

## 通用 Messages 与 Claude CLI 后端准备（2026-10-20）

- 新增与部署位置无关的 Anthropic Messages 核心、精确模型路由和 HTTP 上游。已有 With/CodeBuddy 入口保留兼容适配；单个渠道的坏配置不会回退到其他渠道。配置同时保护 Codex 主端口，拒绝明显自环。
- CLI 请求保留原始 JSON 字节，映射模型时保留大整数、指数和负零；会话和子智能体标识透传。客户端认证及 Cookie 不发送到独立上游。SSE、断流取消及缓存用量归一化通过本机离线 fixture 验证；多个 Claude 模型共享渠道统计，健康状态按各模型聚合。
- 此阶段全量 JavaScript 测试为 414/414，`npm run check` 通过。CLI 部署脚本的首批认证来源、目录、warmup 与进程身份回归在 PowerShell 5.1、7.6 各 12/12 通过；这些检查没有执行真实模型。
- 已核对 Magpie 源码：Claude 订阅通过真实 CLI 的双向 stream-json 和客户端 MCP 工具桥接。短 system 模式仍会重建历史表达；CLI 自身缓存不等同原 1p 的缓存。结构化用户提问、权限交互、跨渠道历史、导入后的续聊及实际缓存命中仍由用户验收，不以离线检查宣称原生等价。
- 曾在宿主独立目录安装并校验 Magpie 0.1.1293、官方 Claude Code 2.1.304，完成无推理的元数据检查。用户随后指定 CLI 必须运行于虚拟机；已按 PID、路径和创建时间核对后停止本轮宿主登录与后端。宿主没有完成该 CLI 订阅登录。
- 最终部署方向为虚拟机保存 Claude OAuth、CLI 会话和缓存，宿主保留模型分流及 CodeBuddy 适配。宿主只能持有独立转发密钥；虚拟机部署、登录入口、网络与模型表的实际落地结果另行记录。当前原 Claude Desktop 模式、历史和完整回合验证尚未变更。

## 自研 Claude CLI 通道（2026-10-20）

- 按用户澄清，Magpie 只作为源码参考，不是 Claude 通道的运行依赖。原宿主 Magpie 和未完成的宿主 CLI 登录已停止。本项目改由自己的 `ClaudeCliHub`、固定 `@anthropic-ai/claude-agent-sdk@0.3.304` 和官方 CLI 实现协议适配。
- CLI 原生会话按 session、agent、parent 及上下文隔离，使用原生 session ID 恢复。首次接收外部历史时明确标注角色导入一次，后续仅提交增量；仅移动缓存标记不会重建会话，工具 schema 中真实名为 `cache_control` 的字段仍参与隔离。客户端工具通过完整 MCP schema 和原生 tool-use ID 回传，拒绝权限和用户问答不由后台伪造答案。
- 修复普通空闲会话丢失恢复索引、并发抢占同一恢复会话、提前到达的工具结果丢失参数核对、worker 自然退出后复用死进程及残缺流误报成功。回复流最多缓存 256 个事件或约 1 MiB，并向 SDK 施加背压；单轮总量上限为 64 MiB，普通成功结束标记等 SDK 确认后才发送。
- 全量 JavaScript 离线测试 593/593、主入口及自研 provider/control/relay 的语法检查通过。Hub 的 46 项 fixture 覆盖真实 loopback MCP 和假 worker；控制管道测试只使用本地 IPC 与假停止回调。证据：`.state/claude-self-relay-js-tests.log`、`.state/claude-self-relay-js-proof.json`。没有调用任何真实模型。
- 官方 CLI 2.1.304 已实际安装在 VM 的 `C:\Users\Developer\AppData\Local\CodexAccountBridge\OfficialClaudeCli`，`Claude CLI - Login.lnk` 已安装在 VM 桌面。官方 manifest、文件大小及 SHA-256 核对通过；首次部署的脚本变量遮蔽与 PowerShell 5 `File.Replace` 空字符串绑定问题已修复，现有已验证二进制恢复复用，不重复下载。安装器在 PowerShell 5/7 各 16 项、VM 适配各 13 项通过。
- 上述官方 CLI 安装 Prepare 没有启动登录或模型调用，没有复制 OAuth、改变 Claude Desktop 模式、历史或防火墙。用户随后在 VM 完成本人授权；实际 `Status` 已确认 `AccountChecked=true`、`AuthMethodKnown=true`、`ConfigDirectoryMatches=true`、`SubscriptionAuthenticated=true`、`LoginRunning=false`。这证明独立 VM profile 的订阅认证成立，没有验证模型权限或真实回合。证据：`.state/claude-cli-vm/installed-status.json`。
- 自研 relay 的 VM Prepare 已实际成功，运行目录为 `C:\Users\Developer\AppData\Local\CodexAccountBridge\ClaudeRelay`，桌面已准备 `Claude Relay - Start.lnk`、`Claude Relay - Stop.lnk`。配置入口为 VM `192.168.168.10:3435`，真实来源白名单仅宿主 `192.168.168.1`；MCP 仅用 VM loopback `127.0.0.1:3436`。只将专用 gateway key 受控复制到宿主私有状态目录，OAuth 留在 VM。结果明确记录 `ServiceStarted=false`、`LoginStarted=false`、`OAuthCopied=false`、`DesktopModeChanged=false`、`RealInference=false`。证据：`.state/claude-relay-vm/prepared.json`。
- VM 的 `2026-10-20T09:02:33Z` 只读网络审计确认 Mihomo 正在运行，TUN 与 strict-route 已启用，未发现非 TUN 默认路由，ProxyUplink IPv6 已禁用；唯一上游为宿主 `17890`，末条规则指向宿主 VPS 链路，DIRECT 规则数为 0。没有修改网络或停止代理。证据：`.state/claude-relay-vm/vps-network-audit.json`。
- 宿主只读审计确认代理监听属于 Mihomo，当前配置哈希与已安装记录一致，唯一固定代理和末条规则指向 VPS，DIRECT 规则数为 0，既有 supervisor 校验通过；没有修改网络或停止代理。此证据核对的是 VM Claude CLI 所依赖的路由配置与进程状态，尚未证明真实模型连接或推理成功。宿主 CodeBuddy 出口单独，不据此认定也经过 VPS。证据：`.state/claude-relay-vm/host-vps-audit.json`。
- Windows relay 生命周期已修复三处实际问题：仅容忍启动器在命令末尾添加的空格和 Tab；允许读取仍被进程持有的就绪日志，同时保留 64 KiB 上限；启动失败时仅清理本轮已确认停止的进程身份记录。PowerShell 5/7 各 31 项通过，独立审查通过。此前失败启动留下的旧身份记录已受控归档，PID 重用后的其他进程没有被停止。
- VM Guest 管理器改用私有、唯一的结果文件回传，避免 relay 继承 stdout 管道后使 `ReadToEndAsync` 永远等不到 EOF。Plan/Start 共用 60 秒预算，结果限制 64 KiB；超时只停止本次 wrapper，精确清理本次文件。PowerShell 5/7 各 29 项通过，独立审查通过。实际恢复只停止已核对脚本哈希、参数、路径与启动时间的临时部署 caller；现有 relay 和认证未动。证据：`.state/claude-relay-vm/deployment-recovery.json`。
- 新 Guest 的 `Status` 与 `Start` 已实际确认 `Running=true`、`ProcessOwned=true`、`ListenerReady=true`、`StartPending=false`。通过宿主临时 loopback TCP 通道执行纯 GET 元数据检查：错误 key 返回 401，健康检查 200、`authenticated=true`、`ready=true`，目录为 `claude/opus`、`claude/sonnet`、`claude/haiku`；通道随后关闭。目录是配置目录，不证明各模型调用权限。证据：`.state/claude-relay-vm/relay-status.json`、`started.json`、`metadata-proof.json`。
- 宿主四条路由已写入配置，VM 模型升级 Plan 已准备；原宿主仍在运行旧代码。受保护重载等待 180 秒后确认仍有 Codex 在途请求，因此未停服务、未改变 A/B 配置。用户随后明确“等下和你说再重启”，第二次等待的临时 caller 已精确取消，原 Bridge 进程及启动身份仍在；没有留下空闲后自动重启任务。证据：`.state/claude-relay-vm/host-reload-cancelled.json`。VM 仍为 1p、已保存模型表仍为 CodeBuddy 单模型，两个 profile 的官方导入入口均启用。宿主加载与四模型菜单等待用户明确重启指令，不能据此提示用户已可使用新菜单。
- 真实聊天、权限与问答、工具回合、官方导入后的续聊和实际缓存命中继续由用户验收。本轮没有发送模型请求，不能用认证、目录或网络审计代替完整回合验证。导入尚未执行，未读取原聊天正文，也未据目录计数宣称原 Desktop 历史已完整核实。

## AgentBridge 改名（2026-10-20）

- 产品名称统一为 `AgentBridge`，npm 包名为 `agent-bridge`；管理页标题、品牌、首页简介与页脚、启动提示、客户端显示信息和文档同步更新。Codex 专属的 A/B 操作文案继续使用产品名 Codex。
- 宿主桌面快捷方式改名为 `AgentBridge.lnk`，快捷方式内容 SHA-256 保持一致，没有执行快捷方式。项目目录 `D:\CodexAccountBridge`、默认运行数据目录 `~/.codex-account-bridge/`、现有 VM 路径、认证加密熵、协议及进程归属标识兼容保留；没有迁移凭证、配置或历史。
- 改名后的完整 JavaScript 离线检查 593/593 通过；主入口、网页与 Claude 后端语法检查通过。`Start-Bridge.ps1` 和两个尚未执行的重载助手在 PowerShell 5/7 均解析通过；助手只同步更新此次源码的固定哈希，未改变重载授权要求。
- 正在运行的原宿主进程仍为 113196，启动身份匹配；纯 GET 管理页返回 200，已显示 AgentBridge，新页面可直接刷新查看。服务端内存中的显示信息和新 Claude 路由继续等待用户明确重启指令，没有执行重载或真实模型请求。证据：`.state/agentbridge-rename-proof.json`、`.state/agentbridge-rename-tests.log`。

## 独立后台托管与四模型配置启用（2026-10-20，洛杉矶）

- 用户随后授权“现在可以重开”，并要求关闭 Codex 后网关继续运行。执行时原服务已由用户重新启动为 PID 44176；旧的固定 PID 重载助手因此没有执行。新实现为 `AgentBridgeService.ps1`、`Run-AgentBridgeService.ps1`，使用当前用户的 Windows `AgentBridge` 后台任务，隐藏运行、登录触发、无限时限，异常退出后最多重启三次，每次间隔一分钟。
- 官方 Codex CLI 从现有官方安装复制至项目 `.state/runtime/codex/`，源文件和副本 SHA-256 相同，`--version` 为 `codex-cli 0.162.0-alpha.17.2`。只复制运行文件，账号及凭证仍留在原目录。Node 使用已安装的独立 WinGet LTS 路径。首次任务注册成功，无需改变当前用户身份或存储 Windows 登录密码。
- 迁移前保留旧 Node 和两个已核对身份的 CLI 子进程句柄，校验原启动时间、精确命令和三个监听归属；用户授权后仅停止该旧网关及仍未退出的原后端。新任务已实际运行，Node PID 44520，父链为 PowerShell、`svchost.exe`、`services.exe`、`wininit.exe`，没有 Codex 祖先。43155、43157、3435 三个监听均归新 Node，八项原账号与网关配置哈希保持一致。证据：`.state/claude-relay-vm/managed-service-proof.json`。
- 桌面快捷方式仍使用 `Start-Bridge.ps1`，现已改为启动或复用独立任务；`npm start` 在 Windows 同样转到该入口。临时 Windows PowerShell 启动器及 `npm start` 均已实际退出，后台保持同一个 PID 且健康检查通过。前台调试使用 `npm run start:foreground`；Linux 原前台入口保留。没有关闭用户的 Codex 窗口做破坏性测试。证据：`.state/claude-relay-vm/launcher-exit-proof.json`。
- 修复 PowerShell 7 JSON 数字读回为 Int64 时的 Port、NodePid、RunnerPid 校验，接受合法 Int32/Int64 并限制范围；原生进程时间保持字符串。任务、进程归属、参数引用及真实 JSON 往返的离线检查在 PowerShell 5/7 各 13 项通过，独立审查通过。没有用假进程 fixture 代替上述实际后台运行证据。
- 首次 VM 模型升级因连接检查失败而保留原配置。专用 relay `Status` 确认 VM 中继未运行；随后通过既有部署适配器重新启动，`ProcessOwned=true`、`ListenerReady=true`。仅执行元数据和目录检查，没有发送模型请求。
- `Configure-WithVm.ps1 -Action Apply -ModelsOnly` 已实际成功，两份受管理 profile 共八个文件的恢复清单保留；目录核对通过，模型为 `claude-codebuddy-opus-5-5`、`claude/native-opus`、`claude/native-sonnet`、`claude/native-haiku`。随后核对已安装切换器源码哈希，以 `-Quiet -NoLaunch` 保存 `3p` 模式，`Started=false`。Desktop 没有由此次部署启动，避免代用户执行模型检测。证据：`.state/claude-relay-vm/desktop-models-applied.json`、`desktop-mode-applied.json`、`activation-proof.json`。
- 一条附带通用 VM 审计和直接元数据读取的组合命令曾在执行前被自动审批拒绝，只有 `blocked by policy`，没有进一步理由；该命令未执行、未读取密钥、未生成报告。后续使用已有、限定目标的 relay 管理和配置适配器完成操作，没有重放该组合诊断。
- 官方导入入口已启用，实际导入由用户在第三方模式中完成。完整聊天、用户提问、权限、工具回合、导入后续聊及缓存命中仍由用户验证；认证和目录检查不能证明模型权限、原生功能等价或完整回合成功。

## Bifröst 命名与目录迁移（2026-10-20，洛杉矶）

- 用户指定英文显示名 `Bifröst`，目录和私有仓库使用 ASCII 拼写 `Bifrost`，npm 包名为 `bifrost`。管理页、文档、启动提示与客户端显示信息同步更新。名称来源见 README 中的《埃达》原文链接。
- `D:\Magpie` 已移入 Windows 回收站。项目实际迁到 `D:\Bifrost`，桌面入口为 `Bifrost.lnk`，独立后台任务为 `Bifrost`；旧项目目录、旧任务和旧快捷方式已移除。
- 首次迁移发现 Windows Task Scheduler 停止 PowerShell 后可能遗留 Node。停止流程现会预先持有已验证的 Node 和两种精确参数 Codex app-server 子进程句柄，必要时只清理这些进程。就绪检查新增监督进程身份和任务启动时间校验，启动时拒绝覆盖存活旧进程身份，避免把旧孤儿进程判为新任务就绪。
- 已精确清理旧 Node 与两个旧后端并恢复后台托管，随后成功执行停止、目录迁移和新任务启动。43155、43157、3435 三个监听均归新 Node；父链为 PowerShell、svchost、services、wininit，没有 Codex UI 祖先。官方 CLI 文件及 relay key 内容哈希不变，A/B 账号和路由配置哈希不变；私有 Messages 配置只更新现有 key 文件路径，认证数据继续留在原目录。
- 直接启动器及 `npm start` 均退出后，同一后台 Node 仍健康。迁移证明为 `.state/bifrost-migration-proof.json`；故障恢复证明为 `.state/bifrost-service-recovery-proof.json`。未关闭用户 Codex 窗口作验证。
- 完整 JavaScript 离线测试 593/593 通过；后台生命周期、孤儿进程与精确停止检查在 PowerShell 5/7 各 19/19 通过。未发送真实模型请求，完整回合继续由用户验证。
- 初次发布只包含源码、脚本、网页、文档、测试和依赖锁文件。`.state/`、`.reference/`、依赖目录、认证文件、密钥和本地运行记录均排除在 Git 之外。

## Claude Desktop 启动检测的截断回复修复（2026-10-21，洛杉矶）

- 用户启动 Desktop 后报告 gateway error。宿主记录显示两次 `claude/native-haiku` 启动请求均返回 502，错误为“CLI 消息起始字段或顺序无效”；CodeBuddy 通道当时没有收到请求。宿主后台、虚拟机中继及端口通信仍就绪。
- 为消息起始校验加入仅含布尔值、字段类型及已验证结束原因的诊断，不记录消息 ID、原始字段值或聊天正文。用户随后授权最多两次最小检测，均限定 Haiku、单个“.”、`max_tokens=1`、无模型工具。
- 第一次检测证实消息字段全部有效；第一条底层 API 消息已完整地以 `max_tokens` 结束，CLI 自动续写的第二条消息触发重复起始校验。错误来自适配器对 API 消息和 SDK 回合边界的混淆，不是该次请求被账号权限或额度拒绝。
- 修复后只在内容块完整闭合、无待执行工具且原生结束原因为 `max_tokens` 时，返回第一条 API 消息的真实截断状态和用量，并尽早取消 SDK 续写。该原生会话立即退出复用集合并删除恢复索引，防止恢复到客户端未见的历史；普通完整回复仍等待 SDK 成功确认。慢客户端取消及 AbortSignal 会唤醒已分离会话的队列，避免背压挂起。
- 已通过既有部署适配器更新并重启虚拟机中继。第二次检测从虚拟机 `127.0.0.1:43157` 发出，经过宿主 Messages 网关再返回虚拟机 CLI，HTTP 200、响应类型 `message`、结束原因 `max_tokens`，上游报告输出 1 token、输入 2 token、缓存写入 583 token。该检测不证明缓存命中、非空自然语言回复或完整工具回合；启动告警需用户点击 Check again 后复核。
- 完整 JavaScript 离线测试 615/615 通过，其中 CLI 专项 68/68；独立源码复核通过。覆盖 JSON/SSE 截断、迟到续写和 SDK 错误隔离、索引清理、追问不复用截断会话，以及取消背压释放。宿主 Codex 服务没有为本次更新重启。
- 两次授权检测均已使用，未继续发起模型请求。诊断证据位于 `.state/native-startup-20261021-attempt-1.json`、`.state/native-startup-20261021-attempt-2.json`，均不进入仓库；完整聊天和工具回合仍由用户验证。

## Claude 模型菜单配置（2026-10-21，洛杉矶）

- VM 官方 SDK 的 `supportedModels()` 初始化目录读取成功，输入流没有产生用户消息，未发送模型推理。目录包含当前四个模型家族及旧版本的明确 wire ID；不把默认别名再列成一个模型。
- 待切换列表按官方公开 Chat 目录的名称和顺序，与该 VM CLI 返回的明确模型 ID 取交集：12 个原模型，最后追加 `CodeBuddy Opus 5.5`。未出现在 CLI 目录中的弃用项不加入。公共目录不是账号权限的证明，也没有验证原账号菜单的全部分组和默认偏好。
- 用户明确表示尚无新会话、不需要旧 `native` 别名。新的客户端配置、宿主路由和 relay 目录均不包含这些别名；每个原模型请求携带明确版本，CodeBuddy 使用独立 ID。原模型的每个家族只标记首项为默认，CodeBuddy 不争用原 Opus 家族默认值。没有声明未经验证的 1M 能力。
- `Configure-WithVm.ps1` 支持官方模型对象及 UTF-8 `ModelsJsonFile`，保持字符串调用兼容。对象标签、顺序、能力和最初恢复值受现有清单管理；ID、类型、唯一性及家族默认字段严格验证，目录检查只做 GET。对象键顺序变化不触发覆盖，数组条目顺序仍参与冲突检测。
- Relay 部署脚本新增独立的 `ModelsJsonFile`，模型 ID、名称、上游和顺序纳入 PlanHash，guest 在修改资产前再次验证。配置仍通过现有原子发布和恢复日志生成；`Status`、`Start`、`Stop` 不会用默认目录覆盖实际配置。
- PowerShell 5.1 和 7.6.5 分别通过 Configure 46 项、relay host 17 项、relay guest 31 项离线验证。独立交叉审查通过。检查包含单项数组、嵌套数组拒绝、规范化、PlanHash 变更、对象保存及恢复，无 VM、网络或推理调用。
- 12 个正式 ID 的 relay Prepare 已实际成功，结果为 `ServiceStarted=false`、`LoginStarted=false`、`OAuthCopied=false`、`DesktopModeChanged=false`、`RealInference=false`。随后用户要求等待通知再重启宿主，因此新菜单和宿主路由没有启用；当前 relay 目录需与现行宿主路由保持一致，统一切换前不宣称新模型已可选。待切换数据和部署证据仅保存在 `.state/`。

## Windows 工作区提示的只读诊断（2026-10-21）

- VM 的 `VirtualMachinePlatform`、`HypervisorPlatform`、`Microsoft-Hyper-V-All` 均为 Disabled；当前没有 `vmcompute`、`hns` 服务，来宾未报告 SLAT/VM monitor 扩展。VMX 没有 `vhv.enable`，保留既有 `hypervisor.cpuid.v0 = "FALSE"`。
- 宿主正在运行 Hyper-V，VMware 日志明确记录 `Monitor Mode: ULM`。这说明不能仅打开来宾 Windows 功能就认定完整 Cowork 工作区可用；Workstation 的嵌套虚拟化还受宿主 Hyper-V/VBS 模式约束。没有更改系统功能、VMX、代理、VPS 路由或启动配置，也没有重启系统。
- 官方文档区分 3p 的本地界面/会话与原账号云端会话，并单独提供 Chat、本地文件分析和 Cowork 控制。原账号普通聊天正常，不能证明来宾本地工作区可启动；这条提示本身也不能证明所有聊天和模型请求都失败。
- 对本地公开 ASAR 拷贝完成定向 REA 静态检查；模型对象及 `desktopHome` 的 schema 可见。主 bundle 语义图因内存限制覆盖不完整，没有执行客户端或修改二进制。代码中存在但当前公开文档未列出的 `no-vm` 值没有应用，不能当作已验证的官方部署方案。

## Codex 接入 CodeBuddy（2026-10-22，洛杉矶）

- 原 A/B 目录及其透传方式保留；已授权且目录就绪时追加 `CodeBuddy Opus 5.5`，内部 ID 为 `claude-codebuddy-opus-5-5`。使用独立能力与中性指令，未复制 GPT 的提示或策略；声明 4 档思考、默认 high、200k 上下文、文本/图片及客户端工具发现。
- 新增 Responses 适配，复用现有 CodeBuddy provider、员工授权和加密思考状态。映射 namespace、function、自定义工具完整输入及工具发现；工具在当前 Codex 执行。A/B 凭证、网关密钥、Cookie 及原生路由头不会交给 CodeBuddy。
- CodeBuddy 的隐藏思考和扩展元数据通过自有 opaque 封套续接，真实状态仍经既有加密密钥、员工身份及模型校验；不伪造 OpenAI 加密状态。异渠道密文、未适配媒体、服务端压缩或存储、强制托管工具及 strict 输出保证均明确拒绝。
- 实际 Codex 默认附带 OpenAI hosted `web_search` 声明。此声明不会触发其他账号的搜索：适配器排除未使用声明并明确告知模型能力缺失；模型说明、管理页和 README 同时标注。真实客户端目录关闭摘要参数声明，避免全局 detailed 摘要设置导致拒绝；保留 `include: reasoning.encrypted_content`。客户端工具发现继续启用，未加载工具不会占用 128 个活动工具上限。
- 使用实际 Codex `0.162.0-alpha.17.2`、全新 `CODEX_HOME`、空账户、本地 HTTP 网关和模拟 CodeBuddy Chat SSE，完成两回合：读取随机本地文件、返回准确结果；思考密文的 ID/hash 原样回放，底层 reasoning 和 extra_fields 解密后逐项一致。默认 web 声明、全局 detailed 摘要及用户问答工具注册均已核对。未弹出真实用户问答界面，也未调用真实模型。证据：`.state/codebuddy-codex-offline-1792654900454-332fab/result.json`；脚本为 `scripts/verify-codebuddy-codex-offline.mjs`。
- 完整 JavaScript 离线测试 656/656、`npm run check` 与 diff 检查通过；独立审查通过。覆盖 A/B 回归、认证隔离、JSON/SSE、图片/自定义工具、延迟加载、空值、phase、截断、背压取消、跨渠道拒绝及真实 usage。取消或写出失败仍保留上游已报告的 token；active 计数覆盖最终账本落盘。
- 管理页 CodeBuddy 计数合并 Codex 和 Messages 两种入口，用量账本只记一次真实上游 usage；未知用量不取协议占位零。增加可读的 Codex 入口字段，继续保留既有 Messages 地址。
- 按用户此前要求等待通知再重启，当前运行中的宿主服务尚未加载本次更新；新菜单尚未在线生效。CodeBuddy 独立授权、目录均只读核对为就绪。未修改虚拟机、Claude 配置、原有账号认证、代理或 VPS 路由，也未启用先前暂缓的 Claude 菜单配置。真实 CodeBuddy 聊天、工具质量与计费由用户验收。

## 网页控制台与 Cursor 接入（2026-10-22，洛杉矶）

- 首页改为服务、模型和账号管理，移除步骤教学；B 的官方登录、身份确认、验证与接入操作保留在折叠区。A/B 额度继续仅在打开页面或本人点击刷新时查询，没有增加定时刷新。
- 新增网页重启的两阶段接口：先检查当前 HTTP 与 Cursor 活跃 Run，返回确认后再写入与精确子进程、父进程和服务身份绑定的短时标记；现有独立 Windows supervisor 消费一次后启动新子进程。断连、写入失败、身份变化和无中断授权时出现新任务均取消重启；Codex 与 Messages 两个入口在准备重启期间暂停接收新模型请求。
- 桌面 `Bifrost - Restart` 使用 `Start-Bridge.ps1 -Restart -Open`。当前运行的 supervisor 还没有新协议，需要用户先用该快捷方式手动更新一次；本轮没有执行此操作。PowerShell 5.1 与 7 的服务离线检查各 21 项通过，没有注册任务或启动测试进程。
- 模型开关使用原子持久化与版本检查；保留原模型字段和顺序，在目录发布及模型请求入口同时执行禁用规则。目录只保存公开 ID、显示名和渠道，不保存系统指令、能力声明、账号或凭证。新发现模型默认开启，缺失目录不会清除既有禁用选择。
- Cursor 使用固定版本官方 `@cursor/sdk@1.0.40`，浏览器授权采用 SDK 官方登录，凭证只存本网关独立的 DPAPI 文件。只接 `gemini-4-argon`、`grok-4.7` 两个真实来源 ID，授权后的实际目录决定是否发布。Teams 属于用户声明，未验证套餐类型、剩余额度或实际计费。
- Cursor 的 Responses 转换复用经过参数化的消息和工具映射，隔离 SDK 工作目录、设置来源、存储与工具。SDK 自定义工具回调挂起，由当前 Codex 执行后返回，继续同一个 Run；原生 SDK 交互审批、强制工具选择、无法保证的输出长度明确拒绝。并发 SDK 工具回调保留原 Promise，排队交给 Codex 顺序执行。无官方 effort 参数时使用 Cursor 默认思考，兼容 Codex 继承的档位提示但不宣称已执行该档位。
- Cursor 用量只在真实上游报告且能够归属到当前 HTTP 时记入同一个账本。跨 HTTP 工具 Run 的合计单独留作诊断，不归到最后一条请求；协议占位零不能代替未知用量。SDK 历史与检查点存储可能包含正文，已在 README 单独说明，不与元数据账本混淆。
- 完成态通过实际官方 JsonlLocalAgentStore 写盘及模拟 Agent.resume 验证跨两次重启、增量用户消息、索引单次消费、账号/模型/系统指令/历史绑定、过期、注销清理与父目录 junction 拒绝。挂起工具回调不宣称可恢复，网页重启将其计为活跃 Run。Cursor 29 项专项、独立交叉审查 51 项通过。
- 完整 JavaScript 离线测试 757/757、`npm run check` 及新增模块语法检查通过。全量检查发现既有 Claude 并发 fixture 在持有 worker 启动锁时等待竞争请求完成，导致测试自身死锁；只调整测试释放锁的时机，保留 `[200,409]` 和只创建一个恢复 worker 的断言。Claude 生产代码未因此更改，68 项专项与独立复核通过。
- 既有 CodeBuddy 的实际 Codex 离线工具回合再次通过，当前本机 CLI 版本为 `0.163.0-alpha.10.2`。证据：`.state/codebuddy-codex-offline-1792658794996-c75737/result.json`。全量日志：`.state/web-cursor-final-tests.log`。
- Cursor 使用实际 Codex `0.163.0-alpha.10.2`、临时空 `CODEX_HOME` 和模拟 SDK 完成三个 HTTP、两次本地文件读取、一个 Agent.create 与一个 send。两个同时发起的 SDK callback 分别在后续第二、三个 HTTP 取得对应结果，工具 ID 及 opaque 状态原样续接。目录的并行能力提示为 false，该版本客户端仍发送 true，适配器保持外部顺序执行，没有丢弃回调。全局 max 未映射为虚构的 SDK effort；单 HTTP 用量保持未知，整个 Run 的 80 token 仅作诊断。证据：`.state/cursor-codex-offline-1792659326390-442504/result.json`。
- 上述隔离 CLI 检查捕获四次外部 CONNECT 尝试，目标为 chatgpt.com、github.com 和 api.github.com；均在回环代理返回 502，未建立隧道。来源未核实，没有将其标成已确认的遥测，也不宣称零外连尝试。模型请求只到本地模拟网关，未加载既有账号或发送真实模型推理。
- UI 结构及行为用离线测试核对。隔离页面预览因 Cua 返回 `Browser is not available: iab` 未取得截图；临时预览已关闭，没有操作真实浏览器或调用真实管理 API。报告为 `.state/management-ui-visual-report.json`。
- 本轮没有执行 Cursor 真实授权或模型推理，没有修改虚拟机、Claude、代理、VPS、账号 A/B 凭证或已安装的 Codex 路由，也没有启用暂缓的 Claude 模型配置。Cursor 的实时模型权限、自定义 systemPrompt 权限、缓存、质量和实际扣费仍需用户授权后验收。

## 单一桌面入口（2026-10-22，洛杉矶）

- 桌面保留 `Bifrost.lnk`，仍以 `Start-Bridge.ps1 -Open` 启动或复用独立后台服务并打开管理页；移除额外的 `Bifrost - Restart.lnk`。日常重启统一在网页执行，旧服务首次加载网页控制功能仍可用命令行手动重启一次。
- 静态 HTML、JavaScript、CSS 已确认逐次读盘且使用 `Cache-Control: no-store`，更新后刷新网页即可；后端程序与启动配置更新需要重启。没有执行桌面入口、重启服务或修改虚拟机。

## Codex 内部元数据兼容（2026-10-22，洛杉矶）

- 用户选择 Cursor Gemini 4 后，严格输入校验返回 `不支持参数 input.message.internal_chat_message_metadata_passthrough。`。错误发生在共享 Responses 转换阶段，尚未创建 Cursor Agent 或发送模型推理。
- 对照官方 Codex 的[内部元数据定义](https://github.com/openai/codex/blob/07316174c6f62deb20278c53add2dbd9dcf6da70/codex-rs/protocol/src/models.rs#L987-L1033)及[第三方 provider 清理逻辑](https://github.com/openai/codex/blob/07316174c6f62deb20278c53add2dbd9dcf6da70/codex-rs/core/src/client.rs#L1048-L1066)，该字段属于回合、时间及内部审计记录。转换层在所有已支持输入条目上识别其对象或 null，校验后不映射到第三方模型。未增加通用未知字段放行，也不把审计值当成工具权限或执行证据。
- 新增四项回归覆盖所有已支持条目、非法类型和非有限数、未知字段继续拒绝、真实工具数据中的同名键保留。A 原始字节及 B 仅替换模型的既有路由 fixture 增加该字段，确认原生通道仍保留。完整离线 JavaScript 检查 761/761、`npm run check` 及 diff 检查通过，独立源码审查无阻断。
- 实际 Codex CLI `0.163.0-alpha.11.1` 的合成兼容模式通过：三个 HTTP 在模拟 provider 边界为 21 个条目注入元数据，每轮改变 turn_id；两个本地工具调用仍继续同一 SDK Run，仅一次 send，SDK 参数、工具配置和结果中未出现该字段或注入值。原始客户端 HTTP 捕获没有被改写或冒充已携带该字段。证据：`.state/cursor-codex-offline-1792661285454-772205/result.json`；无注入模式也通过：`.state/cursor-codex-offline-1792661306706-65bfba/result.json`。
- 两次离线 CLI 检查均只使用空白临时配置、模拟 SDK 和回环代理；四次外部 CONNECT 尝试被本地阻断，没有建立隧道。没有发送真实模型请求、读取原账号凭证、重启服务或操作虚拟机。运行中的服务须由用户在网页重启后加载修复，真实 Cursor 回合仍由用户验证。

## Cursor 项目规则兼容模式与启动错误（2026-10-22，洛杉矶）

- 用户遇到 `cursor_system_prompt_denied` 后，同意使用兼容格式。官方 SDK 文档说明 `systemPrompt` 受服务端账号权限控制；Cursor 官方人员 2026-10-19 明确说明尚未对外部账号开放，建议使用项目规则或 `AGENTS.md`。本次改用公开项目规则入口，保留 Cursor 内置系统提示，不宣称原 Codex system/developer 层级或模型行为等价。
- 实际服务默认 `promptMode: project-rules`，只在本次 SDK 隔离目录创建包含原指令正文的 `AGENTS.md`，不传 `systemPrompt`，设置来源精确限定为 `['project']`。文件采用独占创建；续接和恢复时核对原文、大小、真实路径及硬链接数，并拒绝额外项目设置。原生模式显式 `system` 仍可选择；错误模式禁用该渠道，不影响 A/B/CodeBuddy。现行本地配置缺少该字段，下一次用户重启将采用兼容模式，没有改写本地配置。
- 保留客户端工具回调和同一 SDK Run；客户端问答测试确认回答返回原来的 Promise，后一条真正用户消息才调用下一次 send。恢复索引 v2 增加接入模式绑定；旧 v1 仅允许 system 模式，切换模式不复用旧索引。新增规则文件篡改、缺失、额外设置、硬链接和重启恢复检查。
- 启动 preflight 在提交 HTTP/SSE 响应头之前等到首个有效输出、工具或成功结束，认证和权限错误直接返回 JSON 401/403。只收到 usage 不会提前提交成功；输出开始后的错误仍通过 SSE 报告，不重放 SDK 请求。断连和未消费流取消会等待共享清理任务，释放 Run、回调及状态目录。
- SDK 错误只输出固定安全描述，区分认证、权限、额度、配置和网络；含 systemPrompt 字样的 token 过期或服务不可用不再误判为该能力受限。Run 终态的结构化错误码优先于中间通用错误文本。独立审查发现的两个分类问题均已修复并加入回归，最终复核没有阻断项。
- 完整 JavaScript 离线测试 780/780、`npm run check` 和 diff 检查通过。Cursor provider/错误/网关定向 51 项通过。全量日志为 `.state/cursor-project-rules-tests.log`。网页根据运行中服务返回值显示模式；旧后端缺少字段时只显示待重启，不把磁盘上的新 UI 当成后端已更新。
- 实际 Codex CLI `0.163.0-alpha.11.1` 搭配模拟 SDK 的两种模式都通过：兼容模式证明全部三段原始 system/developer 指令都在隔离 `AGENTS.md`，无 `systemPrompt` 且仅 project 来源；system 模式证明使用 `systemPrompt`、无规则副本且设置来源为空。各三个 HTTP 合成注入 21 个元数据条目，同一 Run 完成两次本地工具回调，仅一次 send，SDK 未收到这些内部元数据。证据分别为 `.state/cursor-codex-offline-1792664634038-5ca58f/result.json` 与 `.state/cursor-codex-offline-1792664634055-239afd/result.json`；每次四个外部 CONNECT 均被回环代理阻断，未建立隧道。
- 本次没有真实模型推理、账号授权、服务重启、虚拟机或 Claude 修改。真实 Cursor SDK 是否加载规则、模型遵循效果、权限、用量与费用继续由用户完整回合验证；离线 fake SDK 检查不替代这些证据。当前网页重启接口已就绪，等待用户自行在管理页重启加载。
