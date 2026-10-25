# Mac 注册页的国内标准 HTTPS 入口

微信中的非标准端口提示出现在加载网页之前，网页 JavaScript 无法关闭。注册页可使用国内 cpolar HTTPS 443 入口，模型客户端仍填写原国内 Sakura API 地址。这两条入口最终连接同一 Mac 外部网关，账号和 API key 无需迁移。

```text
微信 / 浏览器
  → cpolar 国内 HTTPS 443
  → 已建立的客户端隧道
  → Mac 127.0.0.1:43158
  → 网关内的 /account/ 页面及账号接口
  → Mac 私有账号库
```

注册、登录及密钥管理不进入 VM，也不经过 VM 的海外 VPS 出口。cpolar HTTP 隧道在服务商入口终止 HTTPS，再经客户端隧道传回 Mac；此配置不宣称浏览器 TLS 一直终止于 Mac。VM 的 Claude、host-only 网络及 VPS 出口配置独立。Tailscale Funnel 可以保留为备用注册入口。

## 客户端与固定地址

从官方渠道取得适用于 Mac 的 ARM64 客户端。先使用随机 HTTPS 地址试测实际用户网络和微信打开情况，再选择固定地址套餐；免费随机地址会变化。固定子域名、可用带宽及每分钟新建连接上限以服务商后台为准。连接数不等于用户数或 HTTP 请求数：复用连接的请求不重复建立 TCP 连接，但一个浏览器也可能建立多条连接。

按官方后台的预留流程选择子域名及地区，将相同地区和名称写入私有配置。模板为 [cpolar-https.example.json](../examples/mac-claude-vm/cpolar-https.example.json)。只保留 `bifrost-website` 一条隧道，目标固定为 `127.0.0.1:43158`，只发布 HTTPS。不要启动安装器自动生成的 SSH 或其他示例隧道。

客户端 3.3.12 的 JSON 配置中，`bind_tls` 与 `inspect` 使用字符串 `"true"`、`"false"`；布尔值会导致配置读取失败。该版本的 `-inspect-addr false` / `web_addr: "false"` 也会报地址解析错误，因此本配置显式关闭隧道流量检查，并由沙箱阻止本地检查界面监听。验收应确认客户端没有本地 TCP listener，而不是仅相信开关文字。不要为解决检查界面绑定错误而扩大入站权限。

运行目录使用 0700，Authtoken、完整隧道配置、LaunchAgent 与日志使用所属用户的 0600 文件；真实密钥和部署地址不要提交到仓库。命令只传配置路径，不把 Authtoken 放进进程参数。不安装系统根证书，不启用远程桌面或 SSH。

## 网关与后台服务

1. 在外部网关 `additionalPublicAuthorities` 中加入服务商实际分配的固定域名，不使用通配符，也不改固定上游地址。
2. 在网页账号配置中，将 `publicOrigin` 改为固定 HTTPS origin，`additionalPublicOrigins` 最多保留两个旧入口，`apiBaseUrl` 仍使用原模型 API。所有网页及展示的 API authority 必须在 Host 白名单内。
3. 删除不再使用的随机域名白名单，防止随机名称日后分配给其他人。保留现有账号库、CSRF key 和客户端密钥；只修改配置，并更新私有分享指南中的注册链接。
4. 以普通用户加载 [LaunchAgent 模板](../examples/mac-claude-vm/local.claude-vps.bifrost-cpolar.example.plist)，使用 [网络沙箱](../examples/mac-claude-vm/cpolar-loopback.sb)。模板中的绝对私有路径需按实际安装目录替换；日志文件应预先创建为 0600。

LaunchAgent 在用户登录后启动，以 `KeepAlive` 处理异常退出，显式采用前台单进程模式，固定加载私有配置中的同一子域名。它不依赖打开的终端；这不代表 FileVault 解锁或用户登录之前就已运行。沙箱允许服务商所需的 443、4443 和 DNS 出站，拒绝网络入站，并仅允许连接回环 43158；内部 43157 和 VM relay 3435 均应实际验证被拒。

## 切换验收

- 使用可信证书从实际国内网络加载 HTML、CSS、JavaScript 和账号接口，再用真实手机微信确认提示与速度；桌面手机视口不能代替微信验收。
- 使用一次性测试邀请和临时账号完成注册、登录、密钥轮换及注销，验证新 key 在原模型 API 生效、旧 key 被拒，并删除测试账号。
- 核对其他站点 Origin 被拒、模型接口仍拒绝浏览器 Origin、Cookie 不能代替模型 key，管理员路由不公开。
- 验证固定配置在客户端重启后仍返回相同地址；受控终止客户端后，由 LaunchAgent 自动恢复，入口恢复可信 HTTPS 200。重启整台 Mac 是另一项验收，不能由进程恢复测试代替。
- 确认隧道实际直连国内节点，没有被宿主日常代理送往海外；VM 出口策略不为注册页提速而改动。

依据：[cpolar 文档](https://www.cpolar.com/docs)、[macOS 固定子域名配置](https://www.cpolar.com/blog/cpolar-quick-start-tutorial-macos-series)、[套餐与连接限制说明](https://www.cpolar.com/pricing)。
