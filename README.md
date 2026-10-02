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
| `llm[:provider/model]` | 大模型棋手；缺省用 `opencode-go/deepseek-v4.1-flash`（OPENCODE_API_KEY），可显式指定其他模型 |

LLM agent 每回合分两个阶段与模型交互（工具全程注册激活， 阶段约束由各工具内部校验并以中文错误提示， 避免 SDK 层 tool-not-found 裸错误）：

1. **可选行动阶段**（仅当有特权或可补货时出现）：工具 `use_privilege`（特权拿格子， 可多次调用）/ `use_replenish`（主动补货）/ `skip_optional`（跳过）；每次调用在模拟状态上即时结算（`applyOption`）， 工具结果返回新棋盘。
2. **强制行动阶段**：工具 `make_move`， 从按可选行动后棋盘重算的编号合法行动列表中选择。

系统提示词内注入规则摘要 + 战术攻略（源自 splendortactics.com：关键数字 / 5秒对手扫描习惯 / 引擎优先级等）。条件参数（百搭卡颜色 / 皇家卡选择 / 偷取颜色 / 拿同色格 / 超10弃置）严格校验： 缺失或非法会返回带可选值清单的错误供模型自纠， 不静默回退默认值； 连续 3 轮未提交合法走法后回退随机。模型凭据复用 pi 的配置（`~/.pi/agent/auth.json` 等）。

## WebUI

- **人机对战**：点选行动列表；特权拿取/拿同色等场景可点击棋盘格；购买百搭卡、皇冠领皇家卡、偷取、超 10 弃置、额外回合补货都会弹出对应选择；也可在输入框直接用自然语言指挥（如“买金字塔3号”“拿第2行第3列”“买第2行第1张”），由 LLM 解析执行：含糊指令会追问而不是瞎猜；需要补充选择（皇家卡/偷取颜色等）时只需回答该问题，不用重新描述整个指令。
- **Agent 对战**：单步 / 自动播放 / 调速，全程观战。

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
src/agents/           # random / greedy / llm agents
src/arena.ts          # 对局/锦标赛循环 (headless, 供测试使用)
src/web/server.ts     # Bun.serve: 静态页 + REST API
public/               # WebUI (原生 HTML/JS/CSS, 中文)
test/                 # bun test: 引擎规则 + Web e2e
```
