# 中国大陆访问 Mac 网关：直连条件与出站隧道

研究日期：2026-10-25（Asia/Shanghai）。目标是让外部客户端仅填写 HTTPS Base URL 和独立 API key，直接访问 Mac 中的网关；Claude 继续运行在隔离 VM 中。

**当前已部署国内出站隧道，Funnel 保留为另一个入口。** 用户已确认无法管理光猫，外部客户端只能填写 URL 和 API key，不能安装组网客户端。因此本轮不再依赖路由器端口映射或 Tailscale 私网客户端；使用 [SakuraFrp TCP + 自动 HTTPS](mac-outbound-tunnel.md)，网关和 Claude 仍在 Mac/VM 中运行。本机电信线路的 16 MiB 级模拟正文约 1.32 MiB/s，模拟 SSE 首帧约 0.10 秒；其它运营商只验证了无密钥公网 HTTPS 可达，真实模型尚未验收。

原生 IPv6 出站已确认，公网入站目前尚未打通。短时、固定响应的探测端口已关闭，未配置光猫或改变 VM 网络策略。Mac 上的专用 HTTPS 模板已完成回环验收，直连尚未启用、尚未完成外部测速；后文保留将来具备路由器管理权限时的实现条件。

## 当前证据及其适用范围

| 检查 | 结果 | 可以得出的结论 |
| --- | --- | --- |
| 当前 Funnel，大陆电信物理网卡直连，关闭显式代理 | 模拟 SSE 正文 526,767 字节，正文传输 22.631 秒，平均 22.7 KiB/s；首帧 2.705 秒 | 这条线路的此次公网路径表现不足以证明适合作为速度优先入口；不是 Claude 生成速度，也不是已测定的固定带宽上限 |
| Funnel 小请求及连接复用 | 5 次模型目录请求总耗时中位数 1.376 秒 | 复用连接仍有网络等待；不包含模型推理 |
| Mac 物理以太网 | 已有公网 IPv6，包含非 temporary、非 deprecated 的地址 | 具备尝试 IPv6 直连的地址条件；地址和运营商前缀仍可能变化 |
| 原生 IPv6 出站对照 | socket 使用 Darwin `IPV6_BOUND_IF` 绑定 en0；国内站点 TCP 约 8 ms，含 TLS/HTTP 约 53 ms；另一个公网站点也完成 TLS/HTTP | 本机 IPv6 出站可用；不能代替外部连入、上行吞吐或跨运营商测试 |
| 外部 IPv6 入站探测，TCP 8443 | 临时服务只返回随机测试标记，不连接 API 或 Claude；本机对照成功，上海、深圳、香港、新加坡四个节点均在 TCP 建连时超时；探测后关闭 | 当前入站不通；拦截位置仍需核实，不能直接归因于光猫或运营商 |
| 相同四个探测节点的 IPv6 对照 | 复用节点访问另一个 IPv6 HTTPS 网站，全部返回 200 且 TLS 验证成功 | 这些节点有可用 IPv6；入站失败不能简单解释为探测节点不支持 IPv6 |
| Funnel 宿主连接 | 在实际运行的 Mihomo 控制接口中，相关 TUN 连接选择 `DIRECT` | 这些连接未使用 Clash 代理节点；不能把现有慢速直接归因于 VPS 绕行 |
| 光猫 | 可访问中国电信管理登录页；UPnP SSDP 和 NAT-PMP 公网地址查询未收到回答 | WAN IPv4 与入站防火墙仍需登录查看；没有发现响应不等于不支持相关功能 |

IPv4 出口查询得到的公网地址可能属于上游 NAT，不能据此认定光猫持有可映射的公网 IPv4。当前没有取得光猫 WAN 状态或外部 IPv6 入站成功的证据。

## 方案选择

