# 璀璨宝石对决 Arena (Splendor Duel Arena)

Splendor Duel（璀璨宝石对决，2 人版璀璨宝石）的 TypeScript 对战平台，支持：

- **人机对战** — 浏览器里你和 bot 对打（bot 可选 随机 / 贪心 / LLM）
- **Agent 对战** — bot 对 bot，单步/自动播放观战，或批量跑分
- **LLM Agent** — 通过 `@earendil-works/pi-coding-agent` SDK（即 pi coding agent 的内核）接入大模型下棋
- **中文界面** — WebUI 为中文

规则引擎按官方规则书实现，67 张珠宝卡 + 4 张皇家卡数据逐张核对过官方 Card List PDF。

## 快速开始

```bash
bun install
bun run web          # http://localhost:3000  (PORT=xxx 可改端口)
bun test             # 引擎规则自检 (Web e2e 见下)
```

> Web API 的端到端测试需要一个运行中的服务：先 `PORT=3457 bun run web`，再 `bun test test/web.e2e.test.ts`。

## Agent 一览

| spec | 说明 |
|---|---|
| `random` | 均匀随机走法 |
| `greedy` | 1 层前瞻 + 启发式估值（对随机胜率 ~80%） |
| `ab[@ms]` | αβ 搜索棋手：negamax 迭代加深（深度 1→4）+ greedy 估值， 叶节点即时结算特权/补货的 1 层修正；`@ms` 每步时间上限（缺省 4000）， 如 `ab@10000`。零 API 成本、本地搜索。A/B：`bun scripts/compare.ts 10 --a ab --baseline greedy` |
| `llm[:provider/model][@level]` | 大模型棋手 v1；缺省用 `opencode-go/deepseek-v4.1-flash`（OPENCODE_API_KEY）；`@level` 可选 `off/low/medium/high` 控制思考预算（缺省 medium），如 `llm:anthropic/claude-sonnet-4-5@low` |
| `llm2[:provider/model][@level]` | 大模型棋手 v2（同默认模型/参数），在 v1 之上叠加确定性分析修复实测缺陷：预留评估摘要（黄金=万能/锁卡价值， 按可负担性排序）、行动列表预留按卡去重（金格等价）、送特权拿取内联 ⚠ 标注（3同色/2珍珠）、【对手预留进度】预警（还差几个 token/是否跨胜利线）、规则措辞防误解（黄金是拿入手非支付） |
| `llm3[:provider/model][@level]` | 大模型棋手 v3（同默认模型/参数），把「记忆与算术」从模型搬进代码（源自 gpt-6.1-sol 败局复盘的 6 个败因）：【流水账】跨回合事件、【目标追踪】按卡 id 跟踪并宣布被截+替代候选、【上回合备忘】make_move 附带 memo 参数→下回合原样注入+提及卡存活核对+防守承诺未兑现⚡、【竞速与阻断】双方 0/1/2 回合胜线与对手 outs 计数（outs≥2 不阻断只抢跑）、【对手路线威胁】三线进度+对手推进卡+0成本清单+⚡处置、【我方中期路线】代码锚定 2-4 回合路线（关键卡失守才换）、【经济】特权/黄金/额外回合差、【牌库匹配】未见高分卡按色+折扣溢出预警、【安全阀】【补货/预留建议】检查项化、⚡情境规则触发时注入。A/B：`bun scripts/compare.ts 6 --a llm3 --baseline llm2 --thinking low` |

LLM agent 每回合分两个阶段与模型交互（工具全程注册激活， 阶段约束由各工具内部校验并以中文错误提示， 避免 SDK 层 tool-not-found 裸错误）：

1. **可选行动阶段**（仅当有特权或可补货时出现）：工具 `use_privilege`（特权拿格子， 可多次调用）/ `use_replenish`（主动补货）/ `skip_optional`（跳过）；每次调用在模拟状态上即时结算（`applyOption`）， 工具结果返回新棋盘。
2. **强制行动阶段**：工具 `make_move`， 从按可选行动后棋盘重算的编号合法行动列表中选择。

