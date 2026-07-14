// Minimal Express (ESM) app for the installer regression harness. Two routes:
// `/` returns ok, `/boom` console.errors then throws so autoCapture surfaces a
// real server-side error event (the `/boom` error-event assertion is CP1 scope).
import express from "express";

const app = express();

app.get("/", (_req, res) => {
  res.json({ ok: true });
});

app.get("/boom", () => {
  const err = new Error("boom: intentional installer-fixture error");
  console.error(err);
  throw err;
});

const port = Number(process.env.PORT) || 3000;

const server = app.listen(port, () => {
  // Machine-readable readiness line the harness can wait on.
  console.log(`EXPRESS_ESM_READY port=${port}`);
});
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

export default app;
