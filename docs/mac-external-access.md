# 从公网访问这台 Mac 的 Claude 网关

没有自有域名时，可以用 Tailscale Funnel 提供 `https://model-gateway.<tailnet>.ts.net`。
网关和推理仍运行在原来的 Mac 与隔离 VM；外部客户端无需安装 Tailscale。公网入口由 Tailscale 转送到 Mac，不使用原 VPS 作为入站入口。VPS 继续承担 VM 的 Claude 出站流量。

```text
外部客户端 → HTTPS / Tailscale Funnel → Mac 127.0.0.1:43158
          → Mac 127.0.0.1:43157 → 原固定 VM 通道 → Claude → VPS
```

大陆访问以速度为优先时，参考 [直连条件与入口选择](mac-direct-access.md)。Funnel 在一条电信线路的模拟流式传输约为 22.7 KiB/s；这不是模型生成速度。用户无法管理光猫、客户端只能填写 URL 和 API key，当前已部署 [国内出站隧道](mac-outbound-tunnel.md)：16 MiB 级模拟正文约 1.32 MiB/s，模拟首帧约 0.10 秒。两条入口共用原来的外部鉴权、会话与限流状态。

## 访问边界

新增入口仅提供 `/v1/models`、`/v1/chat/completions`、`/v1/messages` 和 `/v1/messages/count_tokens`。它接受独立外部 API key，替换为本机网关密钥后转发到固定回环目标。VM relay 密钥和 Claude OAuth 不交给外部客户端。

每个客户端使用独立随机密钥，私有 `clients.json` 只存其 SHA-256。每个客户端默认最多 2 个并发请求、每分钟 30 次；入口总并发最多 4，请求正文最多 16 MiB，单次最长 10 分钟。新请求每次重新读取客户端列表；删除该项会拒绝后续请求，已在运行的流需要停止入口才能立即中断。请求数限制不是模型 token 或订阅费用限额。

所有客户端会话标识由服务端按认证身份重新命名；相同的客户端 session header 不会跨密钥身份复用 VM 会话。客户端提供的 Cookie、代理头、agent/parent 标识和认证均不向内部透传。入口拒绝浏览器 Origin，不开放管理页、SSH、文件共享或任意目标代理；工具仍由各自客户端执行。

两个 Mac HTTP 端口继续仅绑定 `127.0.0.1`。Tailscale 使用独立的用户态 daemon、私有 socket 和状态文件，关闭 DNS 接管、路由接受和 SSH。Funnel 与 shields-up 互斥；专用 daemon 通过 macOS 进程沙箱限制回环连接，仅能连接 43158，避免用户态转发开放其它本机服务。沙箱配置依赖 macOS 的 `sandbox-exec`，启动失败时应停止该 daemon，不移除此限制后重试。不能仅依据 `funnel status` 判定公网成功。VM 网卡、防火墙、DNS 与 VPS 出口策略保持原配置。

## 配置

先准备 `external-gateway.example.json`、`external-clients.example.json` 及独立会话密钥。配置和密钥的父目录为 0700，文件为 0600；客户端密钥应由至少 32 字节安全随机数生成并使用 base64url 编码，不能复用内部网关密钥。启动：

```sh
node scripts/run-external-claude-gateway.mjs /absolute/private/External/gateway.json
```

CLI-only Tailscale 的 daemon 启动参数见 `local.claude-vps.bifrost-funnel.example.plist`。显式指定 `--statedir` 的 0700 私有目录，供证书等运行数据使用；只有自定义 `--state` 文件不足以提供证书缓存目录。不启用 SOCKS/HTTP 出站代理或 subnet/exit 路由。以专用 socket 完成官方网页登录：

模板使用 `TS_FORCE_NOISE_443=true`，让控制连接使用 HTTPS 443，避免某些网络的 HTTP 80 中间设备在 Noise 握手后中断连接。公网域名仍需从实际客户端网络验收；Funnel 不提供中国大陆直连或延迟保证，不能用已开启代理的访问结果代替国内直连检查。

```sh
tailscale --socket=/absolute/private/External/tailscaled.sock up \
  --hostname=model-gateway --accept-dns=false --accept-routes=false \
  --ssh=false --shields-up=false
tailscale --socket=/absolute/private/External/tailscaled.sock funnel \
  --bg --https=443 http://127.0.0.1:43158
```

首次需在官方网页完成账号授权和 Funnel 功能启用。取得完整 DNS 名称后，填入私有网关配置的 `publicHostname` 并重启外部入口。客户端 Base URL 为 `https://<实际 DNS 名称>/v1`，Authorization 为各自的 `Bearer <外部 API key>`。

保留公开 HTTP Host 的额外隧道可使用私有配置中的 `additionalPublicAuthorities`，明确列出实际域名及 `域名:实际端口`；不接受通配符、URL、用户信息或无效端口。没有列出的 Host 被拒绝，上游仍固定到 43157。此选项不创建监听端口或选择新的网络目标，原 `publicHostname` 的 Funnel Host 继续有效。

登录后的验收必须包括真实公网 HTTPS、无密钥 401、错误密钥拒绝、有效密钥的模型元数据、未提供的接口拒绝、SSE 首片段/取消和 daemon 重启恢复。可以通过仅允许专用一次性测试密钥的 loopback 模拟后端测试流式，避免请求真实模型。Claude 尚未登录时，模型列表为空、推理不可用；网络通道验收不代表真实推理已通过。

国内直连验收需另外关闭显式代理、绑定物理网卡，并核实出口确实是国内运营商。只使用 `curl --noproxy` 不能绕过仍在运行的 TUN。还应直接检查路由器或国内递归 DNS 的回答，再使用该公网地址完成 TLS 证书校验、认证、连接复用和流式测试。记录首次连接、复用连接、吞吐与取消的结果；一条运营商线路的结果不代表其它省份或运营商。网络测试中的模拟数据不计入真实 Claude 推理速度。

关闭公网入口用 `tailscale --socket=... funnel reset`；停止专用 daemon 也会断开公网入口。本机 43157 入口和 VM 的 VPS 出站无需因此停止。

该方案需要 Mac 保持开机、用户登录和联网。Funnel 的公网带宽由服务提供方限制；可用地址及连通性以现场验收为准。

依据：[Funnel](https://tailscale.com/docs/features/tailscale-funnel)、[macOS 版本差异](https://tailscale.com/docs/concepts/macos-variants)、[用户态网络](https://tailscale.com/docs/concepts/userspace-networking)。Cloudflare 的免账号 Quick Tunnel 不支持 SSE，不适合作为这个流式 API 的入口：[限制](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/#limitations)。