| 方案 | 客户端要求 | 条件与取舍 |
| --- | --- | --- |
| 公网 IPv4 + IPv6 双栈直连 | 普通 HTTPS 客户端，无需代理或组网软件 | 具备路由器管理权限时可选；需公网 IPv4、可管理的端口映射，以及 IPv6 的入站放行 |
| 原生 IPv6 直连 | 客户端所在网络实际支持 IPv6 | 可先试验；不能覆盖只有 IPv4 的网络；需验证光猫与 Mac 的入站规则 |
| 国内转发节点 → Mac 出站隧道 | 普通 HTTPS 客户端 | 当前已部署和完成一条电信线路的网络模拟验收；不要求入站映射，网关与 Claude 仍运行在 Mac/VM |
| 当前 Funnel | 普通 HTTPS 客户端 | 已可使用，保留作备用；官方有不可自行调整的带宽限制，现有单线路测速偏慢 |

Tailscale 私网直连或 frp XTCP 需要客户端安装相应组网/visitor 软件，且打洞成功率受网络影响，不能直接替代“任意客户端填 URL 即用”的公网入口。不能仅凭节点位于香港等地就认定速度更快。

## 具备路由器管理权限后的直连实现

```text
大陆客户端 → DNS A/AAAA → Mac 专用 HTTPS 入口
                         → 127.0.0.1:43158 外部认证与限流
                         → 原内部网关 → 隔离 VM → VPS → Claude
```

1. 在光猫后台确认 WAN IPv4 是否为公网地址；若是，检查能否将一个指定 TCP 端口映射到 Mac。IPv6 则只放行 Mac 的指定 HTTPS 端口，分别检查光猫和 Mac 防火墙。
2. 使用域名和 DDNS 跟踪公网地址。没有自有域名时，可先申请 dynv6 的免费子域名用于试验；该服务支持 A/AAAA 和 API 更新。DDNS 只更新地址，API 流量直接到 Mac，不经过 DDNS 服务转发。分配后的主机名仍需从实际国内 DNS 与客户端线路检查。
3. 优先使用域名证书和自动化 DNS-01 验证；这样申请证书不要求住宅线路的 80/443 端口可达，API 本身可选经实测可用的 HTTPS 端口。DNS 凭据只授予所需区域权限，保存在宿主私有目录。
4. Mac 上可用 Caddy 等专用 TLS 反向代理，固定转发到 `127.0.0.1:43158`。新入口核对实际公开域名，再将上游 `Host` 固定为 `127.0.0.1:43158`，兼容现有外部入口的 Host 白名单，不需放宽为任意 Host。
5. 现有日常 Clash TUN 会接管部分公网 IPv6 路由。上线时必须验证新 HTTPS 监听的回包确实经 en0；仅绑定本地 IP 或关闭显式 HTTP 代理不能证明绕过 TUN。必要的接口绑定或路由处理限于新的宿主入口，VM 的专用出口另行验收。

IPv4/IPv6 地址证书现已可用，但 Let's Encrypt 的 IP 证书有效期约 6 天，需要自动续期；IP 验证仍要求 HTTP-01 的 80 或 TLS-ALPN-01 的 443 可达。动态地址还会导致客户端 URL 变化，因此优先采用域名和 DDNS。

## 已准备的 HTTPS 入口

提供 [Caddyfile 模板](../examples/mac-claude-vm/Caddyfile.direct.example) 和 [macOS 网络沙箱](../examples/mac-claude-vm/direct-tls-loopback.sb)。Caddy 2.11.7 的 macOS ARM64 官方发行文件已按官方 SHA-512 校验；当前只安装普通用户二进制，没有注册自动启动服务。

模板只启用 HTTPS HTTP/1.1、HTTP/2，关闭管理接口、自动 HTTP 重定向和证书申请；上游固定为 `127.0.0.1:43158`，并固定上游 Host。网络沙箱拒绝其它出站连接，包括内部 43157 与公网。证书签发和续期需由单独的受限流程完成，不能通过放宽 TLS 进程的网络权限来代替。

