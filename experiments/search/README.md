# 搜索算法研究台账: minimax vs αβ vs MCTS vs 混合

目标: 在不修改现有 bot(`src/agents/ab.ts`, `mcts.ts`, `greedy.ts` 等)的前提下,
研究 minimax / alpha-beta / MCTS 三种思路及其组合, 产出最强 agent + 研究报告。

## 协议(沿用 experiments/mcts/README.md, 增补)

1. 每轮: 固定假设 → 唯一变量改动 → 同种子成对交换座次 → 记录原始 JSONL → 结论标记
   (保留/不确定/撤回)。有希望的候选用未参与调整的独立种子复核。
2. 基准: `experiments/search/bench.ts`, 任意两个 agent spec 对拍,
   `--games`(偶数)成对交换座次, 开局 seed = `--seed + floor(i/2)*7919`, 先手座位 0,
   双方 agent 内部随机种子 7, `--max-turns 180` 封顶, `record:false` 不写 sessions。
3. spec 语法:
   - `greedy` / `random` / `ab@ms` / `mcts@ms` / `mcts@p<N>`(固定 playouts, 确定性)
   - `<file.ts:k=v,...>` → 动态 import 该文件的 `makeAgent({name,timeMs,playouts,seed,...k})`,
     候选实现在本目录独立文件, 不改 src/。
4. 非法/异常行动使整轮无效(bench 直接抛错)。和棋不计胜。
5. 墙钟对局受负载影响; 16 核机器上并行 ≤6 个串行对局进程互不争核。
   固定 playouts 的比较不受负载影响, 用于确定性筛选。
6. 吞吐/节点探针: `probe-throughput.ts`(核速度), `probe-depth.ts`(同深度节点数),
   输出 JSON 存档, 只测吞吐不改棋力。

## 环境

- Bun 1.3.10, Linux x86_64, 16 逻辑核(nproc=16)
- 源码未改(候选全在 experiments/search/ 独立文件); `bun test` 73 项通过(研究开始时)

## 候选清单

| 文件 | 思路 | 说明 |
|---|---|---|
| `cand-mm.ts` | 纯 minimax(无剪枝) | 引擎核, 与 ab.ts 同估值/排序, 全宽展开; depth=/timeMs= |
| `cand-absim.ts` | αβ on Sim 快核 | 与 ab.ts 同算法同估值, 状态核换 mcts.ts 导出的 Sim(28× 快); maxDepth 12; noPrune=1 为无剪枝对照 |
| `cand-mcts-eval.ts` | MCTS + 估值回传 | mcts.ts 复制件, 唯一改动: rollout 截断于 rolloutCap 步(缺省 12), 触顶返回 sigmoid(估值) |
| `cand-mcts-prior.ts` | MCTS + αβ 根先验 | mcts.ts 复制件, rollout 走到终局; 唯一改动: 根选择改 PUCT, P 来自 cand-absim 浅搜根值(缺省 d3) |

## 轮次记录

### R0 现状基线矩阵(2026-10-03)

配置: 1000ms/步, 12 局, seed 30000000/30100000/30200000, maxTurns 180。原始: `r0-*.jsonl`。

| 对局 | 比分(A 视角) | 备注 |
|---|---|---|
| ab@1000 vs greedy | 8-4 | ab 平均仅用 504ms/步: MAX_DEPTH=4 封顶, 预算浪费 |
| mcts@1000 vs greedy | 12-0 | 20.5k playouts/步 |
| ab@1000 vs mcts@1000 | (进行中) | |

初步: 当前最强 = mcts; ab 的弱项是深度封顶+慢核, 不是 αβ 思路本身。

### P1 吞吐探针(2026-10-03)

`probe-throughput.ts`, 贪心自博弈采样 4 个中盘局面(turn 16/24/56/64):

- Sim 核 αβ depth3: 4805 节点 / 46ms ≈ **104,457 nodes/s**
- 引擎核 applyMove: 204 步 / 54ms ≈ **3,778 moves/s**(ab.ts 每节点成本近似)
- **核加速 ≈ 28×**(节点当量, 未计估值差)

### P2 同深度节点对比(2026-10-03)

`probe-depth.ts`, 采样 6 局面(turn 18/45/54/63, 分支 62/8/2/50), `probe-depth.json`:

| 局面 | αβ d2 | mm d2 | αβ d3 | mm d3 | d3 着法一致 |
|---|---|---|---|---|---|
| t18(b62) | 346 | 3216 | 3,808 | 112,987 | Y |
| t45(b8) | 23 | 83 | 114 | 608 | Y |
| t54(b2) | 10 | 10 | 89 | 329 | Y |
| t63(b50) | 232 | 2164 | 2,472 | 68,831 | N |

