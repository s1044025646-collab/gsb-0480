# 角度相位连续展开与缺测分段恢复后端

离线一维相位序列展开服务。输入按时间排列、限制在 [-180,180) 度的包裹相位，输出跨越 ±180° 边界修正后的连续展开角，并记录每次整周修正。只处理明确给出的角度：不读音频、不做 FFT、不估计载波或真实运动、不做二维图像相位解缠。

技术栈：TypeScript + Node.js（>= 22，推荐 24+）+ SQLite（Node 内置 node:sqlite，无原生编译依赖）。仅 API 与 CLI，Windows 本地运行，不依赖 Docker / WSL / 付费服务 / 在线 API。

## 快速开始

    npm install        # 安装开发依赖（typescript / tsx / @types/node）
    npm run build      # 编译到 dist/
    npm test           # 运行全部测试
    npm run demo       # 内置演示：[170,-170,-160,170,null,-170,170] -> [170,190,200,170,null,-170,-190]
    npm start          # 启动 HTTP 服务（默认自动选择空闲端口，PORT=3000 可指定）

数据保存在项目内 data/unwrap.db（可用环境变量 UNWRAP_DATA_DIR 修改）。

## 展开规则

- 核心状态：当前连续段的上一包裹角与累计整周数 k。
- 原差 d = 当前包裹角 - 上一包裹角（用包裹角而非上一展开角，避免多圈后重复修正）。
- d > 180 时 k 减 1；d < -180 时 k 加 1；否则不变。展开角 = 当前包裹角 + 360·k。
- 精确 d = ±180：两个方向同样短，保持原差符号、不修正。
- 段首样本 k=0，展开角等于原值，无变化率（不输出 0 暗示静止）。
- null 缺测直接中断连续段；下一有效样本新建段并重置上一角与整周数，不跨缺测拼接；连续多个 null 只算一段缺口；全缺测输入合法（无有效段）。
- 变化率 = 同段相邻展开角差 / 秒为单位时间差；跨段不计算。
- 报告含总段数、正/反向修正次数、各段首尾差；跨段差不累加成整体旋转量。
- 预算：单流 ≤ 1,000,000 样本、单块 ≤ 10,000 样本；超限或数值非有限时明确报错停止，不伪造完整序列。

## HTTP API

- POST   /streams                      新建流，返回 {streamId}
- POST   /streams/:id/blocks           追加块 {seq, requestId, samples:[{t,angle}]}
- POST   /streams/:id/finish           结束输入，之后只读
- GET    /streams/:id/samples?from=&to=  按时间区间查询全部样本（含缺测）
- GET    /streams/:id/corrections      查询所有非零整周修正点（修正来源）
- GET    /streams/:id/report           导出报告

每个有效点返回：segmentId、d（原差）、correction（本点修正 -1/0/+1）、cycles（累计整周数）、unwrapped（展开角）、rate（度/秒，段首为 null）。缺测点以上字段均为 null，原始样本与顺序完整保留。

### 块幂等与原子性

- seq 必须从 1 起严格递增；跳过或乱序返回 SEQ_MISMATCH。
- 同一 seq + 同一 requestId + 同一内容重试：返回首次保存的原结果（replayed: true）。
- 同一 seq 内容不同：返回 SEQ_REPLAY_CONFLICT（409）。
- 每块先完整校验再在单事务中原子写入样本与尾状态；块中任一非法值导致整块拒绝，前半块不推进。
- SQLite 持久化上一时间、段状态、包裹角与整周数，重启后从同一边界继续；块边界不产生新段。

### 错误码

INVALID_ANGLE（角度越界/180/360，不自动取模）、INVALID_TIMESTAMP（非非负安全整数或不严格递增）、NON_FINITE、INVALID_SAMPLE、INVALID_BLOCK、SEQ_MISMATCH、SEQ_REPLAY_CONFLICT、STREAM_NOT_FOUND、STREAM_ENDED、BUDGET_EXCEEDED、BAD_REQUEST。响应形如 {"error":{"code":"...","message":"..."}}。

## CLI

    npm run cli -- serve --port=3000
    npm run cli -- create
    npm run cli -- append <streamId> 1 req-1 "[170,-170,null,170]"
    npm run cli -- finish <streamId>
    npm run cli -- samples <streamId> 0 5000
    npm run cli -- corrections <streamId>
    npm run cli -- report <streamId>
    npm run cli -- demo

简写数组自动分配时间戳（0 起每 1000ms 一条）；对象数组 [{"t":0,"angle":170}] 可显式给 t（毫秒，可不均匀）。

## 测试

npm test 覆盖：演示序列、精确半周 [0,-180,0]、多圈递增、连续缺测、逐点追加 / 一次整块 / 跨重启切块三种方式结果一致、重复时间、块重试幂等、坏块回滚、结束后拒绝追加、全缺测、变化率。测试中包含独立检查器：验证每个有效展开值与原值相差整数周、同段相邻展开差绝对值 ≤ 180。

## 限制与假设

- 采样间真实变化超过半周（180°）时无法恢复唯一物理相位：展开结果只是满足“相邻差 ≤ 半周”约束的一种连续化，连续结果不等于真实运动已被证明。
- 不根据时间间隔推测额外转过的整周数，不插值补回缺失相位。
- 角度单位为度，时间单位为毫秒；间隔可不均匀。
- 精确半周（|d|=180）不修正，两个方向同样短，实现不擅自选择。
- node:sqlite 在部分 Node 版本仍打印 ExperimentalWarning，不影响功能。
