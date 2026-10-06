# 球场端 Tee Time 管理模块 — 产品 / 算法 / 后端合同

> 仓库位置：`tee/`（球场端控制台 `index.html`、客户端原型 `live.html`、引擎 `js/`、测试 `test/`）。
> **客户端的正式载体是一杆高尔夫 App / 小程序**，球童不需要单独版本：球童就是带「球童」角色的 HIO 账号。`live.html` 只是客户端逻辑与隐私数据合同的网页原型（演示、验收用，也可作为小程序 WebView 内的 H5 兜底）。
> 本文是产品需求、算法定义、前后端接口合同与「是否共用后端」方案的唯一来源；引擎代码以本文为准，后端 Java 移植以 `tee/test/fixtures/` 黄金用例为准。

---

## 1. 产品概述与角色

| 角色 | 入口 | 做什么 |
|---|---|---|
| **球场运营 / 出发台（OPERATOR）** | `tee/index.html` 发球表 | 新增预订、系统给出可行开球时间、签到、开球、标记未到、改时、全场暂停、旺季并组 |
| **巡场（MARSHAL）** | `tee/index.html` 实时场况 | 看各洞球组位置与黄点/红点、按优先级催促、让行、记录球组进度 |
| **打球人（PLAYER）** | App / 小程序（原型 `tee/live.html`） | 以 HIO 账号登录；看各洞当前有几组人（不显示姓名，好友除外）、本洞还剩多久、红色预警下「让后组先过」建议、给球童评分（仅自己可见） |
| **球童（CADDIE）** | App / 小程序，同一账号加「球童」角色（原型 `tee/live.html`） | 用球场发的邀请码在 App 内登记为球童（需球场批准）；记录本组开球/离开果岭、看同样的场上信息、给客人评分（仅自己可见） |

颜色约定：**会员 = 黑色芯片，普通 = 白色芯片**（与预警颜色完全独立）；**黄点 = 已超时（危险），红点 = 超时 10 分钟以上**。预警从不只靠颜色表达，点旁边一定有「黄 / 红」文字与无障碍标签。全站不使用绿色。

## 2. 球场数据与标准时间

球场提供：每洞的设计（洞号、标准杆、码数可选）、**每洞打球标准时间**（从开球到离开果岭；默认 **3 杆 7 分、4 杆 11 分、5 杆 15 分**）、**车开到下一洞发球台的转场时间**（默认 2 分钟，第 1 洞为 0）。默认 18 洞球场一轮 = 198 分打球 + 34 分转场 = 232 分钟（3 小时 52 分）。

每洞另有三项「占用规则」参数（都可现场调）：

- `clearFrac` **放行比例**：前组在本洞打了多大比例后，后组才能开球。**三杆洞 = 1.0（必须整洞清空，后组才能开球）**，四杆洞 0.45、五杆洞 0.40（前组离开落球区即可开球）。
- `minGap` **开球最小间隔**：同一洞两组开球至少相隔 6 分钟。
- `minFollow` **不可超越**：后组离开果岭不早于前组离开果岭 + 1 分钟。

**校准（"系统是否可以根据测试的情况调整"）**：引擎记录每组每洞的实际用时（排除因等前组而被「卡住」的洞），对每洞取**原始分钟数中位数**（不除以球组步速因子，否则全局偏差会被球员因子吸收而永远发现不了）；样本 ≥ 30 且与现值相差 ≥ 1 分钟时在「球场参数 → 校准建议」列出 **当前 / 实测 / 建议** 及对基础间隔的影响，一键采纳或全部采纳；转场时间取 20 分位（等待会抬高转场观测值）；可开启自动校准（每洞每 7 天最多调 ±1 分 / ±0.5 分）。「恢复默认 7/11/15」随时可用。

## 3. 派发算法（开球时间计算）

### 3.1 投影模型

每个球组 g 有计划步速因子 `fPlan`（1.0 = 标准，§4），对洞 i：

```
play_i   = std_i × fPlan                      转场不随步速缩放(车速与人无关)
arr_0    = 开球时间 ;  arr_i = finish_{i-1} + transit_i
start_i  = max(arr_i,  前组.start_i + minGap_i,  前组.start_i + clearFrac_i × 前组在该洞的用时)
finish_i = max(start_i + play_i,  前组.finish_i + minFollow_i)
```

