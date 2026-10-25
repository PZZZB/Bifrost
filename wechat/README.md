# Bifrost 微信小程序

在微信开发者工具导入此目录。当前 `touristappid` 只用于查看项目；真实微信登录、云函数部署和手机预览需要自己注册的小程序 AppID。部署步骤和账号服务配置见 [微信账号接入](../docs/wechat-accounts.md)。

`miniprogram/` 是原生小程序，只有账号注册、登录和密钥管理。`cloudfunctions/bifrost-account/` 是可选的固定目标账号转送函数，不包含模型转发和管理员接口。小程序代码、云函数和 AppSecret 必须分开：AppSecret 只放在 Mac 私有配置目录。

本地检查：

```sh
npm run test:wechat
```

该检查使用模拟微信与本地网关，不代表完整 IDE 项目编译、手机登录或微信发布审核。本次另使用官方开发者工具 2.02.2608080 内置编译器成功编译了两页 WXML 和三份 WXSS；真实 AppID 和云开发环境就绪后还需要完整联调。
