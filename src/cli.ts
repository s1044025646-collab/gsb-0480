// CLI：serve / create / append / finish / samples / corrections / report / demo
import path from "node:path";
import { StreamStore } from "./store.js";
import { startServer } from "./server.js";
import type { SampleInput } from "./unwrap.js";

const DATA_DIR = process.env.UNWRAP_DATA_DIR ?? path.join(process.cwd(), "data");

function parseSamplesJson(text: string): SampleInput[] {
  // 支持 [{t,angle},...] 或简写角度数组 [170,-170,null,...]（时间戳从 0 起每 1000ms 一条）
  const raw = JSON.parse(text) as unknown[];
  if (!Array.isArray(raw)) throw new Error("样本必须是 JSON 数组");
  return raw.map((item, i) => {
    if (typeof item === "number" || item === null) return { t: i * 1000, angle: item };
    const o = item as { t: number; angle: number | null };
    return { t: o.t, angle: o.angle };
  });
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const store = new StreamStore(DATA_DIR);

  switch (cmd) {
    case "serve": {
      const portArg = args.find((a) => a.startsWith("--port="));
      const port = portArg ? Number(portArg.split("=")[1]) : Number(process.env.PORT ?? 0);
      const { port: actual } = await startServer(DATA_DIR, port);
      console.log(`相位展开服务已启动: http://127.0.0.1:${actual}  数据目录: ${DATA_DIR}`);
      break;
    }
    case "create": {
      console.log(JSON.stringify(store.createStream()));
      break;
    }
    case "append": {
      // append <streamId> <seq> <requestId> <samplesJson>
      const [id, seq, reqId, json] = args;
      const result = store.appendBlock(id, Number(seq), reqId, parseSamplesJson(json));
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "finish": {
      console.log(JSON.stringify(store.finish(args[0])));
      break;
    }
    case "samples": {
      const [id, from, to] = args;
      console.log(
        JSON.stringify(
          store.querySamples(
            id,
            from !== undefined ? Number(from) : undefined,
            to !== undefined ? Number(to) : undefined
          ),
          null,
          2
        )
      );
      break;
    }
    case "corrections": {
      console.log(JSON.stringify(store.corrections(args[0]), null, 2));
      break;
    }
    case "report": {
      console.log(JSON.stringify(store.report(args[0]), null, 2));
      break;
    }
    case "demo": {
      const { streamId } = store.createStream();
      const angles = [170, -170, -160, 170, null, -170, 170];
      const samples = angles.map((a, i) => ({ t: i * 1000, angle: a }));
      const r1 = store.appendBlock(streamId, 1, "demo-block-1", samples);
      console.log("演示输入:", JSON.stringify(angles));
      console.log("展开结果:", JSON.stringify(r1.samples.map((s) => s.unwrapped)));
      store.finish(streamId);
      console.log("报告:", JSON.stringify(store.report(streamId), null, 2));
      break;
    }
    default:
      console.log(`用法:
  npm run cli -- serve [--port=3000]     启动 HTTP 服务（默认自动选择空闲端口）
  npm run cli -- create                  新建流
  npm run cli -- append <id> <seq> <reqId> '<json>'  追加样本块
  npm run cli -- finish <id>             结束输入（之后只读）
  npm run cli -- samples <id> [from] [to]  查询区间
  npm run cli -- corrections <id>        查询修正来源
  npm run cli -- report <id>             导出报告
  npm run cli -- demo                    运行内置演示`);
  }
  store.close();
}

main().catch((e) => {
  console.error("错误:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