每组只依赖**紧挨着的前一组**（马尔可夫性质）：前面的组永远不会被后面的组影响。已在场上的组用实际事件（开球 / 离开果岭时间）锚定，未发生的洞从「现在」起继续投影。

### 3.2 6–8 分钟从哪里来，为什么没有数据时是 8

瓶颈是三杆洞：后组要等前组整洞清空，标准步速下 7 分钟。令 `B(f) = max_i max(minGap_i, clearFrac_i × std_i × f)`，默认球场 `B(1.0) = 7`；加 1 分钟安全余量并取整 → **基础间隔 I_base = 8**。没有任何客户数据时所有球组 `fPlan = 1.0`，推荐间隔恰好 8 分钟——这是模型推导出来的，不是写死的常数。

某组后面应留的间隔 `iRec = clamp(round(8 × fPlan), 6, cap)`：常规 cap = 8，有可靠「快」历史的组可以到 6–7 分钟；慢组（`fPlan > 1` 且置信）cap 放宽到 10 分钟。全部整分钟，便于发球表显示。运营可对单个预订设置 `intervalOverride`，设了就按该值、不再计算。

| fPlan | 0.75 | 0.80 | 0.85 | 0.90 | 0.95 | 1.00 | 1.10 | 1.25 | 1.40 |
|---|---|---|---|---|---|---|---|---|---|
| iRec | 6 | 6 | 7 | 7 | 8 | 8 | 8（置信则 9） | 10（置信） | 10（上限，原值 11） |

间隔 6 时标准步速的后组会在**第一个三杆洞**等 1 分钟（第 3 组等 2 分、第 4 组等 3 分，只在那一洞付一次，之后队形自动拉开为 7 分钟）——所以 6 分钟只给确实快的组。

### 3.3 「千万不能影响后面人」的判定

新增 / 改时一个预订时，引擎依次检查：

1. 与前一组间隔 ≥ 前一组的 `iRec`（`GAP_AHEAD`）；
2. 与后一组间隔 ≥ 本组的 `iRec`（`GAP_BEHIND`）；
3. **把本组放进去后整表重投影，后面每一组每一洞的开球与离开时间都不能比放入前更晚**（默认容差 0；`IMPACTS_BEHIND`，并指出受影响的组与分钟数）。

通过后再给出本组自身的预计等待（如「预计等待 4 分」）供参考；自身等待超过 15 分钟时附带警告 `CAND_WAITS`。时间查找器在请求时间 ±60 分钟内（且不早于「现在」、不超出营业时间）逐分钟扫描，按 `|偏离请求时间| + 0.5 × 自身等待 + 3 × 碎片间隔数 + (自身等待 > 15 分 ? 10 : 0)` 排序（碎片 = 与前 / 后组之间留出 0 < 空隙 < 6 分钟、无法再塞一组的间隔），返回最优 5 个，并汇总被拒原因（「其余 23 个时间不可行：影响后组 15 · 间隔不足 8」）。

### 3.4 出发台实际操作

发球表显示每组的**建议开球时间** `sendAt = max(计划时间 + 全场暂停, 上一组实际开球 + 上一组 iRec)`。前组开晚了，后组的建议开球时间自动后移，避免在发球台上把纸面间隔打乱；比建议开球时间提前 2 分钟以内可直接开球，提前更多则弹出「距前组仅 N′（建议 ≥ I′），确定开球？」确认。计划开球前 15 分钟仍未签到的预订显示「未签到」提示；计划开球时间过后 5 分钟（宽限）仍未签到的预订才出现「标记未到」按钮，由出发台手动点击（永不自动）。全场暂停 N 分（天气）只平移所有未完成组的基准，不给任何组记超时。

## 4. 步速学习（客户打球数据的保留与利用）

