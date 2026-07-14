// Minimal Express (CommonJS) app for the installer regression harness.
// Two routes: `/` returns ok, `/boom` throws so a captured session has a real
// server-side error to attribute (the `/boom` error-event assertion is CP1 scope).
const express = require("express");

const app = express();

app.get("/", (_req, res) => {
  res.json({ ok: true });
});

app.get("/boom", () => {
  throw new Error("boom: intentional installer-fixture error");
});

const port = Number(process.env.PORT) || 3000;

if (require.main === module) {
  const server = app.listen(port, () => {
    // Machine-readable readiness line the harness can wait on.
    console.log(`EXPRESS_CJS_READY port=${port}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

module.exports = app;
