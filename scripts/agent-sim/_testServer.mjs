import { createServer } from "node:http";

/**
 * In-process mock agent. For POST /:agentId/message/stream it streams the SSE frames in
 * `stepScript` (an array of event objects) then [DONE]. For POST .../cex-workflow/approval
 * it records the call and returns { success: true }.
 * @param {{stepScript: any[]}} cfg
 */
export function startMockAgent({ stepScript, hang }) {
  const approvals = [];
  const server = createServer((req, res) => {
    let bodyChunks = "";
    req.on("data", (c) => {
      bodyChunks += c;
    });
    req.on("end", () => {
      if (req.url.includes("/cex-workflow/approval")) {
        approvals.push(JSON.parse(bodyChunks || "{}"));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
        return;
      }
      // streaming endpoint
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      for (const evt of stepScript) res.write(`data: ${JSON.stringify(evt)}\n\n`);
      if (hang) return; // simulate an agent suspended at the approval gate (never sends [DONE])
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        approvals,
        url: `http://127.0.0.1:${port}`,
        close: () => {
          server.closeAllConnections?.();
          return new Promise((r) => server.close(r));
        },
      });
    });
  });
}

export function stepEvt(name, status = "in_progress", data = {}) {
  return { type: "step", step: { name, status, message: "", timestamp: 1, data } };
}
