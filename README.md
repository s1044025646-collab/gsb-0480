# 角度相位连续展开与缺测分段恢复后端

离线一维相位序列展开服务：输入按时间排列、限制在 `[-180, 180)` 度的包裹相位，
将跨越 ±180° 边界的序列展开为连续数值，并记录每次整周修正。
纯后端（HTTP API + CLI），TypeScript + Node.js + SQLite（Node 内置 `node:sqlite`，无原生编译依赖）。
不读取音频、不做 FFT、不估计载波或真实运动、不做二维相位解缠。

## 环境要求

- Windows 本地运行，Node.js >= 22.5（使用内置 `node:sqlite`，开发版本 25 验证通过）
- 不依赖 Docker / WSL / 付费服务 / 外部在线 API

## 命令

```powershell
npm install        # 安装开发依赖(typescript)
npm run build      # 编译 TypeScript 到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 API(默认自动选择空闲端口)
npm start -- --port 8080   # 指定端口(被占用时自动换空闲端口)
npm run demo       # 内置演示(基本示例/恰半周/多圈/连续缺测/逐点追加)
```

数据目录默认为项目内 `data/`（可用环境变量 `DATA_DIR`、`DB_PATH` 覆盖）。

## 展开规则

- 核心状态：当前连续段的上一**包裹角**与累计整周数 `cycles`。
- 原差 `d = 当前包裹角 - 上一包裹角`（不用上一展开角，避免多圈后重复修正）。
- `d > 180` → `cycles -= 1`；`d < -180` → `cycles += 1`；否则不变。
- 展开角 = 当前包裹角 + 360 × cycles。
- 精确 `d = ±180`（恰半周）保持原差符号、不修正：两个方向同样短，不擅自选择。
- 每段首个有效样本 `cycles = 0`，展开角等于原值。
- `null` 中断连续段；下一有效样本开新段并重置状态，不跨缺测续接。
- 变化率 = 展开角差 / 秒级时间差，仅同段相邻有效点给出；段首为 `null`（不输出 0 暗示静止）。
- 不根据时间间隔推测额外转过几周，不插值补缺。

示例：`[170,-170,-160,170,null,-170,170]` → `[170,190,200,170,null,-170,-190]`，段编号 `[1,1,1,1,null,2,2]`。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/streams` | 新建流，返回 `{streamId}` |
| POST | `/streams/:id/blocks` | 追加块 `{seq, requestId, samples:[{t, angle|null}]}` |
| POST | `/streams/:id/finalize` | 结束输入，之后只读 |
| GET | `/streams/:id/points?from=&to=` | 按时间区间查询点 |
| GET | `/streams/:id/corrections` | 查询所有整周修正来源点 |
| GET | `/streams/:id/report` | 导出报告（段数、正/负修正次数、各段首尾差等） |

块语义：

- `seq` 从 1 开始严格递增；同序号同内容（含同 `requestId`）重试返回原结果（`replayed: true`）；
  同序号改内容返回 `SEQ_CONFLICT`，跳序号返回 `SEQ_SKIPPED`。
- 每块先完整校验再原子写入（SQLite 事务）：块中任何非法值都不会让前半块推进。
- 流状态（上一时间、段号、上一包裹角、累计整周数等）持久化在 SQLite，
  重启后从同一边界继续，块边界不产生新段；`finalize` 后追加返回 `STREAM_FINALIZED`。

## CLI

```powershell
node dist/cli.js create
node dist/cli.js append <streamId> <seq> <requestId> <file.json>
node dist/cli.js finalize <streamId>
node dist/cli.js points <streamId> [from to]
node dist/cli.js corrections <streamId>
node dist/cli.js report <streamId>
node dist/cli.js serve [--port N]
node dist/cli.js demo
```

样本文件 JSON 格式：`[{"t": 100, "angle": 170}, {"t": 200, "angle": null}, ...]`

## 错误码

`INVALID_SAMPLE` / `INVALID_TIMESTAMP` / `TIMESTAMP_NOT_INCREASING` / `INVALID_ANGLE` /
`ANGLE_OUT_OF_RANGE`（180、360、越界值明确拒绝，不自动取模）/ `INVALID_SEQ` /
`INVALID_REQUEST_ID` / `INVALID_SAMPLES` / `SEQ_CONFLICT` / `SEQ_SKIPPED` /
`STREAM_FINALIZED` / `STREAM_NOT_FOUND` / `BUDGET_EXCEEDED`（样本数或数值预算达到上限时明确停止）/
`INVALID_JSON` / `NOT_FOUND` / `INTERNAL`。

## 输出字段（每个有效点）

`segmentId`（段编号）、`rawDelta`（原差）、`cycleCorrection`（本次整周修正 -1/0/1）、
`cycles`（累计整周数）、`unwrapped`（展开角）、`rate`（变化率，度/秒，段首与缺测为 null）。

## 测试

`npm test` 覆盖：演示序列、逐点/整块/跨重启切块结果一致、恰半周不修正、多圈递增、
连续缺测与全缺测、重复时间戳、非法角度、坏块回滚、块重试幂等、结束后拒绝追加、
变化率与段首、报告段首尾差；并用独立检查验证每个有效展开值与原值相差整数周、
同段相邻差绝对值不超过 180。

## 限制与假设

- **采样间真实变化超过半周（180°）时无法恢复唯一物理相位**：展开结果只是满足
  “相邻差 ≤ 半周” 约束的最短路径连续化，连续结果不等于真实运动已被证明。
- 不根据时间间隔推测额外整周，不插值补缺测。
- 跨段的差不构成有意义的整体旋转量，报告仅按段给出首尾差。
- 预算：单流最多 1,000,000 样本，单块最多 100,000，展开角绝对值上限 1e15，超限明确报错停止。
- `node:sqlite` 在 Node 25 仍为实验特性（启动时有 ExperimentalWarning，功能正常）。
