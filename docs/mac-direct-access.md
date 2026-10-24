# 中国大陆访问 Mac 网关：优先验证公网直连

研究日期：2026-10-25（Asia/Shanghai）。目标是让外部客户端仅填写 HTTPS Base URL 和独立 API key，直接访问 Mac 中的网关；Claude 继续运行在隔离 VM 中。

**建议先验证原生 IPv6 直连，并确认能否补齐公网 IPv4。** 双栈直连可兼容更多客户端。当前已部署的 Funnel 继续提供入口；本次研究没有开放新的公网监听、配置光猫或改变 VM 网络策略。直连尚未部署、尚未完成外部测速。

## 当前证据及其适用范围

| 检查 | 结果 | 可以得出的结论 |
| --- | --- | --- |
| 当前 Funnel，大陆电信物理网卡直连，关闭显式代理 | 模拟 SSE 正文 526,767 字节，正文传输 22.631 秒，平均 22.7 KiB/s；首帧 2.705 秒 | 这条线路的此次公网路径表现不足以证明适合作为速度优先入口；不是 Claude 生成速度，也不是已测定的固定带宽上限 |
| Funnel 小请求及连接复用 | 5 次模型目录请求总耗时中位数 1.376 秒 | 复用连接仍有网络等待；不包含模型推理 |
| Mac 物理以太网 | 已有公网 IPv6，包含非 temporary、非 deprecated 的地址 | 具备尝试 IPv6 直连的地址条件；地址和运营商前缀仍可能变化 |
| 原生 IPv6 出站对照 | socket 使用 Darwin `IPV6_BOUND_IF` 绑定 en0；国内站点 TCP 约 8 ms，含 TLS/HTTP 约 53 ms；另一个公网站点也完成 TLS/HTTP | 本机 IPv6 出站可用；不能代替外部连入、上行吞吐或跨运营商测试 |
| 光猫 | 可访问中国电信管理登录页；UPnP SSDP 和 NAT-PMP 公网地址查询未收到回答 | WAN IPv4 与入站防火墙仍需登录查看；没有发现响应不等于不支持相关功能 |

IPv4 出口查询得到的公网地址可能属于上游 NAT，不能据此认定光猫持有可映射的公网 IPv4。当前没有取得光猫 WAN 状态或外部 IPv6 入站成功的证据。

## 方案选择

| 方案 | 客户端要求 | 条件与取舍 |
| --- | --- | --- |
| 公网 IPv4 + IPv6 双栈直连 | 普通 HTTPS 客户端，无需代理或组网软件 | 优先方案；需公网 IPv4、可管理的端口映射，以及 IPv6 的入站放行 |
| 原生 IPv6 直连 | 客户端所在网络实际支持 IPv6 | 可先试验；不能覆盖只有 IPv4 的网络；需验证光猫与 Mac 的入站规则 |
| IPv4 转发节点 → Mac | 普通 HTTPS 客户端 | 无公网 IPv4、又要兼容 IPv4 客户端时的备选；多一跳，应先实测候选线路。网关与 Claude 仍运行在 Mac/VM |
| 当前 Funnel | 普通 HTTPS 客户端 | 已可使用，保留作备用；官方有不可自行调整的带宽限制，现有单线路测速偏慢 |

Tailscale 私网直连或 frp XTCP 需要客户端安装相应组网/visitor 软件，且打洞成功率受网络影响，不能直接替代“任意客户端填 URL 即用”的公网入口。不能仅凭节点位于香港等地就认定速度更快。

## 建议实现

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
