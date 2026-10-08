const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { Store } = require("../dist/store");
const { processBlock, initialState } = require("../dist/unwrap");

function tmpDb() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "unwrap-")), "t.db");
}

function throwsCode(fn, code) {
  assert.throws(fn, (err) => err && err.code === code);
}

function feed(store, id, samples, chunkSize) {
  let seq = 1;
  let all = [];
  for (let i = 0; i < samples.length; i += chunkSize) {
    const r = store.appendBlock(id, seq, `req-${seq}`, samples.slice(i, i + chunkSize));
    seq++;
    all = all.concat(r.points);
  }
  return all;
}

function independentCheck(points) {
  for (const p of points) {
    if (p.unwrapped === null) continue;
    const k = (p.unwrapped - p.angle) / 360;
    assert.ok(Math.abs(k - Math.round(k)) < 1e-9, "展开值与原值相差整数周");
  }
  const bySeg = new Map();
  for (const p of points) {
    if (p.segmentId === null) continue;
    if (!bySeg.has(p.segmentId)) bySeg.set(p.segmentId, []);
    bySeg.get(p.segmentId).push(p);
  }
  for (const seg of bySeg.values()) {
    for (let i = 1; i < seg.length; i++) {
      assert.ok(Math.abs(seg[i].unwrapped - seg[i - 1].unwrapped) <= 180 + 1e-9, "同段相邻差 <= 180");
    }
  }
}

const DEMO = [170, -170, -160, 170, null, -170, 170];
const EXPECTED = [170, 190, 200, 170, null, -170, -190];
const EXPECTED_SEGS = [1, 1, 1, 1, null, 2, 2];

function toSamples(angles) {
  return angles.map((angle, i) => ({ t: (i + 1) * 100, angle }));
}

test("演示序列展开正确", () => {
  const store = new Store(tmpDb());
  const st = store.createStream();
  const pts = feed(store, st.id, toSamples(DEMO), 100);
  assert.deepStrictEqual(pts.map((p) => p.unwrapped), EXPECTED);
  assert.deepStrictEqual(pts.map((p) => p.segmentId), EXPECTED_SEGS);
  independentCheck(pts);
  store.close();
});

test("逐点/整块/跨重启结果一致", () => {
  const angles = [0, 100, -160, -60, 40, 140, -120, null, null, 5, -170, 170];
  const samples = toSamples(angles);
  const results = [];
  for (const chunk of [1, 3, 100]) {
    const store = new Store(tmpDb());
    const st = store.createStream();
    results.push(feed(store, st.id, samples, chunk).map((p) => [p.unwrapped, p.segmentId]));
    store.close();
  }
  const dbPath = tmpDb();
  let store = new Store(dbPath);
  const st = store.createStream();
  const half = Math.floor(samples.length / 2);
  const part1 = store.appendBlock(st.id, 1, "r1", samples.slice(0, half)).points;
  store.close();
  store = new Store(dbPath);
  const part2 = store.appendBlock(st.id, 2, "r2", samples.slice(half)).points;
  results.push(part1.concat(part2).map((p) => [p.unwrapped, p.segmentId]));
  store.close();
  for (let i = 1; i < results.length; i++) assert.deepStrictEqual(results[i], results[0]);
  const store2 = new Store(tmpDb());
  const st2 = store2.createStream();
  independentCheck(feed(store2, st2.id, samples, 2));
  store2.close();
});

test("恰半周保持原差不修正", () => {
  const out = processBlock(toSamples([0, -180, 0]), initialState());
  assert.strictEqual(out.points[1].rawDelta, -180);
  assert.strictEqual(out.points[1].cycleCorrection, 0);
  assert.strictEqual(out.points[1].unwrapped, -180);
  assert.strictEqual(out.points[2].rawDelta, 180);
  assert.strictEqual(out.points[2].cycleCorrection, 0);
  assert.strictEqual(out.points[2].unwrapped, 0);
});

test("多圈递增", () => {
  const angles = [0, 100, -160, -60, 40, 140, -120];
  const out = processBlock(toSamples(angles), initialState());
  assert.deepStrictEqual(out.points.map((p) => p.unwrapped), [0, 100, 200, 300, 400, 500, 600]);
  assert.strictEqual(out.state.posCorrections, 2);
});

test("全缺测输入合法", () => {
  const out = processBlock(toSamples([null, null, null]), initialState());
  assert.strictEqual(out.state.segmentId, 0);
  assert.ok(out.points.every((p) => p.unwrapped === null));
});

