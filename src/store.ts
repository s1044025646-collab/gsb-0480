// SQLite 持久化层：流状态、样本、块幂等记录。重启后从同一边界继续。
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  initialState,
  processSample,
  validateAngle,
  validateTimestamp,
  type ProcessedSample,
  type SampleInput,
  type UnwrapState,
} from "./unwrap.js";
import { ApiError } from "./errors.js";

export const MAX_SAMPLES_PER_STREAM = 1_000_000;
export const MAX_SAMPLES_PER_BLOCK = 10_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS streams (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  ended INTEGER NOT NULL DEFAULT 0,
  next_seq INTEGER NOT NULL DEFAULT 1,
  last_t INTEGER,
  in_segment INTEGER NOT NULL DEFAULT 0,
  segment_count INTEGER NOT NULL DEFAULT 0,
  last_angle REAL NOT NULL DEFAULT 0,
  last_unwrapped REAL NOT NULL DEFAULT 0,
  last_valid_t INTEGER NOT NULL DEFAULT 0,
  cycles INTEGER NOT NULL DEFAULT 0,
  pos_corrections INTEGER NOT NULL DEFAULT 0,
  neg_corrections INTEGER NOT NULL DEFAULT 0,
  sample_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS samples (
  stream_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  t INTEGER NOT NULL,
  angle REAL,
  segment_id INTEGER,
  d REAL,
  correction INTEGER,
  cycles INTEGER,
  unwrapped REAL,
  rate REAL,
  PRIMARY KEY (stream_id, idx)
);
CREATE TABLE IF NOT EXISTS blocks (
  stream_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY (stream_id, seq)
);
`;

interface StreamRow {
  id: string;
  ended: number;
  next_seq: number;
  last_t: number | null;
  in_segment: number;
  segment_count: number;
  last_angle: number;
  last_unwrapped: number;
  last_valid_t: number;
  cycles: number;
  pos_corrections: number;
  neg_corrections: number;
  sample_count: number;
}

function rowToState(row: StreamRow): UnwrapState {
  return {
    lastT: row.last_t,
    inSegment: row.in_segment === 1,
    segmentCount: row.segment_count,
    lastAngle: row.last_angle,
    lastUnwrapped: row.last_unwrapped,
    lastValidT: row.last_valid_t,
    cycles: row.cycles,
    posCorrections: row.pos_corrections,
    negCorrections: row.neg_corrections,
    sampleCount: row.sample_count,
  };
}

function hashBlock(seq: number, requestId: string, samples: SampleInput[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ seq, requestId, samples }))
    .digest("hex");
}

function parseSamples(raw: unknown): SampleInput[] {
  if (!Array.isArray(raw)) {
    throw new ApiError("INVALID_BLOCK", "samples 必须是数组");
  }
  if (raw.length > MAX_SAMPLES_PER_BLOCK) {
    throw new ApiError(
      "BUDGET_EXCEEDED",
      `单块样本数超过预算 ${MAX_SAMPLES_PER_BLOCK}，明确停止`
    );
  }
  return raw.map((item, i) => {
    if (typeof item !== "object" || item === null) {
      throw new ApiError("INVALID_SAMPLE", `样本 #${i} 必须是对象 {t, angle}`);
    }
    const { t, angle } = item as Record<string, unknown>;
    if (angle !== null) {
      try {
        validateAngle(angle);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new ApiError(
          msg.startsWith("NON_FINITE") ? "NON_FINITE" : "INVALID_ANGLE",
          `样本 #${i}: ${msg}`
        );
      }
    }
    // 时间戳基础校验（递增性在追加时结合流状态校验）
    if (typeof t !== "number" || !Number.isSafeInteger(t) || t < 0) {
      throw new ApiError("INVALID_TIMESTAMP", `样本 #${i} 时间戳必须是非负安全整数`);
    }
    return { t, angle: angle as number | null };
  });
}

