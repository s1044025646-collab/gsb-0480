import { DatabaseSync } from "node:sqlite";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ApiError, BlockOutcome, PointResult, SampleInput, SegmentSummary, StreamState,
  initialState, processBlock, validateSample, MAX_SAMPLES_PER_BLOCK,
} from "./unwrap";

export interface StreamRow extends StreamState {
  id: string;
  createdAt: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS streams (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        finalized INTEGER NOT NULL DEFAULT 0,
        next_seq INTEGER NOT NULL DEFAULT 1,
        last_t INTEGER,
        last_valid_t INTEGER,
        segment_id INTEGER NOT NULL DEFAULT 0,
        last_angle REAL,
        last_unwrapped REAL,
        cycles INTEGER NOT NULL DEFAULT 0,
        pos_corrections INTEGER NOT NULL DEFAULT 0,
        neg_corrections INTEGER NOT NULL DEFAULT 0,
        sample_count INTEGER NOT NULL DEFAULT 0,
        valid_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS blocks (
        stream_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        request_id TEXT NOT NULL,
        hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (stream_id, seq)
      );
      CREATE TABLE IF NOT EXISTS points (
        stream_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        t INTEGER NOT NULL,
        angle REAL,
        segment_id INTEGER,
        raw_delta REAL,
        cycle_correction INTEGER,
        cycles INTEGER,
        unwrapped REAL,
        rate REAL,
        PRIMARY KEY (stream_id, idx)
      );
    `);
  }

  close(): void { this.db.close(); }

  private rowToState(id: string, r: Record<string, unknown>): StreamRow {
    return {
      id,
      createdAt: r.created_at as string,
      finalized: (r.finalized as number) === 1,
      nextSeq: r.next_seq as number,
      lastT: r.last_t as number | null,
      lastValidT: r.last_valid_t as number | null,
      segmentId: r.segment_id as number,
      lastAngle: r.last_angle as number | null,
      lastUnwrapped: r.last_unwrapped as number | null,
      cycles: r.cycles as number,
      posCorrections: r.pos_corrections as number,
      negCorrections: r.neg_corrections as number,
      sampleCount: r.sample_count as number,
      validCount: r.valid_count as number,
    };
  }

  getStream(id: string): StreamRow {
    const r = this.db.prepare("SELECT * FROM streams WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!r) throw new ApiError("STREAM_NOT_FOUND", `流不存在: ${id}`, 404);
    return this.rowToState(id, r);
  }

  createStream(): StreamRow {
    const id = crypto.randomUUID();
    this.db.prepare("INSERT INTO streams (id, created_at) VALUES (?, ?)").run(id, new Date().toISOString());
    return this.getStream(id);
  }

  private hashSamples(samples: SampleInput[]): string {
    return crypto.createHash("sha256").update(JSON.stringify(samples)).digest("hex");
  }

  appendBlock(streamId: string, seq: unknown, requestId: unknown, rawSamples: unknown): { points: PointResult[]; replayed: boolean } {
    if (!Number.isSafeInteger(seq) || (seq as number) < 1) {
      throw new ApiError("INVALID_SEQ", "seq 必须是 >=1 的整数");
    }
    if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 200) {
      throw new ApiError("INVALID_REQUEST_ID", "requestId 必须是非空字符串(<=200)");
    }
    if (!Array.isArray(rawSamples) || rawSamples.length === 0) {
      throw new ApiError("INVALID_SAMPLES", "samples 必须是非空数组");
    }
    if (rawSamples.length > MAX_SAMPLES_PER_BLOCK) {
      throw new ApiError("BUDGET_EXCEEDED", `单块样本数超过上限 ${MAX_SAMPLES_PER_BLOCK}`, 413);
    }
    const state = this.getStream(streamId);
    if (state.finalized) throw new ApiError("STREAM_FINALIZED", "流已结束，拒绝追加", 409);
    const s = seq as number;
    if (s < state.nextSeq) {
      const existing = this.db.prepare("SELECT request_id, hash, result_json FROM blocks WHERE stream_id = ? AND seq = ?")
        .get(streamId, s) as { request_id: string; hash: string; result_json: string } | undefined;
      if (!existing) throw new ApiError("SEQ_CONFLICT", `序号 ${s} 已被跳过或不存在`, 409);
      const hash = this.hashSamples(this.validateAll(rawSamples, null));
      if (existing.request_id === requestId && existing.hash === hash) {
        return { points: JSON.parse(existing.result_json) as PointResult[], replayed: true };
      }
      throw new ApiError("SEQ_CONFLICT", `序号 ${s} 已使用且内容不一致`, 409);
    }
    if (s > state.nextSeq) {
      throw new ApiError("SEQ_SKIPPED", `期望序号 ${state.nextSeq}，收到 ${s}`, 409);
    }
    const samples = this.validateAll(rawSamples, state.lastT);
    const outcome = processBlock(samples, state);
    const hash = this.hashSamples(samples);
    this.db.exec("BEGIN");
    try {
      const insertPoint = this.db.prepare(
        "INSERT INTO points (stream_id, idx, t, angle, segment_id, raw_delta, cycle_correction, cycles, unwrapped, rate) VALUES (?,?,?,?,?,?,?,?,?,?)");
      for (const p of outcome.points) {
        insertPoint.run(streamId, p.index, p.t, p.angle, p.segmentId, p.rawDelta, p.cycleCorrection, p.cycles, p.unwrapped, p.rate);
      }
      const ns = outcome.state;
      this.db.prepare(`UPDATE streams SET next_seq=?, last_t=?, last_valid_t=?, segment_id=?, last_angle=?,
        last_unwrapped=?, cycles=?, pos_corrections=?, neg_corrections=?, sample_count=?, valid_count=? WHERE id=?`)
        .run(s + 1, ns.lastT, ns.lastValidT, ns.segmentId, ns.lastAngle, ns.lastUnwrapped, ns.cycles,
          ns.posCorrections, ns.negCorrections, ns.sampleCount, ns.validCount, streamId);
      this.db.prepare("INSERT INTO blocks (stream_id, seq, request_id, hash, result_json) VALUES (?,?,?,?,?)")
        .run(streamId, s, requestId as string, hash, JSON.stringify(outcome.points));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { points: outcome.points, replayed: false };
  }

  private validateAll(rawSamples: unknown[], prevT: number | null): SampleInput[] {
    const out: SampleInput[] = [];
    let last = prevT;
    for (let i = 0; i < rawSamples.length; i++) {
      const s = validateSample(rawSamples[i], i, last);
      last = s.t;
      out.push(s);
    }
    return out;
  }

  finalize(streamId: string): StreamRow {
    const st = this.getStream(streamId);
    if (st.finalized) return st;
    this.db.prepare("UPDATE streams SET finalized = 1 WHERE id = ?").run(streamId);
    return this.getStream(streamId);
  }

  queryPoints(streamId: string, from?: number, to?: number): PointResult[] {
    this.getStream(streamId);
    let sql = "SELECT * FROM points WHERE stream_id = ?";
    const params: (string | number)[] = [streamId];
    if (from !== undefined) { sql += " AND t >= ?"; params.push(from); }
    if (to !== undefined) { sql += " AND t <= ?"; params.push(to); }
    sql += " ORDER BY idx";
    const rows = this.db.prepare(sql).all(...params) as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      index: r.idx as number, t: r.t as number, angle: r.angle as number | null,
      segmentId: r.segment_id as number | null, rawDelta: r.raw_delta as number | null,
      cycleCorrection: r.cycle_correction as number | null, cycles: r.cycles as number | null,
      unwrapped: r.unwrapped as number | null, rate: r.rate as number | null,
    }));
  }

  queryCorrections(streamId: string): PointResult[] {
    this.getStream(streamId);
    const rows = this.db.prepare(
      "SELECT * FROM points WHERE stream_id = ? AND cycle_correction IS NOT NULL AND cycle_correction != 0 ORDER BY idx"
    ).all(streamId) as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      index: r.idx as number, t: r.t as number, angle: r.angle as number | null,
      segmentId: r.segment_id as number | null, rawDelta: r.raw_delta as number | null,
      cycleCorrection: r.cycle_correction as number | null, cycles: r.cycles as number | null,
      unwrapped: r.unwrapped as number | null, rate: r.rate as number | null,
    }));
  }

  report(streamId: string): Record<string, unknown> {
    const st = this.getStream(streamId);
    const segRows = this.db.prepare(`
      SELECT segment_id, MIN(idx) AS start_idx, MAX(idx) AS end_idx, MIN(t) AS start_t, MAX(t) AS end_t, COUNT(*) AS cnt
      FROM points WHERE stream_id = ? AND segment_id IS NOT NULL GROUP BY segment_id ORDER BY segment_id`
    ).all(streamId) as unknown as Record<string, unknown>[];
    const segments: SegmentSummary[] = segRows.map((r) => {
      const first = this.db.prepare("SELECT unwrapped FROM points WHERE stream_id=? AND idx=?").get(streamId, r.start_idx as number) as { unwrapped: number };
      const last = this.db.prepare("SELECT unwrapped FROM points WHERE stream_id=? AND idx=?").get(streamId, r.end_idx as number) as { unwrapped: number };
      return {
        segmentId: r.segment_id as number,
        startIndex: r.start_idx as number,
        endIndex: r.end_idx as number,
        startT: r.start_t as number,
        endT: r.end_t as number,
        startUnwrapped: first.unwrapped,
        endUnwrapped: last.unwrapped,
        span: last.unwrapped - first.unwrapped,
        pointCount: r.cnt as number,
      };
    });
    return {
      streamId: st.id,
      finalized: st.finalized,
      sampleCount: st.sampleCount,
      validCount: st.validCount,
      missingCount: st.sampleCount - st.validCount,
      segmentCount: st.segmentId,
      positiveCorrections: st.posCorrections,
      negativeCorrections: st.negCorrections,
      segments,
    };
  }
}