test("重复时间戳拒绝", () => {
  const store = new Store(tmpDb());
  const st = store.createStream();
  throwsCode(() => store.appendBlock(st.id, 1, "r", [{ t: 100, angle: 0 }, { t: 100, angle: 1 }]), "TIMESTAMP_NOT_INCREASING");
  store.appendBlock(st.id, 1, "r", [{ t: 100, angle: 0 }]);
  throwsCode(() => store.appendBlock(st.id, 2, "r2", [{ t: 50, angle: 0 }]), "TIMESTAMP_NOT_INCREASING");
  store.close();
});

test("非法角度拒绝", () => {
  const store = new Store(tmpDb());
  const st = store.createStream();
  for (const bad of [180, 360, -180.5, NaN, Infinity]) {
    throwsCode(() => store.appendBlock(st.id, 1, "r", [{ t: 1, angle: bad }]), bad === 180 || bad === 360 || bad === -180.5 ? "ANGLE_OUT_OF_RANGE" : "INVALID_ANGLE");
  }
  store.close();
});

test("坏块回滚不推进状态", () => {
  const store = new Store(tmpDb());
  const st = store.createStream();
  store.appendBlock(st.id, 1, "r1", [{ t: 100, angle: 170 }]);
  throwsCode(() => store.appendBlock(st.id, 2, "r2", [{ t: 200, angle: -170 }, { t: 300, angle: 999 }]), "ANGLE_OUT_OF_RANGE");
  const after = store.getStream(st.id);
  assert.strictEqual(after.sampleCount, 1);
  assert.strictEqual(after.nextSeq, 2);
  assert.strictEqual(after.lastAngle, 170);
  const r = store.appendBlock(st.id, 2, "r2b", [{ t: 200, angle: -170 }]);
  assert.strictEqual(r.points[0].unwrapped, 190);
  store.close();
});

test("块重试: 同序号同内容返回原结果, 改内容或跳序号拒绝", () => {
  const store = new Store(tmpDb());
  const st = store.createStream();
  const block = [{ t: 100, angle: 10 }, { t: 200, angle: 20 }];
  const first = store.appendBlock(st.id, 1, "req-a", block);
  const retry = store.appendBlock(st.id, 1, "req-a", block);
  assert.strictEqual(retry.replayed, true);
  assert.deepStrictEqual(retry.points, first.points);
  throwsCode(() => store.appendBlock(st.id, 1, "req-a", [{ t: 100, angle: 11 }, { t: 200, angle: 20 }]), "SEQ_CONFLICT");
  throwsCode(() => store.appendBlock(st.id, 1, "req-other", block), "SEQ_CONFLICT");
  throwsCode(() => store.appendBlock(st.id, 5, "req-x", [{ t: 300, angle: 0 }]), "SEQ_SKIPPED");
  store.close();
});

test("结束后拒绝追加", () => {
  const store = new Store(tmpDb());
  const st = store.createStream();
  store.appendBlock(st.id, 1, "r1", [{ t: 100, angle: 0 }]);
  store.finalize(st.id);
  throwsCode(() => store.appendBlock(st.id, 2, "r2", [{ t: 200, angle: 1 }]), "STREAM_FINALIZED");
  store.close();
});

test("变化率与段首", () => {
  const store = new Store(tmpDb());
  const st = store.createStream();
  const pts = feed(store, st.id, [{ t: 0, angle: 0 }, { t: 1000, angle: 90 }, { t: 2000, angle: null }, { t: 3000, angle: 5 }], 100);
  assert.strictEqual(pts[0].rate, null);
  assert.strictEqual(pts[1].rate, 90);
  assert.strictEqual(pts[2].rate, null);
  assert.strictEqual(pts[3].rate, null);
  store.close();
});

test("报告段首尾差", () => {
  const store = new Store(tmpDb());
  const st = store.createStream();
  feed(store, st.id, toSamples(DEMO), 100);
  store.finalize(st.id);
  const rep = store.report(st.id);
  assert.strictEqual(rep.segmentCount, 2);
  assert.strictEqual(rep.segments[0].span, 0);
  assert.strictEqual(rep.segments[1].span, -20);
  assert.strictEqual(rep.negativeCorrections, 2);
  assert.strictEqual(rep.positiveCorrections, 1);
  store.close();
});