| 环境变量 | 内容 |
| --- | --- |
| `BIFROST_PUBLIC_HOST` | 实际公开域名，必须与证书匹配 |
| `BIFROST_LISTEN_ADDRESS` | 单个明确的监听地址；回环验收用 `127.0.0.1` |
| `BIFROST_HTTPS_PORT` | 默认 8443；回环验收用未占用的非特权端口 |
| `BIFROST_TLS_CERT_FILE` / `BIFROST_TLS_KEY_FILE` | 证书链与私钥绝对路径，私钥置于私有目录、权限 0600 |
| `BIFROST_TLS_STATE_DIR` | 私有状态目录，权限 0700 |

使用 `sandbox-exec -f /absolute/path/direct-tls-loopback.sb /absolute/path/caddy validate --adapter caddyfile --config /absolute/path/Caddyfile` 校验，再以相同沙箱运行 `caddy run`。这些路径和变量需要在宿主的私有配置中设置。配置示例的 `bind` 指定本地地址，不等于 Darwin 接口绑定；仍需按前文检查 TUN 下的实际回包路径。

回环验收使用已有域名证书，固定客户端解析到 `127.0.0.1` 并严格验证 TLS，没有改变该域名的 DNS。验证了无/错误密钥 401、有效密钥的模型目录 200、Origin 403、管理路径 404、SNI/Host 不匹配 421。另用隔离的模拟后端验证 SSE 首帧在后端放行剩余正文之前到达、完整正文一致和断开后的上游取消；模拟后端没有接触 Claude。所有临时监听已关闭。

新的域名、证书自动续期、光猫入站和真实外部速度仍待配置或验收。这组回环结果只证明 HTTPS 入口的本机行为，不代表公网直连已经可用。

## API 与 VM 边界

新增公网监听只接入现有 43158 外部入口，沿用独立客户端密钥、会话命名、并发/频率/正文限制及 API 路径白名单。内部 43157、VM relay、管理页、SSH 和文件共享不作为该入口的上游。

宿主 TLS 进程只需要连接固定回环端口。Claude OAuth 和内部网关/relay 密钥不提供给客户端。VM 继续只有 host-only 网卡；guest DNS、IPv6 禁用、UDP 限制、宿主转发关闭与固定 VPS 出口策略保持独立。

SSE 不能为了压缩或缓存而等待完整正文。Caddy 已对 `text/event-stream` 立即刷新；不要直接套用 `flush_interval -1`，官方说明该设置会改变客户端断开后的上游取消行为。部署后必须重新验证取消传递。

## 上线验收

- 先用隔离的模拟后端和一次性测试身份验证外部入站，无需登录 Claude；不能用同一 LAN 内的访问代替外部测试。
- 从常用大陆客户端分别测试 IPv4 和 IPv6，关闭显式代理并排除 TUN 干扰；检查 DNS、严格 TLS 验证、出口/路由及真实目标。
- 与现有 Funnel 比较首次/复用连接的首字节、512 KiB 上传与下载、SSE 首帧和完成时间、取消行为。512 KiB 的双向测试用于区分大上下文上传与输出下载，不能只测其中一向。
- 覆盖实际需要的电信、联通、移动或工作网络；纯 IPv6 入口必须确认每个使用端均有 IPv6，IPv4 回退需要单独验证。
- 重验无密钥/错误密钥拒绝、管理路径拒绝、并发限流，以及后台进程重启、地址变化后的 DDNS 更新和证书续期。
- 最后复查 VM 的 DNS 与固定 VPS 出口；登录 Claude 后再测真实推理。入口提速不代表 VM→VPS→Claude 这一段也已提速。

## 依据

- [Tailscale Funnel 限制](https://tailscale.com/docs/features/tailscale-funnel)
- [dynv6 免费动态域名](https://dynv6.com/) 与 [API](https://dynv6.com/docs/apis)
- [Let's Encrypt IP 证书与短期证书](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)
- [Let's Encrypt 验证方式与端口要求](https://letsencrypt.org/docs/challenge-types/)
- [Caddy 反向代理、流式与取消行为](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#streaming)
- [frp XTCP 的打洞限制](https://gofrp.org/en/docs/features/xtcp/)
- [Globalping 外部探测 API](https://globalping.io/docs/api.globalping.io)
