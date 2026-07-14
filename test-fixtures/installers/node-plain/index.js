// Minimal plain-Node (no framework) http server for the installer regression
// harness. Two routes: `/` returns ok, `/boom` console.errors then throws. There
// is no framework to catch the throw, so it propagates as a REAL uncaughtException
// — exercising autoCapture's bounded crash flush: the crash event must reach
// ingest before the process exits(1). The harness hits /boom once and tolerates
// the resulting nonzero exit.
const http = require("node:http");

const server = http.createServer((req, res) => {
  if (req.url === "/boom") {
    const err = new Error("boom: intentional installer-fixture error");
    console.error(err);
    // No try/catch: this throw becomes an uncaughtException, so autoCapture's
    // crash hook (not the console.error hook) is what proves delivery here.
    throw err;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
});

const port = Number(process.env.PORT) || 3000;

server.listen(port, "127.0.0.1", () => {
  // Machine-readable readiness line the harness can wait on.
  console.log(`NODE_PLAIN_READY port=${port}`);
});
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
