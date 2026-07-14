// Tiny CORS-adding reverse proxy for browser-loaded installer recipes.
//
// Browser-originated ingest (crumbtrail-core's HttpTransport) POSTs JSON with a
// custom `X-Crumbtrail-Auth` header — a non-simple request, so the browser fires
// a CORS preflight (OPTIONS) and blocks the real POST unless the target answers
// with Access-Control-* headers. The stub cloud is a same-process Node harness
// fixture (owned by CP0) and speaks no CORS. Rather than teach the stub about
// browsers, we sit this shim in front of it: it answers preflights and stamps
// CORS headers on every response, transparently forwarding the request (auth
// header intact) to the stub — so the stub's ingest recorder still records the
// authed session/start + event batches exactly as before.
//
// Injected as the client `httpEndpoint`, this is what the browser talks to; the
// stub stays byte-identical.

import http from "node:http";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "600",
};

/**
 * Start a CORS reverse proxy in front of `targetBaseUrl` (e.g. the stub cloud).
 * @param {string} targetBaseUrl
 * @returns {Promise<{ baseUrl: string, port: number, stop: () => Promise<void> }>}
 */
export async function startCorsProxy(targetBaseUrl) {
  const target = new URL(targetBaseUrl);

  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const headers = { ...req.headers, host: target.host };
      const proxyReq = http.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: req.url,
          method: req.method,
          headers,
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode ?? 502, {
            ...proxyRes.headers,
            ...CORS,
          });
          proxyRes.pipe(res);
        },
      );
      proxyReq.on("error", () => {
        res.writeHead(502, CORS);
        res.end();
      });
      if (body.length) proxyReq.write(body);
      proxyReq.end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    async stop() {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}