- 每组完赛后，对每个「干净」洞（没有在发球台等待、离开果岭不紧贴前组、事件完整）计算 `实际用时 / 标准时间`，取**中位数**作为本轮因子（≥ 6 个干净洞才记分；中位数对一次找球不敏感）。
- 每位球员：指数移动平均 `α = max(0.3, 1/(n+1))`（前几轮权重大），限制在 [0.75, 1.4]，有效回合数 180 天半衰期衰减。
- 球组因子 = 0.6 × 最慢球员 + 0.4 × 平均（球组基本跟着最慢的人走），再做**置信收缩**：`fPlan = 1 + w(f − 1)`，`w = n/(n + n0)`，**「慢」的证据 n0 = 1 快速采信，「快」的证据 n0 = 3 谨慎采信**。未知球员按 1.0 计；未知人数达一半以上时 fPlan 不低于 1.0 → 仍是 8 分钟。
- 例：某常客三轮 0.80 / 0.85 / 0.80 → f 0.817、fPlan 0.908；四位这样的常客 → 推荐 7 分钟；三位常客 + 一位陌生客人 → 8 分钟。两轮 1.30 / 1.25 的慢客 → 原值 9 分钟但尚未置信，表上仍给 8 并标注「慢组」。

## 5. 实时监控与巡查建议

- **滞后（lag）**：以**实际开球时间**为锚，按标准时间（或可选：含等待的计划投影）算出每洞应开球 / 应离开的参考时间；`lag = max(本洞实际开球 − 参考开球, 现在 − 参考离开)`。出发台造成的开球延迟单独显示，不计入球组滞后。
- **位置感知**：只有前方真的空出来了才怪这组。`openAhead` = 前组离开本洞到现在的时间 − 两组实际开球间隔（下限 6 分钟）（前组还在同一洞或缺数据 → 0；前组领先 ≥ 2 洞或本组是领头组 → ∞）；`effLag = min(lag, openAhead)`（可在球场参数中关闭位置感知）。
- **黄 / 红状态机**（带滞回与驻留）：effLag ≥ 1 分 → 黄；≥ 10 分 → 红；红降黄需 ≤ 8，黄降绿需 ≤ 0.5，且每级至少驻留 1 分钟；**升级永远即时**。
- **原因标签**：超时且被判定为自身慢 → `OWN`（实心黄/红点，建议催促）；超时但被前组堵住 → `AHEAD`（空心点，「被前组阻挡」，优先级大幅降低）。
- **巡查列表**：按 `级别×1000 + (OWN 300) − (AHEAD 500) + 10×lag + 20×被堵住的后组数` 排序；一行读完：`● 红  第 7 洞  超时 12′  影响 2 组  ●●○○  球童 17  2′前`，操作「催促」（10 分钟内不再重复提醒，升级除外）/「让行」/「忽略」（20 分钟）；已催促的行排到列表末尾。
- **让后面一组先过**：仅当本组 **红** 且 **OWN**、后组正紧贴或在本洞发球台等待、后组不比本组慢、剩余 ≥ 3 洞、20 分钟冷却——才向本组球员与球童手机推送「后组正在等候，建议下一洞让后组先打」，由本组点「已让行」或巡场记录；系统从不自动执行。

## 6. 旺季并组建议

- 触发：手动「旺季模式」、有候补、或任意 2 小时窗口利用率 ≥ 85 %。
- 候选：两组各 ≤ 2 人、合计 ≤ 4、开球时间相差 ≤ 30 分、步速因子相差 ≤ 0.2、都允许并组。
- 评分 0–100：好友 35、步速接近 25、时间接近 20、人数凑满 10（合计 4 人 10 / 3 人 6 / 2 人 3）、同为会员或同为普通（或互为好友）10。每轮最多采纳候选对的 30 %（贪心、互不重叠）。
- 保留哪个时间：**只有一方有会员 → 会员那一方保留（会员优先保留原时间）**；否则人多的一方；再平则取更早的时间，空出更值钱的后段时段。
- 可行性：合并后的组放回保留的时间，后面每一组不得比**今天现有发球表**上更晚（同 §3.3）。
- 流程：建议 → 发送提议 → 双方各自同意 → 确认 → 应用（被并方状态「已合并」）；任一方拒绝即终止；24 小时或开球前 2 小时过期；表有变动时自动复核，不再可行则撤回。

## 7. 客户端（球员 / 球童）

