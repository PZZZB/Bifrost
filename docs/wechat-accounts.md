# 微信小程序注册 Bifrost 网关账号

只需要在微信内打开注册网页时，使用[网页注册方案](web-accounts.md)即可，不必继续小程序注册。本文保留给需要原生小程序与微信身份的部署。

小程序让使用者通过微信登录和一次性邀请码创建自己的 Bifrost 网关账号，领取独立的 Base URL 与 API key，用于 CodeBuddy 等支持自定义 API 的客户端。这里的账号不是 Claude、CodeBuddy、Cursor 或 Codex 的上游登录账号。

首次注册返回 API key，之后登录不改变它，也不能取回明文。小程序支持重置、停用和注销账号；退出登录只撤销小程序登录态。停用、重置、注销和管理员禁用都在下一次模型请求时生效，已经开始的流可能继续完成。

## 连接与权限

```text
小程序 → 微信云函数（账号操作） → 原 HTTPS 隧道 → Mac 127.0.0.1:43158
客户端 → 原 HTTPS 隧道 + 用户 API key → 同一个 43158 → 43157 → 固定 VM 通道
```

默认采用 `wx.cloud.callFunction`，适合尚无自有备案域名的部署。云函数仅允许六种固定账号操作，以环境变量固定 HTTPS 目标，拒绝任意目标、管理接口、模型接口和重定向；不透传调用方提供的 Host、Cookie 或其它认证头。它处理账号凭证，不承接模型请求。服务端仍使用 `wx.login` 的一次性 code 向微信 `code2Session` 校验身份，云函数提供的任意 OpenID 不能替代这一校验。

也可以将 `wechat/miniprogram/config.js` 的 `transport` 改成 `request`，设置 `requestOrigin`，直接通过 `wx.request` 请求同一服务。此方式需要在公众平台配置对应的 HTTPS request 合法域名；官方网络文档要求域名 ICP 备案。非 443 端口并非一概禁止，但配置时必须与实际请求端口一致。不能用开发工具关闭域名检查作为正式上线方案。

Mac 只在显式配置 `wechatAccountsFile` 后增加 `/account/v1/` 接口，继续检查回环来源、明确的 Host 白名单、重复认证头及浏览器 Origin。已有 `clients.json` 及其 API key 保留；注册用户与它们共用原来的总并发限制、凭证校验和按身份隔离的会话。不会公开本机管理页、SSH、VM、文件或任意代理目标，也不改变 VM 的 DNS、网卡、防火墙及 VPS 出口。

默认注册上限为 50，硬上限 90；包含原静态客户端后的总数仍不能超过 100。每个新账号默认 1 并发、每分钟 20 请求，整个模型入口仍默认最多 4 并发。小程序账号接口总计每分钟 300 次，其中登录校验最多每分钟 30 次、同时 2 次；这些限制不依赖可伪造的转发 IP。请求数限制不等于 Token、费用或订阅额度管理。

## 准备 Mac 账号服务

1. 在微信官方注册小程序并完成管理员确认，取得 AppID。AppSecret 只在本机保存，不放进小程序包、云函数环境或 Git。
2. 初始化一个尚不存在的私有目录，下面以占位路径举例：

```sh
node scripts/manage-wechat-accounts.mjs init /absolute/private/External/WeChat
```

初始化创建 0700 目录、0600 `identity.key` 和空 `accounts.json`；已有目录不会覆盖。将 `examples/mac-claude-vm/wechat-accounts.example.json` 复制到该目录的 `config.json`，填入真实 AppID、绝对路径及现有公网 API Base URL，再将 AppSecret 单独写入 `appsecret.key`。配置和密钥均为 0600、归运行网关的用户所有。

3. 在现有私有 `External/gateway.json` 中新增：

```json
{ "wechatAccountsFile": "/absolute/private/External/WeChat/config.json" }
```

这是增加的一个字段，保留原来的 listener、密钥、clientsFile、publicHostname 和 additionalPublicAuthorities。缺少、无效或权限过宽的微信配置会拒绝启动，不会退回无鉴权注册。尚未取得真实资源时，不添加该字段。

4. 更新宿主应用源码并重启外部网关服务。VM relay 不需要更新。

