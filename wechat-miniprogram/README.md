# Bifröst WeChat Mini Program

This folder contains development source for the user portal. It supports username/password registration, login, assigned models, API Key creation, expiry display, and revocation. It uses the same `/portal/api/*` service as the browser portal. It does not contain an upstream provider credential or a model proxy.

## Run in WeChat Developer Tools

1. Import this folder as a Mini Program project. `touristappid` in `project.config.json` is a development placeholder. Replace it with the AppID of your own registered Mini Program before a device preview or release.
2. Set `publicRoot` in `config.js` to the HTTPS origin that serves the Bifröst user API, such as `https://bridge.example.org`. Do not include `/portal`, `/v1`, an API Key, or a password. The default `.example` address intentionally cannot make requests.
3. Deploy the Bifröst user listener behind that HTTPS origin. Keep the administrator listener private. Configure the public gateway address on the server so that the connection addresses returned to users are reachable from their client computers.
4. Add this origin to the Mini Program's **request legal domains** in its management console. Use a valid certificate with a complete trust chain and TLS 1.2 or above. Keep URL/domain verification enabled. A production Mini Program cannot use the host computer's `127.0.0.1` address.
5. Use Developer Tools to compile and inspect the page. Register a test account, assign its models from the Bifröst administrator page, then verify key creation and revocation against a non-production server before submitting for review.

The AppID, HTTPS domain, domain ownership/filing, WeChat account permissions, and review/release must be supplied by the operator. This repository is not a published Mini Program.

## Sessions and keys

- The server issues a portal session token. The Mini Program holds it only in `getApp().globalData` and sends it as `Authorization: Bearer ...`. Closing the app requires login again. Passwords, API Keys, and portal sessions are not written to local storage.
- The complete API Key appears only in a successful registration/key-creation response. It is cleared on hiding/unloading the page, logging out, dismissing it, or revoking that key. Copying is an explicit user action.
- List responses show only key summaries. The displayed expiry uses `effectiveExpiresAt`, including the administrator's account key deadline. Creating another key cannot extend this deadline. Key expiry does not delete the login account.
- This first version uses Bifröst username/password login. It does not call `wx.login()` or claim WeChat account authorization. Adding WeChat login later requires a real AppID and a server-only AppSecret, `code2Session`, and an explicit account-binding flow. Neither AppSecret nor `session_key` belongs in this client.

## Connect CodeBuddy and WorkBuddy

The portal displays the complete OpenAI Chat endpoint, such as `https://bridge.example.org/v1/chat/completions`, your assigned model IDs, and the one-time API Key.

- **CodeBuddy IDE:** configure the model using the full Chat endpoint in `models.json`. Its `url` is a complete API path, and `apiKey` is the actual issued Bifröst key. Use an assigned model ID. Enable tool/image flags only for a capability supported by the selected Bifröst model.
- **WorkBuddy:** open Settings → Models → Custom, then enter the URL, API Key, and model ID. WorkBuddy normally checks/completes `/chat/completions`. When using the full endpoint exactly as displayed, its advanced **Custom Protocol** setting lets it use that URL directly.
- The Anthropic Messages endpoint is currently available only for assigned CodeBuddy-channel models. Other displayed model rows explicitly list their supported protocols.

These are client configuration paths. Tool calls, images, reasoning, and streaming depend on the selected channel's Bifröst adapter; no client feature equivalence is implied.

## Official references

Verified 2026-10-23:

- [WeChat network requirements](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html): legal domains, HTTPS certificates, and TLS requirements.
- [wx.request](https://developers.weixin.qq.com/miniprogram/dev/api/network/request/wx.request.html): HTTPS request API and response handling.
- [WeChat login flow](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/login.html): server-side code exchange and session-key handling for a future WeChat identity integration.
- [CodeBuddy IDE model configuration](https://www.codebuddy.cn/docs/ide/Features/models): full endpoint paths and model configuration fields.
- [WorkBuddy model configuration](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model): custom model UI and endpoint handling.
