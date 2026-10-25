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