> 正式实现在 App / 小程序内，调用第 9 节的「球员 / 球童接口」；本节规则对 App、小程序和网页原型同样适用。

- 球员与球童都用一杆高尔夫账号，不分版本；球童在 App 内用球场发的邀请码登记为该球场的球童，由运营批准后生效（网页原型的「我是球员 / 我是球童」注册只是演示占位）。**演示模式按姓名 / `?group=<id>` 找球组只是占位**：后端必须只从 JWT 绑定身份与所属球组，绝不能信任请求里的姓名或球组 id；待批准（pending）的球童不能记录事件或评分（服务端返回 40301，演示数据层同样校验）。
- **各洞位置**：每洞只显示有几组、每组几人、所处阶段；**仅互为好友且好友开启「场上可见」时显示姓名**。其他球组的预订号、姓名、会员身份、开球时间、滞后、球童身份一律不出现在客户端数据里（服务端与演示模式使用同一个过滤函数 `clientSnapshot`）。
- **本洞还剩多久**：按本组开球时间 + 本洞标准时间 × 步速、再受前组离开果岭约束，显示「约 6 分钟」或「已超时 3 分钟」；转场中显示「前往第 N 洞 · 预计 HH:MM 开球」。
- **让行建议**：只在本组红色预警时出现（§5）。
- **评分**：球童给客人、客人给球童，1–5 星 + 标签 + 备注；**只有评分人自己能看到自己给出的评分**，被评方看不到，v1 不提供任何汇总（若未来给管理层开汇总开关，评分表单必须明示）。

## 8. 前端架构与演示模式

- 纯静态、零构建、零 CDN：`tee/js/course.js → pace.js → learn.js → live.js → merge.js → sim.js → store.js → ui.js` 依次加载，统一挂在 `window.HIOTee.*`，同一份文件可在 Node 中 `require()` 单测（`node tee/test/run.js`，含「引擎文件不许碰时钟 / 随机 / DOM / 网络 / 存储」的 lint）。
- 引擎纯函数、确定性（`now` 与随机数都由外部注入），是后端 Java 移植的参考实现；`tee/test/fixtures/*.json` 为黄金用例，双端都应逐条通过（`engineVersion` 对齐）。
- `store.js` 数据层：`ApiDataSource` 对接 §9 接口；后端不可达（3 秒内 `GET /tee-api/v1/me` 失败）自动降级为 `LocalDataSource`——localStorage + 种子化模拟器 `sim.js` 推演一整天（可 ×1/×10/×60），黄点 / 红点 / 让行 / 并组 / 校准都能在演示里出现。多标签页同开时只有持有租约的一页推进模拟。
- 冒烟测试 `node tee/test/smoke/smoke.js`：Chromium 打开两页（桌面 + 手机），零控制台报错、无横向溢出、关键元素存在、客户端不泄露其他球组姓名。

## 9. 后端接口合同（`/api/v1/tee/**`，网站侧经 nginx 同源反代为 `/tee-api/v1/**`）

**通用**：响应信封 `{ code: 0, data }`；错误 `{ code, message, data? }`：40001 参数、40101 未登录、40301 无权限、40401 不存在、40901 版本冲突、**42201 开球时间不可行（data = 可行性结果 + 备选时间）**、42202 间隔不足、42901 限流。请求头：`Authorization: Bearer <HIO JWT>`；所有创建类 POST 带 `Idempotency-Key`（服务端 24 小时内重放同一响应）；PATCH 带 `If-Match: <version>`。时间字段：开球时间为「当日分钟数」整数（08:08 → 488），日期 `YYYY-MM-DD`，时区取球场。

**鉴权**：员工 = `tee_staff(course_id, user_id, role ∈ ADMIN|OPERATOR|MARSHAL)`；球员 / 球童 = 当日（±1 天）该球场某球组的 `tee_group_member`；球童注册需邀请码。**令牌不进 URL**：`live.html` 在 App 内嵌 WebView 中由 App 注入令牌（postMessage / Cookie），控制台登录后存 `sessionStorage`。

**员工接口**