系统提示词内注入规则摘要 + 战术攻略（提炼自 splendortactics.com 全部 10 篇攻略：354 局胜者买卡数据 / 开局模式 / 防守时机 / Reddit 高手经验等）， 并内置每回合结构化思考清单（威胁 → 对手路线 → 自己计划 → 双目的选择）；每回合局面报告自动扫描【对手威胁】：对手现在就能买的卡、买后是否直接达 20分/10冠/同色10分获胜、是否触发皇家卡。模型每回合末尾留一行"备忘"（当前计划+对手最大威胁），会话内跨回合可见， 充当长期目标。条件参数（百搭卡颜色 / 皇家卡选择 / 偷取颜色 / 拿同色格 / 超10弃置）严格校验： 缺失或非法会返回带可选值清单的错误供模型自纠， 不静默回退默认值； 连续 3 轮未提交合法走法后回退随机。模型凭据复用 pi 的配置（`~/.pi/agent/auth.json` 等）。

## 会话记录与续局 (resume)

- 每局自动写入 `sessions/<时间>-<P1>-vs-<P2>-<rand>.jsonl`：`meta`（seed / 先手 / 双方 spec）+ 逐步事件（双方走法、LLM 思考、被迫补货）+ 终局结果。同 seed + 同事件序列可确定性重放（引擎随机性全部走 mulberry32， 含先手拖桩）。
- WebUI「📁 继续对局」标签：列出历史会话， 重放到末尾后可换 agent（或人机接管）接着下；续局写入新会话文件， 内嵌原局事件前缀， 文件自包含可独立重放。
- 代码入口：`src/recorder.ts`（`GameRecorder` / `readSession` / `replayGame`），CLI 用 `playMatch(..., { record: false })` 关闭记录（测试已关）。

## WebUI

- **人机对战**：直接点击棋盘/卡片操作 —— 点棋盘格拿 token（直线相邻， 选满自动提交）；点金字塔/预留/牌库卡片打开放大详情， 右侧一键买卡或预留（买不起会禁用并提示）；特权、主动补货不再自动弹窗， 需要时从行动条按钮打开；买卡触发的后续选择（百搭叠色/偷取/皇家卡/拿同色/超10弃置）统一弹窗收集后确认；也可在输入框直接用自然语言指挥（如“买金字塔3号”“拿第2行第3列”“买第2行第1张”），由 LLM 解析执行：含糊指令会追问而不是瞎猜；需要补充选择（皇家卡/偷取颜色等）时只需回答该问题，不用重新描述整个指令。
- **Agent 对战**：单步 / 自动播放 / 调速，全程观战。
- **继续对局**：从 `sessions/` 历史会话重放并续局（观战或人机接管），见上节。

## 规则要点（引擎实现范围）

- 5×5 棋盘 25 个 token（5 色宝石各 4、珍珠 2、黄金 3），花掉的 token 进袋，补货时按螺旋回填，对手得 1 特权
- 回合：可选（用特权→补货）+ 强制三选一（拿 1-3 个直线连续非金 token / 拿黄金+预留卡 / 买卡）
- 拿 3 同色或 2 珍珠 → 对手得特权；特权池空时从对手处夺取
- 买卡：折扣抵扣、黄金百搭、支付方案引擎自动计算（规则下唯一）；卡能力（额外回合/拿同色/偷取/特权/百搭叠色）即时结算
- 3/6 皇冠触发皇家卡；回合末 token 超 10 弃置
- 胜利：20 分 / 10 皇冠 / 同色卡 10 分；无路可走且无法补货判和局
- 同 seed 完全可复现（引擎随机性用 mulberry32）

## 目录结构

```text
src/engine/game.ts    # 规则引擎 (状态/合法行动/applyMove/视图)
src/engine/cards.ts   # 卡牌数据 (67+4, 与官方 PDF 核对)
src/agents/           # random / greedy / llm (v1) / llm2 (v2: 预留评估+威胁预警) / llm3 (v3: 跨回合记忆+竞速/经济/牌库评估) agents
scripts/compare.ts    # 被测 agent(llm2|llm3) vs baseline(llm|llm2|greedy) 批量 A/B 对比, --thinking 控制思考预算(low=4K)
src/arena.ts          # 对局/锦标赛循环 (headless, 供测试使用)
src/recorder.ts       # 会话记录 (sessions/*.jsonl) 与确定性重放/resume
src/web/server.ts     # Bun.serve: 静态页 + REST API
public/               # WebUI (原生 HTML/JS/CSS, 中文)
test/                 # bun test: 引擎规则 + Web e2e
```
