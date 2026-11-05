# 会话兼容能力契约

模型出现在目录中，只说明当前路由发布了这个模型。它不能证明已有会话可以分叉、切换模型、切换来源或在进程丢失后恢复。

`src/protocols/conversation-compatibility.mjs` 提供来源中立、无副作用的声明和检查。模块不读凭证、不发请求，也不代替路由鉴权或状态解封。未声明的能力为 `unknown`；未知和不支持都不能通过操作检查。

## 数据状态与执行状态

| 状态 ID | 含义 | 主要边界 |
| --- | --- | --- |
| `plain-history` | 完整的可见消息和已返回工具结果 | 目标必须明确接受完整历史；等待工具的执行不能随历史复制 |
| `authenticated-snapshot` | 当前适配器已验证归属的可复制思考或摘要数据 | 不能据此复制等待中的进程或回调；换模型／来源先做受控明文交接 |
| `completed-checkpoint` | 原生运行时保存的、已完成回合检查点 | 可以按原生条件恢复；不自动视为可复制快照 |
| `live-execution` | 活进程及其等待中的工具回调 | 只可续接同一个有效执行；不支持复制或跨进程恢复 |

本矩阵描述已有会话的状态能力，不判断首条新聊天是否能调用模型。一个请求可能同时带有快照数据和活执行引用：快照可复制，不代表活回调可复制。入口必须按实际操作检查涉及的状态，不能由用户提交一个状态名称绕过校验。

## 创建契约

```js
const contract = createConversationCompatibility({
  protocol: 'responses',
  protocols: model.protocols,
  provider,
  model: model.id,
  adapterCapabilities: currentStatus.responsesCapabilities,
  declarations: { fullHistory: true },
});
```

`protocols` 必须来自当前已登记的模型路由。缺少它时协议本身也为未确认。`provider.supportsSnapshotState(model, protocol)` 仅做本地只读检查；明确的 `true`／`false` 为快照声明，异常、非布尔返回和缺少声明保持未知。它只判断该协议路径的可复制数据状态，不判断远端活进程是否存在。

`declarations` 只使用四个布尔字段：`fullHistory`、`snapshotState`、`liveExecution`、`completedCheckpoint`。非布尔值不构成声明；没有其他明确的适配器提示时保持未知。存在 `supportsSnapshotState` 方法时，其当前结果优先于 `snapshotState`。声明应来自适配器实现；不从模型名称、账号类型或目录存在推断。

模块识别已有的通用续接说明：`bridge-owned-opaque-encrypted-state` 表示可重放完整历史且不持有活执行；`live-sdk-run-and-finished-checkpoint` 表示不能直接导入已有完整历史；`statefulAgent` 声明活执行；`completed-sdk-checkpoints-only` 声明只恢复已完成的检查点。这些提示不自动授予快照复制能力。显式布尔声明可覆盖这些提示。

结果只包含固定字段：`version`、`protocol`、`protocolSupport`、`states` 和 `notGuaranteed`。`states` 的每种状态提供 `continue`、`fork`、`switch-model`、`switch-source`、`restart-recovery` 五项操作。每项包含 `status`（`supported`／`conditional`／`unsupported`／`unknown`）、固定 `reason` 及 `requires` 条件列表。声明不等于当前请求已经满足条件，也不承诺原生功能等价或缓存命中。

## 操作前检查

```js
const decision = evaluateConversationOperation(contract, {
  state: 'authenticated-snapshot',
  operation: 'fork',
  evidence: {
    verifiedStateBinding: true,
    noPendingTools: true,
  },
});
if (!decision.allowed) {
  // 使用固定 reason 和 missing 展示条件；继续保留原状态。
}
```

`evidence` 必须由现有运行校验产生：

- `completeHistory`：请求具有当前操作所需的完整可用历史，工具调用与结果已经核对。
- `noPendingTools`：当前操作不会复制或丢失等待中的工具执行。
- `verifiedStateBinding`：现有解封及归属校验已确认用户、来源、模型和当前授权，且所需密钥仍可用。
- `completedCheckpointAvailable`：原生持久检查点确实存在且回合已完成。
- `matchingHistoryPrefix`：待续接历史与原生检查点／活执行前缀一致。
- `liveExecutionAvailable`：原进程及其等待状态仍有效。

`destinationAcceptsHistory` 由评估器从目标 `target` 契约取得，不能由 `evidence` 自行声称。只有完整明文历史可以直接要求切模型／切来源；不透明状态必须先经已授权的解封或明文交接，将操作对象转换为 `plain-history`，再检查目标。这里不破解或丢弃供应方专用压缩密文。

检查返回 `allowed`、`status`、`reason`、`requires`、`missing`。只有能力明确并且条件齐备才允许。该模块不做重试、状态迁移或进程恢复；调用方仍执行原有鉴权、权限、参数和真实状态校验。
