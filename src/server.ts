// HTTP API：新建流 / 追加块 / 结束 / 查询 / 修正来源 / 报告
import http from "node:http";
import { StreamStore } from "./store.js";
import { ApiError } from "./errors.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 16 * 1024 * 1024) throw new ApiError("BAD_REQUEST", "请求体过大", 413);
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError("BAD_REQUEST", "请求体不是合法 JSON");
  }
}

export function createServer(store: StreamStore): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "POST" && url.pathname === "/streams") {
        sendJson(res, 201, store.createStream());
        return;
      }
      if (parts[0] === "streams" && parts.length >= 2) {
        const id = parts[1];
        const action = parts[2];
        if (method === "POST" && action === "blocks" && parts.length === 3) {
          const body = (await readBody(req)) as Record<string, unknown>;
          sendJson(res, 200, store.appendBlock(id, body.seq, body.requestId, body.samples));
          return;
        }
        if (method === "POST" && action === "finish" && parts.length === 3) {
          sendJson(res, 200, store.finish(id));
          return;
        }
        if (method === "GET" && action === "samples" && parts.length === 3) {
          const from = url.searchParams.get("from");
          const to = url.searchParams.get("to");
          sendJson(res, 200, {
            samples: store.querySamples(
              id,
              from !== null ? Number(from) : undefined,
              to !== null ? Number(to) : undefined
            ),
          });
          return;
        }
        if (method === "GET" && action === "corrections" && parts.length === 3) {
          sendJson(res, 200, { corrections: store.corrections(id) });
          return;
        }
        if (method === "GET" && action === "report" && parts.length === 3) {
          sendJson(res, 200, store.report(id));
          return;
        }
      }
      throw new ApiError("BAD_REQUEST", `未知路由: ${method} ${url.pathname}`, 404);
    } catch (e) {
      if (e instanceof ApiError) {
        sendJson(res, e.httpStatus, { error: { code: e.code, message: e.message } });
      } else {
        sendJson(res, 500, {
          error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) },
        });
      }
    }
  });
}

export function startServer(
  dataDir: string,
  port: number
): Promise<{ port: number; server: http.Server; store: StreamStore }> {
  const store = new StreamStore(dataDir);
  const server = createServer(store);
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    // port 0 = 由系统选择空闲端口（默认行为）
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      resolve({ port: actual, server, store });
    });
  });
}
