export interface SampleInput {
  t: number;
  angle: number | null;
}

export interface PointResult {
  index: number;
  t: number;
  angle: number | null;
  segmentId: number | null;
  rawDelta: number | null;
  cycleCorrection: number | null;
  cycles: number | null;
  unwrapped: number | null;
  rate: number | null;
}

export interface SegmentSummary {
  segmentId: number;
  startIndex: number;
  endIndex: number;
  startT: number;
  endT: number;
  startUnwrapped: number;
  endUnwrapped: number;
  span: number;
  pointCount: number;
}

export interface StreamState {
  nextSeq: number;
  finalized: boolean;
  lastT: number | null;
  lastValidT: number | null;
  segmentId: number;
  lastAngle: number | null;
  lastUnwrapped: number | null;
  cycles: number;
  posCorrections: number;
  negCorrections: number;
  sampleCount: number;
  validCount: number;
}

export function initialState(): StreamState {
  return {
    nextSeq: 1,
    finalized: false,
    lastT: null,
    lastValidT: null,
    segmentId: 0,
    lastAngle: null,
    lastUnwrapped: null,
    cycles: 0,
    posCorrections: 0,
    negCorrections: 0,
    sampleCount: 0,
    validCount: 0,
  };
}

export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export const MAX_SAMPLES_PER_STREAM = 1_000_000;
export const MAX_SAMPLES_PER_BLOCK = 100_000;
export const MAX_ABS_UNWRAPPED = 1e15;

export function validateSample(raw: unknown, index: number, prevT: number | null): SampleInput {
  if (typeof raw !== "object" || raw === null) {
    throw new ApiError("INVALID_SAMPLE", `样本 ${index}: 必须是对象`);
  }
  const s = raw as Record<string, unknown>;
  const t = s.t;
  if (typeof t !== "number" || !Number.isSafeInteger(t) || t < 0) {
    throw new ApiError("INVALID_TIMESTAMP", `样本 ${index}: 时间戳必须是非负安全整数`);
  }
  if (prevT !== null && t <= prevT) {
    throw new ApiError("TIMESTAMP_NOT_INCREASING", `样本 ${index}: 时间戳必须严格递增 (t=${t}, 上一个=${prevT})`);
  }
  const angle = s.angle;
  if (angle === null) return { t, angle: null };
  if (typeof angle !== "number" || !Number.isFinite(angle)) {
    throw new ApiError("INVALID_ANGLE", `样本 ${index}: 角度必须是有限数或 null`);
  }
  if (angle < -180 || angle >= 180) {
    throw new ApiError("ANGLE_OUT_OF_RANGE", `样本 ${index}: 角度必须处于 [-180,180)，收到 ${angle}`);
  }
  return { t, angle };
}

export interface BlockOutcome {
  points: PointResult[];
  state: StreamState;
}

export function processBlock(samples: SampleInput[], state: StreamState): BlockOutcome {
  const st: StreamState = { ...state };
  const points: PointResult[] = [];
  for (const s of samples) {
    const index = st.sampleCount;
    if (st.sampleCount >= MAX_SAMPLES_PER_STREAM) {
      throw new ApiError("BUDGET_EXCEEDED", `达到样本预算上限 ${MAX_SAMPLES_PER_STREAM}，停止处理`, 413);
    }
    st.sampleCount += 1;
    st.lastT = s.t;
    if (s.angle === null) {
      st.lastAngle = null;
      st.lastUnwrapped = null;
      st.lastValidT = null;
      st.cycles = 0;
      points.push({ index, t: s.t, angle: null, segmentId: null, rawDelta: null, cycleCorrection: null, cycles: null, unwrapped: null, rate: null });
      continue;
    }
    let rawDelta: number | null = null;
    let cycleCorrection: number | null = null;
    let rate: number | null = null;
    if (st.lastAngle === null) {
      st.segmentId += 1;
      st.cycles = 0;
    } else {
      rawDelta = s.angle - st.lastAngle;
      cycleCorrection = 0;
      if (rawDelta > 180) {
        st.cycles -= 1;
        cycleCorrection = -1;
        st.negCorrections += 1;
      } else if (rawDelta < -180) {
        st.cycles += 1;
        cycleCorrection = 1;
        st.posCorrections += 1;
      }
    }
    const unwrapped = s.angle + 360 * st.cycles;
    if (!Number.isFinite(unwrapped) || Math.abs(unwrapped) > MAX_ABS_UNWRAPPED) {
      throw new ApiError("BUDGET_EXCEEDED", "展开数值超出有限预算，停止处理", 413);
    }
    if (st.lastUnwrapped !== null && st.lastValidT !== null) {
      const dt = (s.t - st.lastValidT) / 1000;
      if (dt > 0) rate = (unwrapped - st.lastUnwrapped) / dt;
    }
    st.validCount += 1;
    points.push({
      index, t: s.t, angle: s.angle, segmentId: st.segmentId,
      rawDelta, cycleCorrection, cycles: st.cycles, unwrapped, rate,
    });
    st.lastAngle = s.angle;
    st.lastUnwrapped = unwrapped;
    st.lastValidT = s.t;
  }
  return { points, state: st };
}
