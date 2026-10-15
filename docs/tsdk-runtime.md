# TSDK Node.js 运行约定

## 版本与来源

项目当前使用 `core/src/utils/tsdk.wasm`，来源为对应微信小程序的 TSDK `v3.8.6.1785239995`，文件大小为 161,018 bytes，SHA-256 为：

```text
14754428297ee0d5aa6cceee76e6ef076bdac31ceda0ea2e2bf4a0472c8e717f
```

运行时固定参数：

- 小程序 App ID：`wx5306c5978fdb76e4`
- TSDK gameId：`3167`
- appKey：`0`

## Node.js 宿主映射

WASM 导入 `a.a` 至 `a.v`。`core/src/utils/tsdk-runtime.ts` 根据官方 `tsdk.js` 提供以下宿主能力：

- 断言、abort 和内存错误；
- 账号隔离的文件读写及 stat；
- JavaScript 调用栈；
- TSDK 版本、App ID、设备信息和运行时固定表；
- wall clock、monotonic clock 和服务端时间校准；
- TQOS HTTPS 上报。

Node.js 无法提供真实的小游戏触摸、陀螺仪、ACEVM 和函数完整性上下文。这些入口返回官方接口允许的空结果，并仅记录一次降级日志。

## 关键 ABI

| 能力 | WASM 导出 |
| --- | --- |
| memory | `w` |
| create buffer | `A` |
| destroy buffer | `B` |
| init runtime | `G` |
| encrypted init info | `H` |
| heartbeat tick | `M` |
| data to server | `N` |
| data from server | `O` |
| process received data | `P` |
| encrypt in place | `ba` |
| decrypt in place | `ca` |
| speed detection | `fa` |

实例化后使用 `__mergewasm_shared____wasm_decrypt_strings` 和固定密钥逐段解密 17 个 mergewasm 数据段，再执行官方启动导出 `x()`，最后调用 `G(3167, appKeyPtr)`。不能直接调用尚未解密的 `decrypt_all_data()`，否则间接函数表尚未恢复，会触发 `table index is out of bounds`。

## 网关 Token

`gatepb.Message` 的 field 3 为 `token`。登录及普通业务请求使用随机 Token：生成 64～127 个字母数字字符并追加 `=`，总长度为 65～128。

官方客户端在初始化阶段还会产生一种不同格式的一次性 TSDK 凭据。最新抓包中的该凭据为 152 字节 Base64 风格内容，不适用普通 Token 的 65～128 字节及纯字母数字规则。当前实现不会把 `H()` 的返回值注入任意下一条并发业务请求；其精确消费时机需要结合官方 `SdkInitEx`、`RegisterInitCallback`、`AnoUserLogin` 调用链和新的生产抓包继续验证。

## ACE 生命周期

登录成功后启动 `core/src/services/ace.ts`：

- 每 5 秒读取 `N()`，首次读取发生在调度启动约 5 秒后；
- `N()` 非空时发送 `gamepb.acepb.AceService.AntiData`；
- 服务端 `AntiDataReply.result` 非空时传入 `O()`；
- 每 5 秒调用 `P()`；
- 每 25 秒调用 `M()`；
- 每 30 秒执行速度检测；
- 每 150 秒发送 TSDK 状态。

最新 76 帧抓包中，两次非空 `AntiDataRequest.data` 分别为 278 和 186 字节；第二次 `AntiDataReply.result` 为 1081 字节并需要回灌。抓包符合每 5 秒 poll、约每 10 秒产生一次非空上报的行为，但发送间隔由 `N()` 是否返回数据决定，不能硬编码成 10 秒。只有首次成功回灌非空 result 后才记录“AntiData 链路正常”。

同一账号只允许一个 AntiData 请求在途。网络清理、重连和账号停止时会停止 ACE 调度并销毁当前 WASM 实例；下一次连接重新初始化。

## 多账号和资源路径

每个账号运行在独立 Worker 中，因此 CommonJS 模块、WASM 内存和调度器天然隔离。TSDK 可写数据保存到：

```text
core/data/tsdk/<accountId>/
```

WASM 通过 `getResourcePath('utils', 'tsdk.wasm')` 加载，兼容源码运行、TypeScript 编译目录和 `pkg` 资源打包。

## 已知限制与待补证项

- Node.js 无法与微信小游戏的传感器及 JavaScript 完整性环境完全等价。
- 运行时实现以反编译 `tsdk.js`、WASM ABI 和 WSS 抓包为依据。
- 一次性初始化凭据的精确消费时机仍待生产实连验证。
- `GateMessage.meta.server_seq` 在真实客户端中有时取已知最大值、有时取 0，目前没有足够证据恢复置零规则，代码保持现状。
- 最新抓包会话只有约 15.7 秒，没有覆盖 25 秒业务 Heartbeat；Heartbeat 字段和时序仍待下一次较长实连核对。

## 历史生产链路验证

2026-07-28 使用短效登录 Code 对生产网关进行了约 35 秒的实际验证。该记录只适用于旧 TSDK `v3.8.6.1784551013`，不能视为当前 `v3.8.6.1785239995` 已生产实连通过。历史结果如下：

- 旧 WASM 完成数据段解密和初始化；
- WSS 登录成功，服务端接受 TSDK 加密请求和网关 Token；
- 登录后背包和用户设置请求成功；
- 运行期间未出现 WSS 协议错误、ACE 错误或踢下线；
- 验证专用账号目录在结束后已删除。

当前版本完成静态与离线验证后，还需使用一枚全新的一次性 Code 做约 35～60 秒生产冒烟，以覆盖 Login、普通请求、首个及第二个 AntiData、非空回灌、25 秒 Heartbeat、Token 时序和断线行为。