结论: ① αβ 剪枝在 d2 省 ~10×, d3 省 ~30× 节点; ② mmSim 与 mmEngine 节点数几乎相同
(3216 vs 3154) → 两核展开同一棵树, 差异纯粹是速度; ③ 着法 3/4 一致(d3 分歧来自
αβ 对非最优根分支只给上界 + 估值抖动 tie-break, 非正确性差异)。

### R1 αβ on Sim 快核(2026-10-03)

假设: ab.ts 弱在慢核(3.8k nodes/s)+深度 4 封顶; 换 Sim 核(28×)后同墙钟可搜 d5-6,
αβ 应反超或逼近 mcts。原始: `r1-absim-vs-ab.jsonl`, `r1-absim-vs-mcts.jsonl`。

配置: 1000ms/步, 12 局, seed 31000000/31100000。

| 对局 | 比分 | 备注 |
|---|---|---|
| absim@1000 vs ab@1000 | **10-2** | 同算法同预算, 仅核不同 -> 快核六大幅提升 αβ |
| absim@1000 vs mcts@1000 | **1-11** | αβ 搜到 d5-6 仍被 ~20k playouts 的 MCTS 压制 |

结论: αβ 的短板不只是速度 — 估值噪声在深层的票选出被放大, 而 rollout 的自海模拟
天然覆盖长期经济规划。**后续混合方向以 MCTS 为骨架**。

### R2 MCTS + 估值回传(等模拟数)

配置: 双方固定 500 playouts(确定性), 12 局, seed 32000000。
结果: mcts-eval(cap12) vs mcts = **5-7**; 每步耗时 16ms vs 39ms(截断 rollout 快 2.4×)。
结论: 每次模拟的信息量没有提升, 但模拟便宜了 2.4× -> 等时间下可能反超(进入 R3)。

### R4 UCT 探索常数扫描(等模拟数)

配置: 双方固定 500 playouts, 12 局, seed 34000000。唯一变量 uctC(基准 0.7)。

| uctC | vs 0.7 比分 | 结论 |
|---|---|---|
| 0.5 | 6-6 | 中性 |
| 1.0 | 4-8 | 更差 |
| 1.5 | 4-8 | 更差 |

结论: 0.7 已接近最优, 无调参红利。撤回该方向。

### R3 截断 rollout 等时间对拍(2026-10-03)

配置: 1000ms/步, 12 局, seed 33000000, cap ∈ {6,12,24} vs mcts@1000。原始: `r3-*.jsonl`。

| cap | 比分 | playouts/步 |
|---|---|---|
| 6 | **0-12** | 50137 vs 18041 |
| 12 | **0-12** | 41319 vs 22943 |
| 24 | **1-11** | 46104 vs 28350 |

结论: 估值回传即便换来 2-2.5× 模拟数也严重有害。贪心 rollout 走到终局捕获的是真实竞速
动力学; 用 sigmoid(估值) 截断尾部引入系统性偏差。**H1 撤回**。与 experiments/mcts 009
(截断几乎不触发, 无效果)互补: 现在知道主动截断是负向的。

### R5 MCTS + αβ 根先验(2026-10-03)

配置: 1000ms/步, 12 局, seed 35000000, priorDepth=3(约 40ms/步), vs mcts@1000。
结果: **1-11**(34386 vs 22315 playouts/步)。
结论: 真实搜索值先验与 010 的静态先验同样有害 — 先验把探索从 αβ 看不到的高价值分支
引开。**H4 撤回**。至此"向 MCTS 注入 αβ 知识"三条路(叶估值/根先验/静态先验)全部否定。

### R6 MCTS 跨回合子树复用(2026-10-03)

假设: 不改证据语义, 仅把上回合已搜索的子树带到本回合(局面完全一致时), 等效提升
每步有效 playouts。配置: 1000ms/步, 12 局, seed 36000000。原始: `r6-*.jsonl`。

| 批 | 比分 vs mcts@1000 | 新 playouts/步 |
|---|---|---|
| R6 筛选(12 局, seed 36000000) | **8-4** | 28056 vs 45193 |
| 复核 A(24 局, seed 36100000) | **14-10** | 34055 vs 24133 |
| 复核 B(24 局, seed 36200000) | **14-10** | 35632 vs 25769 |

