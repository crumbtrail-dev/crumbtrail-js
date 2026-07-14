// Minimal Hono (Node server, CommonJS) app for the installer regression harness.
// Two routes: `/` returns ok, `/boom` console.errors then throws (Hono turns the
// throw into a 500) so autoCapture surfaces a real server-side error event.
const { serve } = require("@hono/node-server");
const { Hono } = require("hono");

const app = new Hono();

app.get("/", (c) => c.json({ ok: true }));

app.get("/boom", () => {
  const err = new Error("boom: intentional installer-fixture error");
  console.error(err);
  throw err;
});

const port = Number(process.env.PORT) || 3000;

const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
  // Machine-readable readiness line the harness can wait on.
  console.log(`HONO_READY port=${port}`);
});
const shutdown = () => {
  server.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
