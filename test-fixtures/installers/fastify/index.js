// Minimal Fastify (CommonJS) app for the installer regression harness. Two
// routes: `/` returns ok, `/boom` console.errors then throws (Fastify turns the
// throw into a 500) so autoCapture surfaces a real server-side error event.
const Fastify = require("fastify");

const app = Fastify();

app.get("/", async () => ({ ok: true }));

app.get("/boom", async () => {
  const err = new Error("boom: intentional installer-fixture error");
  console.error(err);
  throw err;
});

const port = Number(process.env.PORT) || 3000;

app
  .listen({ port, host: "127.0.0.1" })
  .then(() => {
    // Machine-readable readiness line the harness can wait on.
    console.log(`FASTIFY_READY port=${port}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

const shutdown = () => app.close().then(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
