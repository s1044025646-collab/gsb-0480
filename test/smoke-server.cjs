const { startServer } = require("../dist/server.js");
(async () => {
  const { port, server, store } = await startServer("./data-smoke", 0);
  const base = "http://127.0.0.1:" + port;
  const j = (r) => r.json();
  const { streamId } = await fetch(base + "/streams", { method: "POST" }).then(j);
  const samples = [
    { t: 0, angle: 170 },
    { t: 1000, angle: -170 },
    { t: 2000, angle: null },
    { t: 3000, angle: -170 },
  ];
  const post = (body) =>
    fetch(base + "/streams/" + streamId + "/blocks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const block = await post({ seq: 1, requestId: "smoke-1", samples }).then(j);
  console.log("unwrapped:", block.samples.map((s) => s.unwrapped).join(","));
  const retry = await post({ seq: 1, requestId: "smoke-1", samples }).then(j);
  console.log("replayed:", retry.replayed);
  const bad = await post({ seq: 2, requestId: "smoke-2", samples: [{ t: 4000, angle: 180 }] });
  console.log("bad angle:", bad.status, (await bad.json()).error.code);
  await fetch(base + "/streams/" + streamId + "/finish", { method: "POST" });
  const after = await post({ seq: 2, requestId: "smoke-2", samples: [{ t: 4000, angle: 0 }] });
  console.log("after finish:", after.status, (await after.json()).error.code);
  const report = await fetch(base + "/streams/" + streamId + "/report").then(j);
  console.log("segments:", report.totalSegments, "pos:", report.posCorrections, "neg:", report.negCorrections);
  server.close();
  store.close();
})();
