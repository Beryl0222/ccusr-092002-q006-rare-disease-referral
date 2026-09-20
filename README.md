# 罕见病协同转诊网络

面向省级卫生管理部门、省级/地市罕见病门诊与基层机构的协同后端。解决四个核心问题：

1. **挂牌 ≠ 可达**：门诊资质、可接诊病种、专科坐诊排班分开维护且全部**版本化只追加**，覆盖判断按"有效资质 + 病种能力 + 坐诊排班"三者同时成立，而不是只数挂牌数量。
2. **重复建档/重复检查**：患者以假名标识，跨院通过去标识指纹识别可能重复的患者与检查；转诊文档按内容哈希识别重复提交，接口以 `Idempotency-Key` 幂等拦截。
3. **流转无闭环**：接诊、补充材料、退回、多学科会诊、跨院转接、随访失联都有**时限、责任人、不可变事件与待办**；候选机构只按能力/距离/候诊/紧急度给出**可解释推荐**，明确声明不构成诊断、不自动派单。
4. **历史口径不可重写**：辖区人口与机构能力调整只插新版本，监管端按任意历史时点（as-of）还原覆盖缺口、转诊积压与超时；事件/版本/审计表由触发器禁止 UPDATE/DELETE。

## 技术栈

Node.js ≥ 22，零运行时依赖；HTTP 用 `node:http`，存储用内置 `node:sqlite`（WAL + 外键）。

## 运行

```bash
npm test          # 25 个测试（含跨进程并发接诊、重启恢复）
npm start         # 默认 8080 端口，启动时自动执行一次恢复
PORT=9000 npm start
```

`GET /health` 检查服务与 SQLite。

## 身份与接口约定

- 机构调用：`X-Facility-Id`、`X-User-Id` 头
- 监管调用：`X-Role: regulator`、`X-User-Id` 头
- 幂等：转诊提交支持 `Idempotency-Key` 头（或请求体 `idempotencyKey`）

主要接口（详见源码 `src/app.js` 路由表）：

| 接口 | 说明 |
| --- | --- |
| `POST /admin/facilities`、`/admin/population-versions` | 机构、人口版本（只追加，监管） |
| `POST /admin/facilities/:id/qualifications` `/capabilities` `/schedules` | 资质/病种能力/坐诊排班版本（只追加，监管） |
| `POST /consents`、`POST /consents/:id/withdraw` | 授权与撤回（scope：`referral-summary` / `genetic`） |
| `POST /referrals` | 去标识化转诊摘要：授权校验、必要材料校验、重复识别 |
| `POST /referrals/:id/candidates?asOf=` | 可解释候选机构（快照留痕，供医生选择） |
| `POST /referrals/:id/route` `/accept` `/return` `/transfer` | 派单（医生选定）、接诊、退回、跨院转接 |
| `POST /referrals/:id/supplement-requests` `/supplements` | 补充材料请求与提交 |
| `POST /referrals/:id/consultations`、`/consultations/:id/schedule` `/complete` | 多学科会诊申请/排期/统一反馈 |
| `POST /referrals/:id/followups` `/followup-results` | 随访安排与结果（三次未达判失联） |
| `GET /referrals/:id` | 转诊视图；遗传资料在授权缺失/撤回时脱敏并记拒绝审计 |
| `GET /regulator/coverage?asOf=` | 地区覆盖缺口（按当时人口/能力口径） |
| `GET /regulator/backlog?asOf=` `/regulator/overdue?asOf=` | 转诊积压、超时（按事件历史重放） |
| `GET /regulator/audit` | 访问审计（可按转诊/患者/scope/动作过滤，含拒绝） |
| `POST /ops/recover` | 重启恢复（超时标记、时限补建、一致性核对） |

## 数据模型要点

- **版本只追加**：人口、资质、病种能力、排班各有 `*_versions` 表；某时点 T 的有效值 = `effective_at <= T` 的最新一行，有效期由相邻版本推导。
- **不可变事实**：`referral_events`（事件链）、`access_audit`（访问审计，含拒绝）、`idempotency`、`recovery_log` 均只 INSERT，触发器拒绝改删。
- **遗传/基因资料**：独立 `genetic` 授权范围，可限定可访问机构；撤回后新读取一律拒绝（返回 `restricted:true`），非遗传摘要不受影响；所有尝试（含拒绝）写审计。历史业务事实与审计依法保留。
- **并发**：转诊单行带 `version` 乐观锁，状态流转为 `UPDATE ... WHERE version=?`；事务用 `BEGIN IMMEDIATE`，跨机构/多节点竞争时仅一方成功（409）。

状态机、时限表与恢复流程见 [`docs/states.md`](./docs/states.md)，转诊业务边界见 [`docs/referral.md`](./docs/referral.md)。

## 目录

```
src/
  schema.js          表结构与不可变触发器
  database.js        连接、WAL、事务
  domain/
    service.js       领域服务（版本口径/转诊/工作流/候选/as-of 报表/恢复）
    errors.js        业务错误与 HTTP 状态
    clock.js         时钟与 SLA 时限配置
    crypto-util.js   去标识指纹、内容哈希、球面距离
  app.js             HTTP 路由
  server.js          启动入口（自动恢复）
test/                node:test 测试
test-support/        测试夹具与并发工作进程
fixtures/            转诊摘要样例
```
