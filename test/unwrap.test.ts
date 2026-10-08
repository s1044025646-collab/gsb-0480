import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StreamStore } from "../src/store.js";
import type { ProcessedSample, SampleInput } from "../src/unwrap.js";

function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "unwrap-test-"));
}

// 独立检查器：每个有效展开值与原值相差整数周；同段相邻展开差绝对值 <= 180
function independentCheck(samples: ProcessedSample[]): void {
  const bySegment = new Map<number, ProcessedSample[]>();
  for (const s of samples) {
    if (s.angle === null) {
      assert.equal(s.unwrapped, null);
      assert.equal(s.rate, null);
      continue;
    }
    const diff = (s.unwrapped as number) - s.angle;
    assert.ok(Number.isInteger(diff / 360), `展开值与原值差必须是整数周: ${diff}`);
    if (!bySegment.has(s.segmentId as number)) bySegment.set(s.segmentId as number, []);
    bySegment.get(s.segmentId as number)!.push(s);
  }
  for (const seg of bySegment.values()) {
    for (let i = 1; i < seg.length; i++) {
      const delta = (seg[i].unwrapped as number) - (seg[i - 1].unwrapped as number);
      assert.ok(Math.abs(delta) <= 180, `同段相邻展开差 |${delta}| 超过 180`);
    }
  }
}

