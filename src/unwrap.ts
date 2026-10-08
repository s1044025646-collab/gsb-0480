// 核心一维相位展开逻辑（纯函数，无 IO）。

export interface SampleInput {
  t: number; // 毫秒，非负安全整数，严格递增
  angle: number | null; // [-180,180) 或 null（缺测）
}

export interface ProcessedSample {
  index: number;
  t: number;
  angle: number | null;
  segmentId: number | null; // 缺测为 null
  d: number | null; // 与上一有效样本的原差（段首为 null）
  correction: number | null; // 本点采用的整周修正增量（-1/0/+1）
  cycles: number | null; // 累计整周数
  unwrapped: number | null; // 展开角（度）
  rate: number | null; // 度/秒，段首与缺测为 null
}

export interface UnwrapState {
  lastT: number | null; // 上一条样本（含缺测）的时间，用于严格递增校验
  inSegment: boolean; // 是否存在未中断的连续段
  segmentCount: number; // 已开始的段数
  lastAngle: number; // 当前段上一包裹角
  lastUnwrapped: number; // 当前段上一展开角
  lastValidT: number; // 当前段上一有效样本时间（毫秒）
  cycles: number; // 当前段累计整周数
  posCorrections: number; // d < -180 次数（整周数 +1）
  negCorrections: number; // d > 180 次数（整周数 -1）
  sampleCount: number; // 已处理样本总数（含缺测）
}

export function initialState(): UnwrapState {
  return {
    lastT: null,
    inSegment: false,
    segmentCount: 0,
    lastAngle: 0,
    lastUnwrapped: 0,
    lastValidT: 0,
    cycles: 0,
    posCorrections: 0,
    negCorrections: 0,
    sampleCount: 0,
  };
}

export function validateAngle(angle: unknown): asserts angle is number {
  if (typeof angle !== "number" || !Number.isFinite(angle)) {
    throw new Error("NON_FINITE: 角度必须是有限数");
  }
  if (angle < -180 || angle >= 180) {
    throw new Error(
      "INVALID_ANGLE: 角度必须处于半开区间 [-180,180)，拒绝 180/360 及范围外值，不做自动取模"
    );
  }
}

export function validateTimestamp(t: unknown, lastT: number | null): asserts t is number {
  if (typeof t !== "number" || !Number.isSafeInteger(t) || t < 0) {
    throw new Error("INVALID_TIMESTAMP: 时间戳必须是非负安全整数（毫秒）");
  }
  if (lastT !== null && t <= lastT) {
    throw new Error("INVALID_TIMESTAMP: 时间戳必须严格递增（含跨块、跨段）");
  }
}

// 处理单条样本，原地推进 state，返回处理结果。
export function processSample(state: UnwrapState, input: SampleInput): ProcessedSample {
  validateTimestamp(input.t, state.lastT);
  const index = state.sampleCount;
  state.lastT = input.t;
  state.sampleCount += 1;

  if (input.angle === null) {
    // 缺测：中断连续段，下一有效样本新建段
    state.inSegment = false;
    return {
      index,
      t: input.t,
      angle: null,
      segmentId: null,
      d: null,
      correction: null,
      cycles: null,
      unwrapped: null,
      rate: null,
    };
  }

  validateAngle(input.angle);

  if (!state.inSegment) {
    // 新段：整周数归零，展开角等于原值，无变化率
    state.segmentCount += 1;
    state.inSegment = true;
    state.lastAngle = input.angle;
    state.lastUnwrapped = input.angle;
    state.lastValidT = input.t;
    state.cycles = 0;
    return {
      index,
      t: input.t,
      angle: input.angle,
      segmentId: state.segmentCount,
      d: null,
      correction: 0,
      cycles: 0,
      unwrapped: input.angle,
      rate: null,
    };
  }

  // 用上一“包裹角”计算原差，绝不用上一展开角，避免多圈后重复修正
  const d = input.angle - state.lastAngle;
  let correction = 0;
  if (d > 180) {
    state.cycles -= 1;
    correction = -1;
    state.negCorrections += 1;
  } else if (d < -180) {
    state.cycles += 1;
    correction = 1;
    state.posCorrections += 1;
  }
  // 精确 d === ±180：两个方向同样短，保持原差符号，不修正

  const unwrapped = input.angle + 360 * state.cycles;
  if (!Number.isFinite(unwrapped)) {
    throw new Error("NON_FINITE: 展开结果非有限数，达到数值预算");
  }
  const dtSec = (input.t - state.lastValidT) / 1000;
  const rate = (unwrapped - state.lastUnwrapped) / dtSec;
  if (!Number.isFinite(rate)) {
    throw new Error("NON_FINITE: 变化率非有限数，达到数值预算");
  }

  state.lastAngle = input.angle;
  state.lastUnwrapped = unwrapped;
  state.lastValidT = input.t;

  return {
    index,
    t: input.t,
    angle: input.angle,
    segmentId: state.segmentCount,
    d,
    correction,
    cycles: state.cycles,
    unwrapped,
    rate,
  };
}
