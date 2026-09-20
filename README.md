# 罕见病协同转诊网络

本项目为省级与地市罕见病门诊之间的协作提供统一服务基础。工程包含 Express 应用、Node.js SQLite 连接、转诊摘要样例与数据边界说明，可继续扩展机构能力、授权访问、会诊流转和监管统计。

## 运行

```bash
npm test
npm start
```

服务默认使用 `8080` 端口，`GET /health` 检查服务与 SQLite 状态。

## 领域资料

`docs/referral.md` 说明转诊与监管口径，`fixtures/referral-summary.json` 提供去标识化摘要示例。