| 方法 & 路径 | 说明 |
|---|---|
| `GET /me` | `{ userId, name, roles:[{courseId, role}], defaultCourseId, serverTime, engineVersion }` |
| `GET/PUT /courses/{cid}/profile` · `PUT /courses/{cid}/holes` | 球场配置、每洞参数（std / transit / clearFrac / minGap / minFollow） |
| `GET/PATCH /courses/{cid}/sheets/{date}` | 当日发球表（旺季模式、营业时间、全场暂停） |
| `POST /courses/{cid}/sheets/{date}/groups:check` | **干跑可行性**（与 §3.3 完全相同的算法，服务端为准） |
| `POST /courses/{cid}/sheets/{date}/groups` | 新建预订；不可行返回 42201，`force` 需 OPERATOR 以上并记审计 |
| `PATCH /courses/{cid}/groups/{gid}` | 签到 / 未到 / 取消 / 开球 / 改时 / 备注（改时再次跑可行性） |
| `POST /courses/{cid}/groups/{gid}/events` | 巡场手工记录球组进度 `{holeNo, type: arriveTee|teeOff|leaveGreen, t?}` |
| `GET /courses/{cid}/sheets/{date}/live?since={seq}` | 增量实时数据（单调 `seq` 游标，未变化返回 304 + ETag） |
| `POST /courses/{cid}/alerts/{aid}/ack` | 催促 / 忽略 / 让行记录 |
| `GET /courses/{cid}/sheets/{date}/merge-suggestions` · `POST /courses/{cid}/merge-proposals` · `POST …/{pid}/apply|cancel` | 并组建议与提议 |
| `GET /courses/{cid}/calibration` · `POST /courses/{cid}/calibration/adopt` | 校准建议与采纳 |
| `GET /courses/{cid}/pace/players/{uid}` | 球员步速因子（只给数字，不给逐轮明细） |
| `GET/POST/DELETE /courses/{cid}/staff` · `POST /courses/{cid}/caddie-invites` | 员工与球童邀请码管理 |

**球员 / 球童接口**

| 方法 & 路径 | 说明 |
|---|---|
| `GET /me/today` | 我今天的球组（本组成员姓名可见） |
| `GET /groups/{gid}/live` | **隐私过滤后的** `ClientSnapshot`：`{ now, me, holes:[{no, par, groups:[{size, isMine, phase, friends:[{name}]}]}], behindGroup?: {size}, aheadGroup?: {holeNo, phase} }`——`aheadGroup` 只给前组所在洞号与阶段（无任何身份字段），`live.html` 用它显示「前组在第 N 洞」；服务端 DTO 须与 `Live.clientSnapshot` 字段一致（`tee/test/live.test.js` 断言其他球组不含 id / 姓名 / 会员 / 开球时间 / 滞后 / 球童） |
| `POST /groups/{gid}/events` | 球童 / 球员记录开球、离开果岭（服务端按 (组, 洞, 类型) 语义去重取最早；时间以服务端为准，客户端时间只接受 ±2 分钟） |
| `POST /groups/{gid}/play-through` | `{ action: accepted|ignored }` |
| `GET /merge-proposals` · `POST /merge-proposals/{pid}/respond` | 并组邀请（对方信息只给人数与好友姓名） |
| `POST /ratings` · `GET /ratings/mine?groupId=` | 评分；**没有任何按被评人查询的接口** |
| `POST /caddie/register` | 球童注册（邀请码） |

**实时策略**：第一阶段轮询（控制台 10 秒、客户端 15 秒、后台标签 30 秒），服务端对每个 (球场, 日期) 的实时表缓存 2–5 秒；第三阶段可加 WebSocket（nginx 已有 `connection_upgrade` map，推送与轮询完全相同的增量 JSON，前端只换传输层）。

**数据表（建议，前缀 `tee_`）**：`tee_course_config`、`tee_hole`、`tee_day_sheet`（含 `seq`）、`tee_group`（含 `version`、`plan_snapshot` JSON、`play_through` JSON）、`tee_group_member`（球员 / 球童，软引用 `user_id`）、`tee_progress_event`（追加写，`seq`）、`tee_alert`、`tee_merge_proposal`、`tee_pace_player`、`tee_pace_observation`、`tee_rating`、`tee_caddie`、`tee_staff`、`tee_idempotency`。对核心表只做软引用（`user_id` / `course_id` 索引列，不建外键），便于将来整体迁出。

