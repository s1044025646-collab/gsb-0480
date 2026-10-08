import * as path from "node:path";
import * as fs from "node:fs";
import { Store } from "./store";
import { createServer, findFreePort } from "./server";

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const DB_PATH = process.env.DB_PATH ?? path.join(DATA_DIR, "unwrap.db");

function usage(): never {
  console.log(`用法:
  node dist/cli.js serve [--port N]            启动 HTTP API(默认自动选空闲端口)
  node dist/cli.js create                      新建流, 输出 streamId
  node dist/cli.js append <streamId> <seq> <requestId> <file.json>
                                               追加样本块(JSON: [{t, angle|null}, ...])
  node dist/cli.js finalize <streamId>         结束输入(之后只读)
  node dist/cli.js points <streamId> [from to] 查询区间点
  node dist/cli.js corrections <streamId>      查询整周修正来源
  node dist/cli.js report <streamId>           导出报告
  node dist/cli.js demo                        运行内置演示`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd) usage();

  if (cmd === "demo") {
    const { runDemo } = await import("./demo.js");
    runDemo(new Store(path.join(DATA_DIR, `demo-${Date.now()}.db`)));
    return;
  }

  const store = new Store(DB_PATH);
  try {
    if (cmd === "serve") {
      const pi = args.indexOf("--port");
      const preferred = pi >= 0 ? Number(args[pi + 1]) : (process.env.PORT ? Number(process.env.PORT) : undefined);
      const port = await findFreePort(preferred);
      const server = createServer(store);
      server.listen(port, "127.0.0.1", () => {
        console.log(`API 已启动: http://127.0.0.1:${port} (数据库: ${DB_PATH})`);
      });
      return;
    }
    if (cmd === "create") {
      console.log(JSON.stringify({ streamId: store.createStream().id }));
    } else if (cmd === "append") {
      const [, id, seq, requestId, file] = args;
      if (!id || !seq || !requestId || !file) usage();
      const samples = JSON.parse(fs.readFileSync(file, "utf8"));
      console.log(JSON.stringify(store.appendBlock(id, Number(seq), requestId, samples), null, 2));
    } else if (cmd === "finalize") {
      console.log(JSON.stringify(store.finalize(args[1])));
    } else if (cmd === "points") {
      console.log(JSON.stringify({ points: store.queryPoints(args[1], args[2] ? Number(args[2]) : undefined, args[3] ? Number(args[3]) : undefined) }, null, 2));
    } else if (cmd === "corrections") {
      console.log(JSON.stringify({ corrections: store.queryCorrections(args[1]) }, null, 2));
    } else if (cmd === "report") {
      console.log(JSON.stringify(store.report(args[1]), null, 2));
    } else {
      usage();
    }
  } finally {
    if (cmd !== "serve") store.close();
  }
}

main().catch((e) => {
  if (e && e.code) console.error(`错误 [${e.code}] ${e.message}`);
  else console.error(e);
  process.exit(1);
});