网关使用独立身份 HMAC 密钥保存微信标识的摘要，不保存原始 OpenID、UnionID 或平台 session_key；API key、登录令牌及邀请码均只保存 SHA-256。登录态默认 24 小时、最多可设 7 天；重新登录撤销之前的登录令牌，模型 API key 保持不变。小程序只持久化登录令牌，API key 仅在生成时临时展示，离开页面即清除。

该实现为一台 Mac 上有界的小型账号库，以文件锁串行化网关和本机管理命令，原子替换提交。备份账号库时必须连同 identity.key 一起私密保存。进程恰在写入事务时崩溃可能遗留 `accounts.lock`，此时写操作关闭；先停止外部网关，确认没有管理命令运行，再删除这个锁目录后重启。不要在活跃事务期间删除锁。

## 本机管理员操作

```sh
# 输出一次性邀请码，默认 24 小时有效；只私下交给拟开通的人。
node scripts/manage-wechat-accounts.mjs invite /absolute/private/External/WeChat wxYOUR_APP_ID
# 不输出 OpenID、密钥或登录令牌。
node scripts/manage-wechat-accounts.mjs list /absolute/private/External/WeChat wxYOUR_APP_ID
node scripts/manage-wechat-accounts.mjs disable /absolute/private/External/WeChat wxYOUR_APP_ID wxACCOUNT_ID
node scripts/manage-wechat-accounts.mjs enable /absolute/private/External/WeChat wxYOUR_APP_ID wxACCOUNT_ID
node scripts/manage-wechat-accounts.mjs revoke-key /absolute/private/External/WeChat wxYOUR_APP_ID wxACCOUNT_ID
```

禁用账号会撤销它的登录令牌和 API key；重新启用后需要本人微信登录并生成新 key。没有公网管理员接口。

## 小程序与云函数

在微信开发者工具导入 `wechat/`，将 `project.config.json` 的 `appid` 替换为自己的 AppID，在 `miniprogram/config.js` 填写云开发环境 ID，保持 `transport: 'cloud'`。从微信侧创建或关联云开发环境；腾讯云侧单独创建的环境不能直接假定已经与小程序关联。

上传 `cloudfunctions/bifrost-account` 为普通事件触发云函数，无需第三方依赖。环境变量 `BIFROST_ACCOUNT_ORIGIN` 设置为现有 HTTPS 网关的 origin（只含协议、域名与可选端口，不带 `/v1`），函数超时设为至少 20 秒。不开放 HTTP 触发器，不记录 event、响应正文、登录 code 或凭证。函数内部 HTTPS 最长 12 秒，请求最多 8 KiB、响应最多 16 KiB，使用正常证书校验。

官方云开发提供开发期免费环境；正式使用、额度和续费以账号控制台显示为准，不能假定永久免费。任何付费套餐开通先核实具体价格。

进入小程序，阅读隐私说明、填写邀请码并点击微信登录 / 注册；将生成的 Base URL 和 API key 保存到客户端。上线前根据实际运营主体完善公众平台中的名称、服务类目和用户隐私保护指引并提交审核；项目内的账号隐私说明不是微信审核通过的证明。

## 验收

```sh
npm run test:wechat
npm run check
```

本地测试覆盖官方身份交换的目标与错误脱敏、邀请码竞争、持久化后的登录和密钥、跨账号会话、轮换和撤销、注销及管理员禁用、旧客户端兼容、Host/Origin/认证/路径边界、登录限流、云函数固定目标和重定向拒绝，以及小程序的同意、临时密钥、登录过期与操作确认。所有身份交换与推理上游均为模拟，不使用真实 Claude 登录。

本次另使用官方开发者工具 2.02.2608080 内置编译器成功编译两页 WXML 与三份 WXSS。真实联调另外验收：完整 IDE 项目编译、两名微信用户注册，重复邀请码被拒、手机重进可登录、key 在现有 HTTPS API 可用且不会串会话、旧 key 撤销生效、管理员禁用生效；确认云函数日志不记录凭证。Claude 尚未登录时只验收账号和 API 鉴权，模型可用性仍需单独验收。

依据：[小程序登录](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/login.html)、[code2Session](https://developers.weixin.qq.com/miniprogram/dev/server/API/user-login/api_code2session.html)、[网络与合法域名](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html)、[小程序调用云函数](https://docs.cloudbase.net/recipes/add-cloud-function-wechat-miniprogram)、[创建云开发环境](https://docs.cloudbase.net/quick-start/create-env)。