export class StreamStore {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "unwrap.db"));
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  createStream(): { streamId: string } {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO streams (id, created_at) VALUES (?, ?)")
      .run(id, new Date().toISOString());
    return { streamId: id };
  }

  private getStreamRow(id: string): StreamRow {
    const row = this.db.prepare("SELECT * FROM streams WHERE id = ?").get(id) as
      | StreamRow
      | undefined;
    if (!row) throw new ApiError("STREAM_NOT_FOUND", `流不存在: ${id}`, 404);
    return row;
  }

  appendBlock(
    streamId: string,
    seq: unknown,
    requestId: unknown,
    rawSamples: unknown
  ): { seq: number; requestId: string; accepted: number; samples: ProcessedSample[]; replayed: boolean } {
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
      throw new ApiError("INVALID_BLOCK", "seq 必须是 >= 1 的整数");
    }
    if (typeof requestId !== "string" || requestId.length === 0) {
      throw new ApiError("INVALID_BLOCK", "requestId 必须是非空字符串");
    }
    const samples = parseSamples(rawSamples); // 先完整校验，再触碰状态

    const row = this.getStreamRow(streamId);
    const hash = hashBlock(seq, requestId, samples);

    // 幂等重试：同序号同内容返回原结果
    const existing = this.db
      .prepare("SELECT request_id, hash, result_json FROM blocks WHERE stream_id = ? AND seq = ?")
      .get(streamId, seq) as { request_id: string; hash: string; result_json: string } | undefined;
    if (existing) {
      if (existing.hash === hash && existing.request_id === requestId) {
        return { ...(JSON.parse(existing.result_json) as object), replayed: true } as never;
      }
      throw new ApiError(
        "SEQ_REPLAY_CONFLICT",
        `块序号 ${seq} 已存在但内容不同，拒绝覆盖`,
        409
      );
    }
    if (seq !== row.next_seq) {
      throw new ApiError(
        "SEQ_MISMATCH",
        `期望块序号 ${row.next_seq}，收到 ${seq}（跳过序号或乱序被拒绝）`,
        409
      );
    }
    if (row.ended === 1) {
      throw new ApiError("STREAM_ENDED", "流已结束，只读，拒绝追加", 409);
    }
    if (row.sample_count + samples.length > MAX_SAMPLES_PER_STREAM) {
      throw new ApiError(
        "BUDGET_EXCEEDED",
        `流样本总数将超过预算 ${MAX_SAMPLES_PER_STREAM}，明确停止而不伪造完整序列`
      );
    }

    // 在内存中先完整处理整块（校验失败则状态不被保存，实现原子回滚）
    const state = rowToState(row);
    const processed: ProcessedSample[] = [];
    try {
      for (const s of samples) {
        validateTimestamp(s.t, state.lastT);
        processed.push(processSample(state, s));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = msg.split(":")[0];
      throw new ApiError(
        (["INVALID_ANGLE", "INVALID_TIMESTAMP", "NON_FINITE"].includes(code)
          ? code
          : "INVALID_SAMPLE") as never,
        `块被拒绝且未推进任何状态: ${msg}`
      );
    }

    const result = {
      seq,
      requestId,
      accepted: processed.length,
      samples: processed,
      replayed: false,
    };

    // 原子保存：样本 + 尾状态 + 块记录
    this.db.exec("BEGIN");
    try {
      const ins = this.db.prepare(
        `INSERT INTO samples (stream_id, idx, t, angle, segment_id, d, correction, cycles, unwrapped, rate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const p of processed) {
        ins.run(
          streamId, p.index, p.t, p.angle, p.segmentId, p.d, p.correction, p.cycles,
          p.unwrapped, p.rate
        );
      }
      this.db
        .prepare(
          `UPDATE streams SET next_seq = ?, last_t = ?, in_segment = ?, segment_count = ?,
             last_angle = ?, last_unwrapped = ?, last_valid_t = ?, cycles = ?,
             pos_corrections = ?, neg_corrections = ?, sample_count = ?
           WHERE id = ?`
        )
        .run(
          seq + 1, state.lastT, state.inSegment ? 1 : 0, state.segmentCount,
          state.lastAngle, state.lastUnwrapped, state.lastValidT, state.cycles,
          state.posCorrections, state.negCorrections, state.sampleCount, streamId
        );
      this.db
        .prepare("INSERT INTO blocks (stream_id, seq, request_id, hash, result_json) VALUES (?, ?, ?, ?, ?)")
        .run(streamId, seq, requestId, hash, JSON.stringify(result));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return result;
  }

  finish(streamId: string): { streamId: string; ended: boolean } {
    this.getStreamRow(streamId);
    this.db.prepare("UPDATE streams SET ended = 1 WHERE id = ?").run(streamId);
    return { streamId, ended: true };
  }

  querySamples(
    streamId: string,
    from?: number,
    to?: number
  ): ProcessedSample[] {
    this.getStreamRow(streamId);
    let sql = "SELECT * FROM samples WHERE stream_id = ?";
    const params: (string | number)[] = [streamId];
    if (from !== undefined) {
      sql += " AND t >= ?";
      params.push(from);
    }
    if (to !== undefined) {
      sql += " AND t <= ?";
      params.push(to);
    }
    sql += " ORDER BY idx";
    const rows = this.db.prepare(sql).all(...params) as unknown as Array<Record<string, number | null>>;
    return rows.map((r) => ({
      index: r.idx as number,
      t: r.t as number,
      angle: r.angle,
      segmentId: r.segment_id,
      d: r.d,
      correction: r.correction,
      cycles: r.cycles,
      unwrapped: r.unwrapped,
      rate: r.rate,
    }));
  }

  // 修正来源：所有采用了非零整周修正的点
  corrections(streamId: string): ProcessedSample[] {
    this.getStreamRow(streamId);
    const rows = this.db
      .prepare("SELECT * FROM samples WHERE stream_id = ? AND correction IS NOT NULL AND correction != 0 ORDER BY idx")
      .all(streamId) as unknown as Array<Record<string, number | null>>;
    return rows.map((r) => ({
      index: r.idx as number,
      t: r.t as number,
      angle: r.angle,
      segmentId: r.segment_id,
      d: r.d,
      correction: r.correction,
      cycles: r.cycles,
      unwrapped: r.unwrapped,
      rate: r.rate,
    }));
  }

  report(streamId: string): Record<string, unknown> {
    const row = this.getStreamRow(streamId);
    const segRows = this.db
      .prepare(
        `SELECT segment_id,
                COUNT(*) AS sample_count,
                MIN(t) AS start_t, MAX(t) AS end_t,
                SUM(CASE WHEN correction > 0 THEN 1 ELSE 0 END) AS pos_corr,
                SUM(CASE WHEN correction < 0 THEN 1 ELSE 0 END) AS neg_corr
         FROM samples WHERE stream_id = ? AND segment_id IS NOT NULL
         GROUP BY segment_id ORDER BY segment_id`
      )
      .all(streamId) as unknown as Array<Record<string, number>>;
    const segments = segRows.map((s) => {
      const first = this.db
        .prepare("SELECT t, unwrapped FROM samples WHERE stream_id = ? AND segment_id = ? ORDER BY idx ASC LIMIT 1")
        .get(streamId, s.segment_id) as { t: number; unwrapped: number };
      const last = this.db
        .prepare("SELECT t, unwrapped FROM samples WHERE stream_id = ? AND segment_id = ? ORDER BY idx DESC LIMIT 1")
        .get(streamId, s.segment_id) as { t: number; unwrapped: number };
      return {
        segmentId: s.segment_id,
        sampleCount: s.sample_count,
        startT: s.start_t,
        endT: s.end_t,
        firstUnwrapped: first.unwrapped,
        lastUnwrapped: last.unwrapped,
        endStartDiff: last.unwrapped - first.unwrapped, // 仅段内首尾差，不跨段累加
        posCorrections: s.pos_corr,
        negCorrections: s.neg_corr,
      };
    });
    return {
      streamId,
      ended: row.ended === 1,
      totalSamples: row.sample_count,
      totalSegments: row.segment_count,
      posCorrections: row.pos_corrections,
      negCorrections: row.neg_corrections,
      segments,
      note: "各段首尾差仅段内有意义；跨段差不构成整体旋转量。采样间真实变化超过半周时无法恢复唯一物理相位。",
    };
  }
}
