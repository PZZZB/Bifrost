# 员工自动认证试验

CodeBuddy 接入使用本机官方客户端中核实的员工 OAuth 流程，为本网关建立独立授权。首次授权在官方网页完成；CodeBuddy 原有客户端登录态不会被复制。独立命令行探针仍可仅在内存中验证同一流程。

## 首次授权

1. 探针向 `https://copilot.tencent.com/v2/plugin/auth/state?platform=ide` 申请临时登录状态。
2. 用户在返回的官方页面选择 IOA，并完成本人登录。页面列出的协议由用户自行确认。
3. 探针每秒向 `/v2/plugin/auth/token` 检查授权结果，最多等待 5 分钟。
4. 获得凭证后，探针调用 `/v2/plugin/login/account`。只有 `idp=ioa_auth` 的员工身份会通过检查。

首次登录需要本人完成。后续续期使用 OAuth 返回的刷新凭证，通过 `/v2/plugin/auth/token/refresh` 获取新凭证，无需再次填写密码。刷新后通过 `/v2/plugin/accounts` 检查当前员工身份是否一致；401/403 后需重新授权。

## 管理页与存储

- 管理页的 CodeBuddy 卡片提供官方登录与“退出本网关会话”。退出只清除本网关新建的授权，不退出原 CodeBuddy 客户端。
- 管理服务将自身取得的授权保存在私有目录 `codebuddy-auth.dpapi.json`，使用 Windows DPAPI CurrentUser 加密。访问与刷新凭证不提供给浏览器或虚拟机，也没有 Token 导出接口或任意 URL 代理。
- 隐藏思考接续使用单独的 `codebuddy-thinking-key.dpapi.json`，默认位于 `%USERPROFILE%\.codex-account-bridge`，随 `BRIDGE_STATE_DIR` 改变。该密钥也由 DPAPI CurrentUser 保护，与 OAuth 凭证分开；磁盘不保存隐藏摘要明文。同一 Windows 用户保留同一密钥后可跨网关重启恢复接续状态。密钥按需加载，损坏时拒绝 CodeBuddy 模型请求，管理页、A/B 和 With 启动保持可用。
- 状态查询和模型请求会在访问凭证过期前 60 秒自动续期，支持重启恢复；同一时间只刷新一次。401 在未收到成功流前最多续期重试一次，已开始的流不会重放。
- 独立 CLI 探针没有配置持久化回调，因此仍然只保留进程内凭证，退出后丢弃。

## 模型接入边界

- CodeBuddy 使用自身的 `/v2/chat/completions`，由适配器转换为虚拟机使用的 Anthropic Messages。其公开别名为 `claude-codebuddy-opus-5-5`；上游真实 ID 必须在当前员工账号的模型目录中唯一核实为 Opus 5.5。
- 优先读取 `/v3/config` 的模型列表。只有 HTTP 成功、业务码为 0、配置对象缺少 `models` 字段时，才读取当前 Windows 用户 CodeBuddy CN 的目录缓存。明确的空列表、拒绝、无效响应及注销后的结果不会使用缓存。
- 本机缓存位于 `%APPDATA%\CodeBuddy CN\User\globalStorage\state.vscdb`，只读查询 `Tencent-Cloud.coding-copilot` 下 `cloud_product_config_cache` 的模型元数据，要求其 `userId` 与本网关新授权的 UID 相同，保存时间在 30 天内。SQL 不返回整个扩展状态、认证记录、模型 `apiKey` 或自定义认证头。
- 缓存来源显式标记 `native-cache`、`liveVerified=false`，显示原始保存时间；该时间不是最后刷新成功时间，也不是实时权限证明。当前目录保存的实际模型 ID 为 `claude-opus-5.5`，`credits` 为 `x2.17`，真实推理和账单仍由用户验收。
- 请求携带当前授权返回的用户、企业及租户信息；缺少独立租户字段时，按原生客户端合同使用已验证企业 ID。User-Agent 明确标识 `Bifrost` 及协议兼容版本，不复制 IDE 身份或计费标识。
- 支持文本、SSE、客户端工具调用和图文结果接续。图片接受 JPEG、PNG、GIF、WebP 的 base64 数据或公开 HTTPS 引用；嵌入图片解码后每张最多 5 MiB，每请求最多 100 张，计入历史、文档及工具结果中的图片。HTTPS 引用不由网关下载，远程实际内容和尺寸由上游检查。
- 文档仅转换已经解析的内容：`source.type=text` / `media_type=text/plain` 的正文，或 `source.type=content` 的字符串、text/image 数组。标题、上下文及原文图文顺序保留；`tool_result` 使用同一转换。原始 PDF、Office 二进制、文档 URL、视频、音频和 `file_id` 返回安全 400，提示先解析为文本或图片。适配器没有原始文件上传、宿主文件读取或附件下载通道，也不生成文档引用；`citations.enabled=true` 返回 400。
- 思考使用 `thinking.type=adaptive`；`output_config.effort` 接受 `low`、`medium`、`high`、`xhigh`，默认 `high`。`thinking.display=summarized` 显示摘要；默认及 `omitted` 隐藏摘要。`thinking.type=enabled` 加 budget、`disabled` 或 `effort=max` 返回 400，避免把精确 token budget 或关闭思考改成其他行为。
- 可见摘要来自 Chat 的 `reasoning_content`，仍使用空 `signature` 回放。默认或 omitted 模式返回空 `thinking` 块，其 `signature` / SSE `signature_delta` 携带 `bridge-codebuddy-v1:` 前缀的 AES-GCM 密文，绑定当前授权 UID、真实上游模型和隐藏摘要。下一轮须原样回传；账号或模型不匹配返回 403。
- 此标记是本网关加密的接续状态，不是厂商签名；原生 Anthropic 非空思考签名及 `redacted_thinking` 仍返回 400。完整接续状态 JSON 限制为 32 MiB，入口请求 JSON 限制为 64 MiB。真实客户端对空思考块和接续标记的保留、回传兼容仍待本人验收。
- 停止序列和权威 `count_tokens` 尚未适配，会明确返回错误。上述图片、附件和思考均为本网关的本地兼容转换；真实理解、摘要展示、工具回合和实际计费由用户验收。
- 合法缓存提示经过校验后忽略，不保证获得 Anthropic 显式缓存行为；用量只记录上游实际返回的值，缺失保持未知。
- 登录链接限制为已核实的官方生产主机，HTTP 请求禁止跟随重定向。
- 公司统一 Token 额度的说明，不等于 With 专属权益通用。CodeBuddy 员工凭证是否能调用 With 原始模型网关仍未验证。
- 目录中的 `credits`、活动优惠和员工 Token 倍率分别显示。没有通过伪造客户端或计费标识强制应用 IDE 优惠；实际扣费需要用户在渠道账单中确认。
- 自动化验证只使用模拟模型事件；真实模型和完整工具回合由用户验收。

## 手动重试

在项目目录运行：

```powershell
node scripts/probe-employee-auth.mjs
```

脚本会显示短期登录链接。凭证不输出到终端，进程退出后不保留。该脚本不需要启动或重启现有生产网关。

## 合同来源

- 本机官方 CodeBuddy CN：`D:\CodeBuddy CN\resources\app\extensions\genie\product.json` 中的生产认证配置。
- 同目录 `out/extension/index.js` 中的 `ExternalLinkAuthenticationProvider`，包含登录、换票、账号校验与刷新流程。
- [内部个人密钥接入说明](https://iwiki.woa.com/p/4035588525)与[统一 Token 额度说明](https://iwiki.woa.com/p/4018934302)仅作为补充，不作为 With 原始网关授权已打通的证据。