**可行性的归属**：服务端是唯一事实来源——所有预订创建 / 改时都在服务端重跑 §3.3；前端引擎只做即时预览与演示。两端一致性由 `tee/test/fixtures` 黄金用例 + `engineVersion` 保证。

## 10. 是否共用同一个后端？——推荐：共用，但做成独立模块

**推荐在 `HIO-backend` 内新增模块 `com.hio.tee`（而不是单独起一个服务）**，理由：

1. 这个模块的价值恰恰在于「关联」：用户与会员身份、好友关系（决定场上能否显示姓名）、200+ 球场的逐洞 par / GPS 数据、以及 **App 记分卡逐洞保存事件** —— 后者是最便宜、最可靠的球组位置与真实打球时长信号，顺手就把「客户打球数据保留并用于调整时间」做了。单独后端要复制鉴权、同步用户 / 好友 / 回合数据，还要为每次记分卡保存做跨服务钩子。
2. 一套登录：球员、球童本来就有 HIO 账号，球场员工只是多一行 `tee_staff`。
3. 部署路径现成：nginx 蓝绿上游 `aigolf_app` 与 `/public-api/` 同源反代的模式照搬即可（本仓库已加 `/tee-api/v1/` 路由）。
4. 团队规模：一个后端、一个值班面。

**如何「共用而不纠缠」**：

- 模块只通过四个端口与主应用交互：`UserLookup`（用户 / 会员）、`FriendshipQuery`（互为好友）、`CourseCatalog`（洞数据）、`ScorecardEvents`（监听「某洞成绩已保存」事件；若现在没有该事件，在记分卡服务里加一行 `publishEvent`）。
- 独立表前缀 `tee_*`、独立 Flyway 迁移、对核心表只做软引用；独立 `@ConfigurationProperties("hio.tee")`、独立线程池与限流桶（轮询风暴不能拖慢消费端 App）；功能开关 `hio.tee.enabled`（默认关，灰度开）。
- 风险与对策：发版耦合 → 蓝绿 + 功能开关、小 PR；轮询负载 → `seq` 游标 + ETag/304 + 2–5 秒缓存；隐私外泄 → 客户端专用 DTO（`ClientSnapshot`）+ 服务端过滤测试；新的员工身份 → `tee_staff` 由运营邀请、关键操作审计。

将来若球场端业务量远超 App，`pg_dump -t 'tee_*'` + 把四个端口换成 HTTP 适配器即可整体迁出。

## 11. 部署与路线图

**部署**：静态文件随仓库 `git pull` 即生效；`nginx/hiogolf-site.conf` 新增了 `/tee-api/v1/` 反代，需重新拷贝配置并 `nginx -t && systemctl reload nginx`。后端未上线期间接口返回 502，页面自动进入演示模式，不影响访问。

**路线图**

| 阶段 | 内容 |
|---|---|
| 0（本仓库，已完成） | 演示模式、JS 参考引擎 + 单测 + 黄金用例、控制台与客户端页面、接口合同 |
| 1 | `HIO-backend` 新增 `tee` 模块（只读）：员工登录、从记分卡事件生成实时表与步速观测，控制台切到 API 模式 |
| 2 | 服务端预订与可行性（`groups:check`）、App / 小程序实现客户端（球组位置、本洞倒计时、让行、球童登记、评分） |
| 3 | 并组提议与推送、自动校准、WebSocket 增量、GPS 围栏自动生成进度事件 |

## 12. 已知限制 (v1)

