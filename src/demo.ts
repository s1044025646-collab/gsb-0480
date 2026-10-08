import { Store } from "./store";

export function runDemo(store: Store): void {
  const demo = (name: string, angles: (number | null)[], chunkSize: number) => {
    const st = store.createStream();
    let t = 0;
    const samples = angles.map((angle) => ({ t: (t += 100), angle }));
    let seq = 1;
    const all: { angle: number | null; unwrapped: number | null; segmentId: number | null }[] = [];
    for (let i = 0; i < samples.length; i += chunkSize) {
      const r = store.appendBlock(st.id, seq++, `demo-${name}-${seq}`, samples.slice(i, i + chunkSize));
      all.push(...r.points);
    }
    store.finalize(st.id);
    console.log(`\n== ${name} ==`);
    console.log("输入:   " + JSON.stringify(angles));
    console.log("展开:   " + JSON.stringify(all.map((p) => p.unwrapped)));
    console.log("段编号: " + JSON.stringify(all.map((p) => p.segmentId)));
    const rep = store.report(st.id) as { segmentCount: number; positiveCorrections: number; negativeCorrections: number };
    console.log(`段数=${rep.segmentCount} 正向修正=${rep.positiveCorrections} 负向修正=${rep.negativeCorrections}`);
  };

  demo("基本示例", [170, -170, -160, 170, null, -170, 170], 100);
  demo("恰半周", [0, -180, 0], 100);
  demo("多圈递增", [0, 100, -160, -60, 40, 140, -120], 100);
  demo("连续缺测", [10, null, null, null, 20, 30], 100);
  demo("逐点追加(块大小1)", [170, -170, -160, 170, null, -170, 170], 1);
}