test("演示序列 [170,-170,-160,170,null,-170,170]", () => {
  const dir = tmpDir();
  const store = new StreamStore(dir);
  const { streamId } = store.createStream();
  const angles = [170, -170, -160, 170, null, -170, 170];
  const r = store.appendBlock(
    streamId, 1, "req-1",
    angles.map((a, i) => ({ t: i * 1000, angle: a }))
  );
  assert.deepEqual(
    r.samples.map((s) => s.unwrapped),
    [170, 190, 200, 170, null, -170, -190]
  );
  assert.deepEqual(
    r.samples.map((s) => s.segmentId),
    [1, 1, 1, 1, null, 2, 2]
  );
  independentCheck(r.samples);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("精确半周 [0,-180,0] 保持原差不修正", () => {
  const dir = tmpDir();
  const store = new StreamStore(dir);
  const { streamId } = store.createStream();
  const r = store.appendBlock(streamId, 1, "r1", [
    { t: 0, angle: 0 },
    { t: 1000, angle: -180 },
    { t: 2000, angle: 0 },
  ]);
  assert.deepEqual(r.samples.map((s) => s.d), [null, -180, 180]);
  assert.deepEqual(r.samples.map((s) => s.correction), [0, 0, 0]);
  assert.deepEqual(r.samples.map((s) => s.unwrapped), [0, -180, 0]);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("多圈递增与连续缺测", () => {
  const dir = tmpDir();
  const store = new StreamStore(dir);
  const { streamId } = store.createStream();
  // 每步 +170 度，跨越多圈；中间连续两个 null
  const angles = [0, 170, -20, 150, -40, null, null, 10, -179];
  const samples: SampleInput[] = angles.map((a, i) => ({ t: i * 500, angle: a }));
  const r = store.appendBlock(streamId, 1, "r1", samples);
  assert.deepEqual(
    r.samples.map((s) => s.unwrapped),
    [0, 170, 340, 510, 680, null, null, 10, 181]
  );
  assert.deepEqual(
    r.samples.map((s) => s.segmentId),
    [1, 1, 1, 1, 1, null, null, 2, 2]
  );
  assert.equal(r.samples[4].cycles, 2);
  independentCheck(r.samples);
  const report = store.report(streamId) as { totalSegments: number; posCorrections: number };
  assert.equal(report.totalSegments, 2);
  assert.equal(report.posCorrections, 3);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("逐点追加、一次整块、跨重启切块结果一致", () => {
  const angles = [170, -170, -160, 170, null, -170, 170, 0, -180, 0];
  const mk = (i: number) => ({ t: i * 1000, angle: angles[i] });

  // 一次整块
  const dirA = tmpDir();
  const storeA = new StreamStore(dirA);
  const idA = storeA.createStream().streamId;
  storeA.appendBlock(idA, 1, "a1", angles.map((_, i) => mk(i)));
  const whole = storeA.querySamples(idA);
  storeA.close();

  // 逐点追加
  const dirB = tmpDir();
  const storeB = new StreamStore(dirB);
  const idB = storeB.createStream().streamId;
  angles.forEach((_, i) => storeB.appendBlock(idB, i + 1, `b${i}`, [mk(i)]));
  const pointwise = storeB.querySamples(idB);
  storeB.close();

  // 跨重启切块：3 + 重启 + 3 + 重启 + 4
  const dirC = tmpDir();
  let storeC = new StreamStore(dirC);
  const idC = storeC.createStream().streamId;
  storeC.appendBlock(idC, 1, "c1", [mk(0), mk(1), mk(2)]);
  storeC.close();
  storeC = new StreamStore(dirC);
  storeC.appendBlock(idC, 2, "c2", [mk(3), mk(4), mk(5)]);
  storeC.close();
  storeC = new StreamStore(dirC);
  storeC.appendBlock(idC, 3, "c3", [mk(6), mk(7), mk(8), mk(9)]);
  const restarted = storeC.querySamples(idC);
  storeC.close();

  const strip = (ss: ProcessedSample[]) =>
    ss.map((s) => [s.t, s.angle, s.segmentId, s.d, s.correction, s.cycles, s.unwrapped, s.rate]);
  assert.deepEqual(strip(pointwise), strip(whole));
  assert.deepEqual(strip(restarted), strip(whole));
  independentCheck(whole);
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
  rmSync(dirC, { recursive: true, force: true });
});

test("拒绝重复/非递增时间与非法角度", () => {
  const dir = tmpDir();
  const store = new StreamStore(dir);
  const { streamId } = store.createStream();
  store.appendBlock(streamId, 1, "r1", [{ t: 1000, angle: 10 }]);
  assert.throws(
    () => store.appendBlock(streamId, 2, "r2", [{ t: 1000, angle: 20 }]),
    /严格递增/
  );
  for (const bad of [180, 360, -180.5, 1e9, NaN, Infinity]) {
    assert.throws(
      () => store.appendBlock(streamId, 2, "r2", [{ t: 2000, angle: bad }]),
      (e: Error) => /INVALID_ANGLE|NON_FINITE/.test(e.message)
    );
  }
  // 坏块回滚：前半块合法后半块非法，状态不得推进
  assert.throws(() =>
    store.appendBlock(streamId, 2, "r2", [
      { t: 2000, angle: 50 },
      { t: 3000, angle: 180 },
    ])
  );
  const ok = store.appendBlock(streamId, 2, "r2", [{ t: 2000, angle: 50 }]);
  assert.equal(ok.samples[0].index, 1); // 前一块未推进，索引连续
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("块重试幂等、改内容拒绝、跳序号拒绝", () => {
  const dir = tmpDir();
  const store = new StreamStore(dir);
  const { streamId } = store.createStream();
  const block = [{ t: 0, angle: 10 }];
  const first = store.appendBlock(streamId, 1, "req-x", block);
  const retry = store.appendBlock(streamId, 1, "req-x", block);
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.samples, first.samples);
  assert.throws(
    () => store.appendBlock(streamId, 1, "req-x", [{ t: 0, angle: 11 }]),
    /SEQ_REPLAY_CONFLICT|内容不同/
  );
  assert.throws(
    () => store.appendBlock(streamId, 3, "req-y", block),
    /SEQ_MISMATCH|期望块序号/
  );
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("结束后拒绝追加，查询与报告仍可读", () => {
  const dir = tmpDir();
  const store = new StreamStore(dir);
  const { streamId } = store.createStream();
  store.appendBlock(streamId, 1, "r1", [{ t: 0, angle: 5 }]);
  store.finish(streamId);
  assert.throws(
    () => store.appendBlock(streamId, 2, "r2", [{ t: 1, angle: 6 }]),
    /STREAM_ENDED|已结束/
  );
  assert.equal(store.querySamples(streamId).length, 1);
  const report = store.report(streamId) as { ended: boolean };
  assert.equal(report.ended, true);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("全缺测输入合法且无有效段", () => {
  const dir = tmpDir();
  const store = new StreamStore(dir);
  const { streamId } = store.createStream();
  const r = store.appendBlock(streamId, 1, "r1", [
    { t: 0, angle: null },
    { t: 1, angle: null },
  ]);
  assert.equal(r.samples.length, 2);
  const report = store.report(streamId) as { totalSegments: number };
  assert.equal(report.totalSegments, 0);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("变化率：段首为 null，同段相邻为度/秒", () => {
  const dir = tmpDir();
  const store = new StreamStore(dir);
  const { streamId } = store.createStream();
  const r = store.appendBlock(streamId, 1, "r1", [
    { t: 0, angle: 170 },
    { t: 1000, angle: -170 }, // 展开 190，速率 20 度/秒
    { t: 3000, angle: -160 }, // 展开 200，速率 5 度/秒
  ]);
  assert.equal(r.samples[0].rate, null);
  assert.ok(Math.abs((r.samples[1].rate as number) - 20) < 1e-9);
  assert.ok(Math.abs((r.samples[2].rate as number) - 5) < 1e-9);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
