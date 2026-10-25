# 用网页注册网关账号

普通 HTTPS 网页可以在微信内置浏览器或其他浏览器中打开，不需要完成小程序注册。本方案使用邮箱、密码和一次性邀请码，登录后领取独立 API key；不发送邮箱验证码或验证邮件，不读取微信身份。微信网页“一键登录”是另外一种身份接入，官方要求已认证服务号及网页授权域名，不能用未完成注册的小程序 AppID 代替。

网页复用现有公网 origin，访问 `/account/`，`/register` 是跳转入口。手机页面容忍微信附加的 `from`、`isappinstalled` 等查询参数；账号 API 不接受查询参数中的认证或转发目标。可选邀请链接使用 `#invite=一次性邀请码`，前端读取后立即从地址移除；fragment 不作为 HTTP 请求路径发送，也不会作为本站 Referrer 发送。分享这类链接等于提供一次注册机会，默认 24 小时有效。

## 配置

运行环境继续使用 Node.js 22.15+。只更新 Mac 外部网关，不需要修改 VM：

```sh
node scripts/manage-web-accounts.mjs init /absolute/private/External/WebAccounts
```

将 `examples/mac-claude-vm/web-accounts.example.json` 复制为私有 `config.json`，设置绝对 `directory`、公网 `publicOrigin` 和供客户端填写的 `apiBaseUrl`。后者必须是规范 HTTPS origin 下的 `/v1`，可以与注册页使用不同的域名及端口；它仅作为连接信息展示，服务端转发目标仍固定。可选 `additionalPublicOrigins` 最多两个，保留旧注册入口；不配置时只开放主入口。目录 0700，配置、账号库与 `csrf.key` 均为所属网关用户的 0600 文件。所有注册页 origin 及模型 API 的 authority 都必须已在外部网关的 Host 白名单内，否则拒绝启动。

微信对非标准端口的提示出现在加载网页之前，前端代码不能关闭。分享给微信的注册页应使用标准 HTTPS 443 地址，例如 `https://accounts.example.net/account/`，不是简单从已有 TCP 隧道地址中删去端口。现有 Tailscale Funnel 可以单独提供标准端口注册页，客户端继续填写原国内 API 地址；应实测其大陆访问延迟，并保留原入口。标准端口只消除这项触发条件，不保证微信不会因其他客户端规则提示，真实手机仍需验证。国内 Sakura HTTP(S) 标准端口隧道需要自有备案域名，免费的 TCP 子域绑定仍使用分配端口。

需要国内标准 443 注册入口时，可按 [cpolar 独立入口配置](mac-domestic-web.md)部署固定 HTTPS 子域名，模型 API 继续使用原线路，Funnel 保留备用。该说明包括私有配置、普通用户后台服务、流量检查关闭、边界及自动恢复验收；不改变 VM 或账号库。

在已有私有 `External/gateway.json` 新增一个字段，保留其他配置：

```json
{ "webAccountsFile": "/absolute/private/External/WebAccounts/config.json" }
```

更新宿主应用中的相关源码及 `public/accounts/`，然后重启外部网关 LaunchAgent。未配置 `webAccountsFile` 时不开放网页；配置损坏或权限不合要求时拒绝启动，不会关闭注册鉴权作为回退。

网页账号、可选微信小程序账号和原有静态客户端共用模型入口的总并发和总客户端上限。启动时检查三者配置的最大客户端数之和不能超过 100；单个动态账号库最多 90，默认 50。如需同时启用两个默认 50 的动态账号库和静态客户端，应先分配各自上限。实际请求每次读取客户端列表，撤销、注销或禁用后拒绝旧 key 的新请求；在途的模型流可能继续完成。

## 账号操作

```sh
node scripts/manage-web-accounts.mjs invite /absolute/private/External/WebAccounts
node scripts/manage-web-accounts.mjs list /absolute/private/External/WebAccounts
node scripts/manage-web-accounts.mjs disable /absolute/private/External/WebAccounts EMAIL_OR_LEGACY_USERNAME
node scripts/manage-web-accounts.mjs enable /absolute/private/External/WebAccounts EMAIL_OR_LEGACY_USERNAME
node scripts/manage-web-accounts.mjs revoke-key /absolute/private/External/WebAccounts EMAIL_OR_LEGACY_USERNAME
node scripts/manage-web-accounts.mjs reset-password /absolute/private/External/WebAccounts EMAIL_OR_LEGACY_USERNAME
```

`invite` 只输出一次性邀请码及到期时间；按需私下分发。`list` 不输出密码、API key 或浏览器登录令牌。管理员密码恢复会随机生成新密码，同时撤销登录和 API key；恢复结果只应交给经管理员确认的本人。这里不发送密码找回邮件。

邮箱支持普通 ASCII dot-atom 地址，最多 254 个字符，@ 前最多 64 个字符；暂不接受中文、带引号的地址和 IP 字面量域名。输入去除首尾空格，登录名整体不区分大小写，不删除点或 `+` 后缀。此为本站标识符比较策略，并不声称所有邮件服务器均忽略本地部分大小写。

