# 罕见病协同转诊网络

面向省级卫生管理部门、省级医院、地市医院与基层机构的协同后端：维护辖区人口版本、门诊资质、专科坐诊与可接诊病种；基层在患者授权后提交去标识化转诊摘要；系统识别疑似重复患者与检查、校验必要材料，并按病种能力、距离、候诊与紧急程度给出**可解释候选机构**（不替医生诊断）；接诊、补材、退回、多学科会诊、跨院转接与随访失联全程带责任人、时限与审计；监管端按"当时有效口径"判断覆盖缺口、积压与超时。

零运行时依赖：Node.js ≥ 22 内置 `node:http` 与 `node:sqlite`（WAL 模式）。

## 运行

```bash
npm test      # 28 个测试：服务层、HTTP 端到端、跨连接并发接诊(CAS)、重启一致性
npm start     # 默认 8080 端口，可用 PORT / DATABASE_PATH 覆盖
```

`GET /health` 检查服务与 SQLite 状态。

## 代码结构

```
src/
  database.js               schema/迁移；版本表与事件表禁改禁删触发器
  policy.js                 SLA 时限、候选权重、必要材料、重复判定阈值（口径集中可审计）
  errors.js                 ValidationError / ConflictError / NotFoundError / AuthorizationError
  util.js                   时钟、ID、haversine、事务(IMMEDIATE+BUSY 重试)、HTTP 工具
  app.js                    路由与操作者上下文（x-facility-id/x-user/x-role）
  services/
    registry.js             人口/机构/资质/病种能力/坐诊号源版本链，候诊估算
    authorization.js        分级授权、基因白名单、撤回、允许/拒绝审计
    events.js               append-only 事件、按 as_of 重放状态、超时扫描
    matching.js             疑似重复患者/检查识别；可解释候选排序
    referral.js             提交校验、幂等、接诊/补材/退回/会诊/转接/随访状态机(CAS)
    regulatory.js           as-of 覆盖缺口、积压超时、一致性核查、不可变报告快照
test/
  helpers.js                假时钟、内存/文件库装配、标准监管场景种子
  services.test.js          领域与口径测试（23 例）
  app.test.js               HTTP 端到端与重启一致性（4 例，含健康检查）
  concurrency.test.js       worker 线程跨连接并发接诊互斥（1 例，连跑稳定）
```

## 主要接口

操作者通过请求头传递：`x-facility-id`、`x-user`、`x-role`（监管接口要求 `x-role: regulator`）。

- 目录与口径
  - `PUT /v1/populations`、`GET /v1/populations?as_of=`
  - `POST /v1/facilities`、`POST /v1/facilities/:id/versions`、`GET /v1/facilities?as_of=`
  - `PUT /v1/facilities/:id/qualifications`、`.../capabilities`、`.../schedules`（均只追加版本，可带 `valid_from`）
- 授权
  - `POST /v1/authorizations`（`genetic_results` 必须带 `genetic_facilities` 白名单）
  - `POST /v1/authorizations/:id/revoke`
- 转诊流转
  - `POST /v1/referrals`（可带 `idempotency_key`）、`GET /v1/referrals/:id`
  - `POST /v1/referrals/:id/candidates` → `POST /v1/referrals/:id/candidate-selections`
  - `POST /v1/referrals/:id/accept | return | complete`
  - `POST /v1/referrals/:id/supplement-requests`、`POST /v1/referrals/:id/supplements`、`POST /v1/referrals/:id/documents`
  - `POST /v1/referrals/:id/mdt`、`POST /v1/mdts/:id/schedule`、`POST /v1/mdts/:id/feedback`
  - `POST /v1/referrals/:id/transfers`、`POST /v1/transfers/:id/decline`
  - `POST /v1/referrals/:id/follow-ups`、`POST /v1/follow-ups/:id/attempts`
  - `GET /v1/referrals/:id/duplicates`、`POST /v1/duplicates/patients|checks/:id/resolve`
  - `GET /v1/documents/:id`（基因材料强制白名单+审计）、`GET /v1/referrals/:id/audit`
- 监管（regulator）
  - `GET /v1/regulatory/coverage?as_of=`
  - `GET /v1/regulatory/backlog?as_of=&region=`
  - `GET /v1/regulatory/consistency?as_of=`
  - `POST /v1/system/sweep`（邀请/转接超时清扫，幂等）

## 口径与边界

详见 [`docs/referral.md`](./docs/referral.md)：版本链与 append-only 事件、授权分级与撤回、候选排序权重与"不构成诊断"声明、各环节 SLA、监管 as-of 口径。去标识化摘要示例见 `fixtures/referral-summary.json`。
