# Mac 加密备份与恢复

`scripts/encrypted-backup.mjs` 使用显式文件清单、AES-256-GCM、随机 nonce 和压缩清单，账号、配置、必要密钥均在加密载荷中。摘要和 GCM 校验通过后才保留新备份并清理旧档。读取整组文件前后比较 inode、大小及修改时间，检测原子替换或并发修改并重试；持续写入则失败保留原档，不把部分数据当作成功快照。

示例私有配置（文件 0600、目录 0700）：

```json
{
  "version": 1,
  "keyFile": "/private/Recovery/master.key",
  "directory": "/private/archives",
  "retain": 14,
  "statusFile": "/private/backup-status.json",
  "files": [
    { "name": "state/client-access.json", "path": "/private/state/client-access.json" },
    { "name": "state/client-billing.json", "path": "/private/state/client-billing.json" },
    { "name": "config/gateway.json", "path": "/private/gateway.json" }
  ]
}
```

首次 `create` 独占创建 32 字节恢复密钥，后续复用；key 文件不与档案一起保存，也不能加入 files。拒绝符号链接文件、超大输入、重复或越界目标名。不要备份日志、node_modules、VM 磁盘或备份目录本身。

```sh
node scripts/encrypted-backup.mjs create /private/backup.json
node scripts/encrypted-backup.mjs verify /private/backup.json /private/archives/NAME.bfbackup
node scripts/encrypted-backup.mjs restore /private/backup.json /private/archives/NAME.bfbackup /private/NEW-restore-directory
```

恢复只写入**新目录**，校验每个恢复文件的 SHA-256，不覆盖生产文件。先停写，再由操作者将验证后的数据放回明确目录，修复属主 / 权限，再启动服务。跨账户恢复 root guard 或 LaunchDaemon 仍需系统管理员。恢复后的 started / reserved 账目由既有账本恢复规则进入待核对，不能自动放过未知费用。

Mac 当前部署采用普通用户 LaunchAgent，登录时执行一次，并每天本地时间 04:15 执行，保留最近 14 份。status 文件仅保存成功 / 失败、时间、文件数、档案摘要与是否已有外部副本。恢复演练要实际写入临时新目录、验证完整内容，完成后删除临时明文，不把“能解密”当作完整恢复演练。

本机档案与恢复 key 都在同一台 Mac，不能防整机损坏或当前用户权限被攻破。Mac 外副本目前待配置；选定 NAS / 外置磁盘 / 受控远端后，仅复制已验证的加密档案，并把恢复 key 另存。源码托管和 APFS 本机快照不能代替这份外部副本。

## 分层监测与重启验收

`scripts/check-mac-services.mjs PRIVATE_HEALTH_CONFIG` 每分钟单次检查：本机管理服务、账号入口、公网 HTTPS、模型 relay、root guard 新鲜度和禁止 IPv4/IPv6 转发、VM 内真实 HTTPS 是否仍从指定 VPS 出口，以及备份是否在 26 小时内成功。VM 网络探针复用普通用户本地串口，不启用 SSH、不传入宿主代理凭据、不发送模型请求；宿主仍不能使用仅允许指定客机的专用代理。探针使用串口 advisory lock；其他自动化串口操作也应取得同一设备锁，避免命令交错。

状态区分 `healthy`、`ready_without_model` 和 `degraded`。未登录 Claude 时基础服务可以正常，但不能因此宣称模型已可用。检测到某一层故障或恢复时，最多保留最近 100 条状态变更，并请求发送本机通知；系统通知是否显示仍受 macOS 通知设置影响。每次检查不会反复通知，也不保存响应正文、凭据或邮箱。状态和日志位于私有 Maintenance 目录，不提供公网管理接口。

后台 UTM 操作使用 `examples/mac-claude-vm/bifrost-runtime.applescript` 构建的本机助手；先执行 `python3 scripts/build-mac-runtime-helper.py PRIVATE_HEALTH_CONFIG`，再通过 LaunchAgent 的 `open -W -g APP_PATH` 托管。首次启动由本人在 macOS 系统窗口允许它控制 UTM，不能修改系统隐私数据库代替授权。助手只在启动时尝试启动指定 VM，随后定期刷新普通用户串口地址；健康探针读取这个私有状态文件，不再从无 GUI 授权的后台进程发 AppleEvent。状态超过 45 秒或 VM 不匹配即拒绝探测。交互终端另可使用 `scripts/start-mac-vm.mjs PRIVATE_HEALTH_CONFIG`。

助手处理器显式声明局部变量，并在 UTM 字典中比较运行状态，再写出普通字符串。避免把 `machine` 当作可设置属性而触发 `-10006`，也避免 Foundation 脚本环境将枚举序列化成 AppleEvent 常量，导致实际运行中的 VM 被误报。2026-10-25 已用实际后台助手及读取其私有缓存的 HTTPS 探针复核，基础监测为 `ready_without_model`；这仍不代表 Claude 已登录或真实推理已验收。

不会因每分钟健康检查而启动被手动关掉的 VM。主服务、代理和隧道继续由各自 launchd 任务恢复。UTM 的 URL 启停命令已被移除，使用官方 AppleScript / utmctl 接口，见[官方远程控制说明](https://docs.getutm.app/advanced/remote-control/)。

安装时记录 `kern.bootsessionuuid`。只有后来检测到**不同的整机 boot UUID** 且全部基础检查通过，才写 `passed_after_new_boot` 验收记录；进程重启、VM 重启或当前会话中的检查均不能冒充整机重启通过。验收不自动登录 Claude，也不代替真实推理。

当前 Mac 启用了 FileVault。断电或整机重启后需本人先解锁磁盘并登录，普通用户 LaunchAgent、UTM、隧道和备份随后启动；这不等于无人值守冷启动。实际重启应在确认当前工作已保存后安排。