注册先检查格式、邀请码与容量，再由宿主使用默认 DNS 解析器检查邮箱域名的 MX。Null MX（明确不收信）或不存在的域名被拒；没有 MX 时按 RFC 5321 检查 A/AAAA 后备。总查询时限 4.5 秒，超时或 DNS 服务故障返回可重试错误，不消耗邀请码。仅查询域名，不连接邮件服务器、不执行 SMTP 探测、不发送完整邮箱给第三方校验服务，不修改宿主或 VM 的 DNS 配置。登录不重复查 DNS，域名临时故障不会妨碍已有账号登录。

格式和域名检查不能确认具体邮箱存在、可收信或属于本人。账号记录及页面始终为 `emailVerified: false`，只记录域名检查方式和时间；A/AAAA 后备也不代表存在 SMTP 服务。没有邮件找回密码、邮箱修改或自动合并账号的入口。旧版用户名账号保留原 ID、密码、会话和 API key，可从“已有账号”使用原用户名登录；不会自动附会到相似邮箱或微信身份。新注册 API 使用 `email`，登录 API 的 `username` 字段接受邮箱或原用户名。

密码至少 12 个字符、最多 128 个字符且不超过 256 UTF-8 字节，使用每个密码独立随机盐和 Node 原生异步 scrypt（N=131072，r=8，p=1）保存摘要。单进程最多两项密码计算，账号接口总计每分钟最多 300 请求，密码认证最多每分钟 30 次、同一登录名最多 5 次，不相信客户端提供的转发 IP。

邀请码消费、登录名唯一性检查、账号及密钥创建在同一原子文件事务中提交。账号数据有固定数量及文件大小上限，和原小程序共用的文件操作检查属主及权限；两个身份渠道使用独立目录和凭证。进程崩溃若遗留 `accounts.lock`，写操作关闭；先停止外部网关和管理命令，确认无写入者后再删除这个锁目录，不在活跃事务中清理锁。

## 浏览器和模型权限

浏览器登录使用 `__Host-`、Secure、HttpOnly、SameSite=Strict Cookie；登录令牌只保存摘要，不放进页面 JSON 或浏览器 localStorage/sessionStorage。默认 24 小时有效，重新登录撤销此前的浏览器登录态；模型 API key 不因此改变。多个明确配置的注册入口共用账号、邀请码、限流和容量，各域名的浏览器 Cookie 分开，切换域名需重新登录。

所有写操作要求当前 Host 对应的规范 HTTPS Origin、签名 CSRF Cookie 与一致的自定义 CSRF 请求头；注册和登录同样检查。CSRF 签名绑定具体 origin，即使另一个已配置的入口也不能代替当前入口授权写操作。拒绝跨站请求、重复账号 Cookie、请求凭证混用、非 JSON 或压缩正文及超过 8 KiB 的正文。不开放 CORS，不接受调用方选择其他账号编号或网络目标。

页面使用固定静态文件映射、严格 CSP、禁止嵌入和 no-referrer；没有外部脚本、字体、埋点或自动获取微信资料。原生微信内浏览器的复制能力有差异，页面提供长按复制回退。完整新 API key 只在生成时临时展示，离开页面或切到后台后清除。

仅网页账号接口单独允许与当前 Host 相符的已配置 Origin，原 `/v1` 模型接口继续拒绝带浏览器 Origin 的请求。模型请求仍需独立 API key，Cookie 不能替代；本机管理页、SSH、VM 和任意目标代理均未公开。网页账号不能生成邀请码或操作其他人，管理员操作仍在本机 CLI 中完成。

## 验证

```sh
npm run test:accounts
npm run check
# 已在本机安装 Playwright 及 Chromium 时：
npm run verify:web-accounts
```

可用 `BIFROST_PLAYWRIGHT_MODULE` 指定已有 Playwright 模块的绝对路径，`BIFROST_CHROME_PATH` 指定本机 Chrome 可执行文件；无需为了这个脚本改变业务依赖。脚本只使用临时账号库、自签回环 TLS 和模拟模型上游，忽略证书错误仅限该回环测试。它启动独立空白浏览器，不读取日常 Chrome 配置或真实账号；校验桌面及手机视口的注册、登录、Cookie、密钥轮换、页面离开清除和旧 key 拒绝，并输出未含凭证的截图和报告。

单元/协议测试覆盖邮箱格式、Null MX、A/AAAA 后备、域名不存在与 DNS 超时、未验证状态、旧用户名兼容、微信旧接口兼容、客户端会话隔离、旧客户端兼容、Origin 与 CSRF 拒绝、Cookie 隔离、密码摘要、一次性邀请码竞争、注册上限、禁用、注销、密码恢复及登录限流。测试及离线浏览器注入 DNS 结果，不依赖真实邮箱或发信。桌面 Chrome 手机视口或模拟微信 UA 的结果，不代表已在真实微信手机中验收；正式公网 HTTPS 仍应从实际用户网络检查，模型权限仍需管理员完成 Claude 登录后单独验收。

依据：[Sakura Web 穿透](https://doc.natfrp.com/app/http.html)、[Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel)、[微信网页授权](https://developers.weixin.qq.com/doc/service/guide/h5/auth.html)、[OWASP 输入校验](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html#email-address-validation)、[RFC 7505 Null MX](https://www.rfc-editor.org/rfc/rfc7505.html)、[OWASP 密码存储](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)、[Node scrypt](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)。