- **单一线路**：一张发球表 = 一个球场 × 一天 × 一条线性线路（`routingId`）。不支持共用洞、shotgun（同时开球）、1 号洞 / 10 号洞交叉出发；引擎接口以有序洞列表传参，留有扩展口。
- **领头组的判定**：位置感知只看紧挨着的前组。前组完赛离场后，后组成为领头组（`openAhead = ∞`），此前被前组堵住累计的滞后会一次性全部算到它头上，可能瞬间变黄 / 红；巡场需结合「被前组阻挡」历史判断。
- **仅演示模式可用的功能**：种子化模拟器 `sim.js`、×1/×10/×60 时钟与「跳到 HH:MM」、自动开球开关、自动签到、并组提议的「模拟 A/B 接受 / 拒绝」按钮、`?role=&group=` 演示身份、localStorage 持久化与多标签页租约。API 模式下这些由后端与真实事件取代。
- **可行性以后端为准**：前端引擎只做即时预览；并发改表、权限、审计都在服务端。演示模式下 `force` 直接放行，不记审计。
- **评分**：只存评分人本地（演示）或仅评分人可读（API），无汇总、无按被评人查询。
- **校准**：转场时间只有在球童 / 球员记录「已到发球台」或连续两洞事件完整时才有观测；GPS 自动事件要到阶段 3。
- **步速学习**：每轮只产生一个因子，按球组内每位球员同等更新；不区分个人与同组其他人的影响，首轮数据对单人权重大（α ≥ 0.3）。

## 附录 A. 引擎接口速查

以下为 `tee/js/*.js` 的公开导出（Node 下 `require('./tee/js/<模块>.js')`，浏览器下 `HIOTee.<模块>`），时间单位均为「当日分钟数」，`cfg` 为 `course.config`。

**Course（`course.js`）**：`defaultConfig()`、`mergeConfig(base, patch)`、`normalizeCourse(course)`、`holesForRouting(course, routingId)`、`bottleneck(holes, f)`、`derivedIBase`、`demoLayout()`、`decayN(nEff, lastRoundDate, todayDate, cfg)`、`fmtHM / parseHM / fmtDur`、`clamp / mean / median / percentile`、`dayNumber / daysBetween`、`compareByTee`、`EPS`。

**Pace（`pace.js`，依赖 Course）**

- `toPGroup(booking, plan, { fieldHoldMin, progress })` → 引擎输入 PGroup（已开球的组用实际开球时间与逐洞实况锚定）。
- `sheetGroups(bookings, plansById, { fieldHoldMin, progressById, order })` → 按「场上组（按 order）→ 未开球组（按时间、id）」排好的 PGroup[]。
- `projectGroup(holes, g, prev, now)` → 单组逐洞投影 `{ id, tee, f, rows, finish, roundMin, waitMin }`。
- `projectSheet(holes, groups, { now })` → `{ byId, list }`，按数组顺序投影整张表，O(N·H)。
- `iRec(group, cfg)` → `{ interval, raw, capped, floored, slow, uncapped, override }`，某组后面应留的推荐间隔。
- `playerPlan(stats, cfg, todayDate)` → `{ f, fPlan, nEff, roundsScored, known }`，单人置信收缩。
- `groupPlan(players, statsById, cfg, todayDate, size)` → `{ f, fPlan, confident, unknown, size }`，球组规划因子。
- `insertCand(groups, cand)` → 把候选组插入到正确位置后的新数组（场上组保持在前）。
- `checkInsert(holes, cfg, sheetGroups, cand, { openMin, closeMin, now, baseline, frozenPlans })` → `{ ok, reason, need, shiftMin, victimId, candWait, candRound, projection, warnings, prevId, nextId }`。
- `suggestSlots(holes, cfg, sheetGroups, { tReq, windowMin, plan, size, openMin, closeMin, now, baseline })` → `{ slots[≤5], rejected, scanned }`。
- `autoPack(holes, cfg, requests, openMin, closeMin)` → `{ placed, waitlist }`，按请求时间顺序贪心排布。

**Learn（`learn.js`，依赖 Course）**

- `observeRound(holes, booking, events, aheadEvents, fGroup, cfg)` → `{ observations, fRound, cleanHoles }`，一轮的逐洞观测与本轮因子（中位数，≥ 6 干净洞）。
- `updatePlayer(stats, fRound, date, cfg)` → 新 PaceStats（EMA，α = max(0.3, 1/(n+1))，有效回合数按半衰期衰减）。
- `decayedN(stats, today, cfg)` → 今日视角下的有效回合数。
- `calibrate(observations, holes, cfg)` → 每洞 `{ holeNo, n, nTransit, current, observed, suggested, effectOnIBase }` 校准建议。
- `applyCalibration(course, picks, cfg, { limitStep })` → 新 Course（`layoutVersion + 1`），可限制单次步长 ±1 / ±0.5。
- `resetDefaults(course, cfg)` → 各洞恢复 7/11/15、转场 2、默认放行比例。