三批均为正向, 合计 36-24(单侧二项检验 p≈0.06, 初步但方向一致)。
复用命中率探针(`probe-reuse.ts`, mcts2@100ms vs greedy): 27/36 与 27/42 回合命中
(64-75%), 机制真实生效。**保留: 成为新基线 mcts2**。

### R7 相位切换混合(2026-10-03)

配置: 1000ms/步, 12 局, seed 37000000, phaseAt=10(根分支 ≤10 时切 αβ)。
结果: **4-8**(abTurns 占比见 `r7-*.jsonl`)。结论: 低分支时切 αβ 仍不如纯 MCTS
(rollout 在残局同样收敛且无相位断裂感), **撤回**。

### R8 最终交付验证(src/agents/mcts2.ts 本体, 2026-10-03)

| 对局 | 比分 | 备注 |
|---|---|---|
| mcts2@1000 vs mcts@1000 (seed 36400000) | 6-6 | 交付文件与候选一致 |
| mcts2@1000 vs ab@1000 (seed 36500000) | **11-1** | 压制 αβ |
| mcts2@1000 vs greedy (seed 36600000) | **12-0** | vs greedy 满贯(与 mcts 相当) |
| mcts2@2000 vs mcts@2000 (seed 36700000) | **8-4** | 更长预算下优势保持 |

mcts2 vs mcts 全部新鲜种子累计 50-34(59.5%, 单侧二项检验 p≈0.04, 事后合并口径)。
测试: `bun test` 78 项通过(新增 test/mcts2.test.ts 5 项: simEq 单元/确定性/复用命中/非法参数)。
交付: `src/agents/mcts2.ts`(新文件); 注册: server `mcts2[@ms]`(worker 化) + compare.ts
`--a mcts2 --baseline mcts`(均为纯增量, 未改任何现有 bot 行为)。

### R9 并行 MCTS(根并行, worker 池 + 根子统计合并)(2026-10-04)

假设: 16 核机器上用 N 个 worker 各自完整运行 mcts2(不同种子, 各自保留子树复用),
父端按根行动合并 ΣN/ΣW 取稳健子, 同墙钟预算下应显著强于单线程 mcts2。

候选: `cand-mcts-par.ts` + `par-worker.ts`(进程级按 n 分池, 每 agent 接管时全体
re-init 防泄漏)。mcts2.ts 仅加纯增量导出(lastRoot 根子统计 + refine 函数导出)。

| 批 | 对拍 | 比分 | playouts/步 | 备注 |
|---|---|---|---|---|
| 首版多数票 | vote vs mcts2@1000 (seed 380/3810万) | 4-8 | 62k vs 16k | 合并方案弃用 |
| 统计合并 s1 | ΣN vs mcts2@1000 (seed 3830万) | 3-9 | 191k vs 48k | 机器有外部负载 |
| DIAG1 | ΣN(w=1) vs mcts2@1000 (seed 3840万) | 4-4 | 35k vs 44k | 管线无罪, w=1≈mcts2 |
| DIAG2b | ΣN(w=8) vs ΣN(w=1) (seed 3860万) | 5-3 | 109k vs 33k | 同管线下并行略强 |
| confirm | ΣN(w=8) vs mcts2@1000 (seed 3870万) | **7-5** | 233k vs 32k | 干净负载 |

合并口径 w8-vs-mcts2 = 10-14(两批), 批间方差大; 结论: **8 worker 根并行 ≈ 打平
mcts2, 3-7× playouts 未兑现成胜率**。机制(与 DIAG 一致): ① 8 棵树同先验同 UCT,
仅 jitter 种子不同, 搜索高度相关 -> 合并 ≈ 等深度单树的信息量(降方差不降偏差);
② 各 worker 仅当自选着法=实际着法才保住子树复用(~1-2/8 命中), R6 的复用红利被
稀释 —— 增益与稀释大致相抵。

原始: `r9-vote-a/b.jsonl`(多数票), `r9-stats-s1.jsonl`(统计合并 s1),
`r9-diag.jsonl`(DIAG1 有效 + DIAG2 无效[共享池串台, 实为 w8-vs-w8]), `r9-diag2b.jsonl`,
`r9-confirm-w8-vs-mcts2.jsonl`。交付(体验用, 非最强): `src/agents/par-mcts2.ts` + 注册。

教训: 多数票合并有害(放大贪心共识); 相关树并行无红利。若要继续该方向:
decorrelate(每 worker 不同 uctC/jitter 组合) 或共享树+虚损(需扁平节点数组, 大改)。
当前倾向: 单树提速(Rust/WASM 移植 Sim 核)更直接 —— 加深同一棵树无相关性损失。
