import * as http from "node:http";
import * as net from "node:net";
import { Store } from "./store";
import { ApiError } from "./unwrap";

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 20 * 1024 * 1024) { reject(new ApiError("BUDGET_EXCEEDED", "请求体过大", 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new ApiError("INVALID_JSON", "请求体不是合法 JSON")); }
    });
    req.on("error", reject);
  });
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      const data = JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(data);
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "POST" && url.pathname === "/streams") {
        const st = store.createStream();
        return send(201, { streamId: st.id });
      }
      if (parts[0] === "streams" && parts.length >= 2) {
        const id = parts[1];
        if (method === "POST" && parts[2] === "blocks" && parts.length === 3) {
          const body = (await readBody(req)) as Record<string, unknown>;
          const r = store.appendBlock(id, body.seq, body.requestId, body.samples);
          return send(200, r);
        }
        if (method === "POST" && parts[2] === "finalize" && parts.length === 3) {
          return send(200, store.finalize(id));
        }
        if (method === "GET" && parts[2] === "points" && parts.length === 3) {
          const from = url.searchParams.get("from");
          const to = url.searchParams.get("to");
          return send(200, {
            points: store.queryPoints(id,
              from !== null ? Number(from) : undefined,
              to !== null ? Number(to) : undefined),
          });
        }
        if (method === "GET" && parts[2] === "corrections" && parts.length === 3) {
          return send(200, { corrections: store.queryCorrections(id) });
        }
        if (method === "GET" && parts[2] === "report" && parts.length === 3) {
          return send(200, store.report(id));
        }
      }
      throw new ApiError("NOT_FOUND", "路由不存在", 404);
    } catch (e) {
      if (e instanceof ApiError) return send(e.status, { error: { code: e.code, message: e.message } });
      send(500, { error: { code: "INTERNAL", message: String(e) } });
    }
  });
}

export function findFreePort(preferred?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", () => {
      if (preferred) { findFreePort(undefined).then(resolve, reject); }
      else reject(new Error("无可用端口"));
    });
    srv.listen(preferred ?? 0, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
  });
}