**Live（`live.js`，依赖 Course、Pace）**

- `deriveProgress(booking, events, holes)` → `{ holeIdx, holeNo, phase, teeOffActual, currentHoleStart, lastLeaveGreen, actuals, … }`。
- `liveOrder(progressList)` → 场上球组 id 的物理顺序（洞序降序、playing 先于 between、含让行规则）。
- `reference(prog, holes, cfg, fieldHoldMin, planSnapshot)` → 以实际开球为锚的每洞参考 `{ start, finish }`。
- `lag(prog, ref, now)` / `openAhead(g, p, now, cfg)` / `effLag(lag, openAhead, cfg)` → 滞后、前方空档、有效滞后。
- `nextAlertState(prev, effLag, now, cfg)` → 黄 / 红状态机一步；`cause(lag, level, cfg)` → `'NONE' | 'OWN' | 'AHEAD'`；`snoozed(alert, now)`；`rank(level)`。
- `holdCount(ordered, i)` / `priority(group)` / `marshalList(evalResult)` → 被堵后组数、巡查优先级、巡查列表（已催促排末）。
- `playThroughGate(g, behind, cfg, now, H)` → 是否建议让行；`acceptPlayThrough(booking, behindId, now, progress)` / `ignorePlayThrough(booking, now)` → 带决定的新 Booking。
- `eta(prog, proj, holes, fPlan, now)` → `{ remainingMin, overMin, etaRoundMin, nextTeeEta }`。
- `buildCtx(state, now, prevAlerts)` → 每 tick 的求值上下文；`evaluate(ctx)` → `{ groups, byId, order, projections, fieldDelayMin, alerts, patches }`。
- `clientSnapshot(evalResult, bookings, holes, me, friendIds, now, { caddies })` → 隐私过滤后的客户端快照；`clientProposalView(proposal, bookings, me, friendIds)` → 客户端并组邀请视图。

**Merge（`merge.js`，依赖 Course、Pace）**

- `isMemberGroup(b)`、`utilization(bookings, cfg, fromMin, toMin)`、`peakActive(sheet, bookings, cfg, waitlistLen)` → 会员组 / 利用率 / 是否旺季。
- `isMergeable(b, cfg)`、`isCandidatePair(a, b, cfg, plansById)`、`friendsBetween(a, b, friendsOf)`、`scorePair(a, b, cfg, plansById, friendsOf)`、`keepSide(a, b)` → 候选判定、打分与保留方。
- `candidatePairs(ctx)`、`baselineFor(ctx)`、`mergedGroup(ctx, a, b, keep)`、`checkPair(ctx, a, b, keep, baseline)` → 候选对、今日基线投影、合并后的组、可行性复核。
- `proposalId(a, b)`、`expiresAtFor(createdAt, targetTeeMin, cfg)` → 提议 id 与过期时间（min(24 小时, 开球前 2 小时)）。
- `suggest(ctx = { sheet, bookings, holes, cfg, plansById, statsById, friendsOf, now, waitlistLen, progressById, order })` → MergeProposal[]。
- `isTerminal(p)`、`isExpired(p, now)`、`transition(p, action, side, now, note)` → 提议状态机；`apply(bookings, p)` → 应用并组后的新 bookings。

**Sim（`sim.js`，依赖 Course；仅演示模式）**

- `mulberry32(seed)` → 可续接状态的随机数生成器；`normal(rng)` / `lognormal(rng, σ)`。
- `iRecInterval(plan, cfg, intervalOverride)` → 与 `Pace.iRec().interval` 一致的推荐间隔。
- `create({ holes, cfg, bookings, trueFactorById, seed, slowHoleProb, lostBallMin })` → 模拟器状态。
- `step(state, bookings, fromMin, toMin, { fieldHoldMin, plansById })` → `{ state, events }`，纯函数、同种子同结果。
- `serialize(state)` / `deserialize(obj, { holes, cfg })` → 供 Store 持久化 `sim.<date>`。
