# 转诊状态机与时限

## 状态

`submitted` 基层提交
→ `routed` 医生从候选中选定机构派单（系统不自动派单）
→ `accepted` 接诊
↔ `awaiting_materials` 接诊方要求补充材料 / 发起方补齐
↔ `consultation` 多学科会诊（申请 → 排期 → 统一反馈）
→ `transferred` 跨院转接（目标机构重新走接诊时限）
→ 终态：`returned`（退回）/ `completed`（随访成功）/ `lost_to_followup`（三次随访未达或人工标记失联）

## 时限（见 `src/domain/clock.js`，可按紧急度区分）

| 动作 | 时限 | 责任方 |
| --- | --- | --- |
| 接诊 accept | routine 72h / priority 48h / urgent 24h | 被派单/转接机构 |
| 补充材料 supplement | routine 120h / priority 96h / urgent 72h | 发起基层机构 |
| 会诊排期 mdt | 申请后 168h（7 天） | 接诊机构 |
| 会诊统一反馈 mdt_feedback | 排期时间起 72h | 接诊机构 |
| 退回告知 return | 24h | 发起机构 |
| 首次随访 followup | 30 天 | 当前接诊机构 |

每次流转写不可变 `referral_events`（含责任人、时限），并在 `tasks` 中维护待办；
办结、取消、超时都与事件关联。监管端的超时判断不依赖 tasks 当前状态，
而是按事件历史在任意 as-of 时点重放得出。

## 并发与一致性

- 转诊单带 `version` 乐观锁；所有流转为 `UPDATE ... WHERE version=?`，
  跨机构/多节点并发操作时只有一方 `changes=1`，另一方得到 409。
- 每个用例在单事务（`BEGIN IMMEDIATE`）内完成状态更新 + 事件 + 待办 + 审计，
  进程崩溃时整笔回滚。
- 重复提交用 `Idempotency-Key`（或请求体 `idempotencyKey`）在同事务内查写。
- 事件表、审计表、版本表、幂等表、恢复日志均为只追加，触发器拒绝 UPDATE/DELETE。

## 服务重启恢复（`POST /ops/recover`，启动时自动执行一次）

1. 到点未办的 open 任务标记 `overdue`；
2. routed/transferred 但缺失接诊待办（崩溃丢任务）→ 按事件中的 due_at 补建，已逾期直接 overdue；
3. 终态转诊仍挂开放任务 → 取消；
4. 缺少 submitted 事件的转诊只报告（不能凭空补造业务事实）；
5. 恢复本身写追加式 `recovery_log`（started/finished 成对），上次只有 started 说明恢复中途被打断，重启会发现并重跑（动作幂等）。
