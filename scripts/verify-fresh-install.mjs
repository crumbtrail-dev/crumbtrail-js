#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const coreRoot = path.join(repoRoot, "packages", "core");
const nodeRoot = path.join(repoRoot, "packages", "node");
const timeoutMs = 10_000;
const maxDiagnosticChars = 1_500;
const authToken = "fresh-install-verifier-auth-token";
const allowedOrigin = "https://fresh-install.example.test";

const phases = [];

function boundedTail(value, max = maxDiagnosticChars) {
  if (!value) return "";
  if (value.length <= max) return value;
  return value.slice(value.length - max);
}

function redact(value) {
  return String(value)
    .replaceAll(authToken, "[REDACTED_AUTH_TOKEN]")
    .replaceAll(allowedOrigin, "[REDACTED_ALLOWED_ORIGIN]");
}

function phaseLog(phase, status, detail = "") {
  const suffix = detail ? ` ${redact(detail)}` : "";
  console.log(
    `CRUMBTRAIL_FRESH_INSTALL_${status.toUpperCase()} phase=${phase}${suffix}`,
  );
}

function recordPhase(phase, status, detail = "") {
  phases.push({ phase, status, detail: redact(detail) });
  phaseLog(phase, status, detail);
}

function fail(phase, err, context = {}) {
  const message = err instanceof Error ? err.message : String(err);
  const details = Object.entries(context)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(
      ([key, value]) =>
        `${key}=${JSON.stringify(redact(boundedTail(String(value))))}`,
    )
    .join(" ");
  console.error(
    `CRUMBTRAIL_FRESH_INSTALL_FAIL phase=${phase} message=${JSON.stringify(redact(message))}${details ? ` ${details}` : ""}`,
  );
  if (phases.length > 0) {
    console.error(`CRUMBTRAIL_FRESH_INSTALL_PHASES ${JSON.stringify(phases)}`);
  }
  process.exit(1);
}

async function runCommand(phase, command, args, options = {}) {
  recordPhase(phase, "start", `command=${command} ${args.join(" ")}`);
  const output = { stdout: "", stderr: "" };
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1", ...options.env },
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output.stdout = boundedTail(output.stdout + chunk);
  });
  child.stderr.on("data", (chunk) => {
    output.stderr = boundedTail(output.stderr + chunk);
  });

  const exitCode = await new Promise((resolve) =>
    child.once("exit", (code) => resolve(code ?? 1)),
  );
  if (exitCode !== 0) {
    fail(phase, new Error(`command exited with ${exitCode}`), output);
  }
  recordPhase(phase, "pass");
  return output;
}

function onceServerListening(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

async function getFreePort() {
  const server = net.createServer();
  await onceServerListening(server);
  const address = server.address();
  await new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  if (!address || typeof address === "string")
    throw new Error("Failed to allocate a local TCP port");
  return address.port;
}

async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

// Finalized sessions are moved into the V2 partition layout ({tenant}/{app}/{date}/{id}), so the
// session directory is no longer at the flat outputDir/id path. Walk the tree for a directory named
// `sessionId` that contains meta.json.
async function findSessionDir(outputDir, sessionId) {
  const stack = [outputDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(currentDir, entry.name);
      const hasMeta = await fs
        .access(path.join(candidate, "meta.json"))
        .then(() => true)
        .catch(() => false);
      if (entry.name === sessionId && hasMeta) return candidate;
      if (!hasMeta) stack.push(candidate);
    }
  }
  throw new Error(
    `finalized session ${sessionId} not found under ${outputDir}`,
  );
}

async function assertPackageMetadata() {
  recordPhase("package-metadata", "start");
  const [corePkg, nodePkg] = await Promise.all([
    readJsonFile(path.join(coreRoot, "package.json")),
    readJsonFile(path.join(nodeRoot, "package.json")),
  ]);

  if (corePkg.name !== "crumbtrail-core")
    throw new Error("packages/core package name mismatch");
  if (!corePkg.files?.includes("dist"))
    throw new Error("crumbtrail-core package files must include dist");
  if (nodePkg.name !== "crumbtrail-node")
    throw new Error("packages/node package name mismatch");
  if (nodePkg.bin?.["crumbtrail-server"] !== "./dist/cli.cjs")
    throw new Error("crumbtrail-node bin must expose ./dist/cli.cjs");
  if (!nodePkg.files?.includes("dist"))
    throw new Error("crumbtrail-node package files must include dist");
  // core is ALSO inlined into node's build (tsup noExternal), so node's runtime never imports this
  // declared dep — it exists so `npm i crumbtrail-node` pulls core in for the browser SDK. See
  // packages/node/tsup.config.ts for the full dual-topology rationale before changing this.
  if (nodePkg.dependencies?.["crumbtrail-core"] !== "workspace:^") {
    throw new Error(
      "crumbtrail-node must declare crumbtrail-core as a workspace runtime dependency",
    );
  }
  recordPhase(
    "package-metadata",
    "pass",
    `core=${corePkg.version} node=${nodePkg.version}`,
  );
}

async function packPackage(packageDir, packDir) {
  const before = new Set(await fs.readdir(packDir));
  await runCommand(
    "package-pack",
    "pnpm",
    ["pack", "--pack-destination", packDir],
    { cwd: packageDir },
  );
  const after = await fs.readdir(packDir);
  const created = after.filter(
    (entry) => entry.endsWith(".tgz") && !before.has(entry),
  );
  if (created.length !== 1)
    throw new Error(
      `expected one tarball from ${packageDir}, found ${created.length}`,
    );
  return path.join(packDir, created[0]);
}

async function readPackedPackageJson(tarballPath, extractDir) {
  await fs.rm(extractDir, { recursive: true, force: true });
  await fs.mkdir(extractDir, { recursive: true });
  await runCommand("packed-manifest-extract", "tar", [
    "-xzf",
    tarballPath,
    "-C",
    extractDir,
    "package/package.json",
  ]);
  return readJsonFile(path.join(extractDir, "package", "package.json"));
}

async function assertPackedNodeDependency(nodeTarball, extractDir) {
  recordPhase("packed-manifest", "start");
  const packedPkg = await readPackedPackageJson(nodeTarball, extractDir);
  if (packedPkg.dependencies?.["crumbtrail-core"] !== "^0.1.0") {
    throw new Error(
      `packed crumbtrail-node must rewrite crumbtrail-core workspace dependency to ^0.1.0, got ${packedPkg.dependencies?.["crumbtrail-core"] ?? "missing"}`,
    );
  }
  if (packedPkg.bin?.["crumbtrail-server"] !== "./dist/cli.cjs")
    throw new Error("packed crumbtrail-node bin must expose ./dist/cli.cjs");
  if (!packedPkg.files?.includes("dist"))
    throw new Error("packed crumbtrail-node package files must include dist");
  recordPhase("packed-manifest", "pass", "crumbtrail-core=^0.1.0");
}

async function installTempProject(tempProjectDir, coreTarball, nodeTarball) {
  recordPhase("temp-install", "start", `project=${tempProjectDir}`);
  // Install both packed tarballs with no pnpm.overrides. This proves the local prepublish flow
  // matches npm consumer semantics: crumbtrail-node keeps a real runtime dependency on core, and
  // the packed node manifest rewrites the workspace protocol to a public semver range.
  await fs.writeFile(
    path.join(tempProjectDir, "package.json"),
    JSON.stringify(
      {
        private: true,
        type: "module",
      },
      null,
      2,
    ),
  );
  await runCommand(
    "temp-install",
    "npm",
    [
      "i",
      `crumbtrail-core@file:${coreTarball}`,
      `crumbtrail-node@file:${nodeTarball}`,
      "--ignore-scripts",
    ],
    { cwd: tempProjectDir },
  );
  recordPhase("temp-install", "pass");
}

async function assertInstalledPackageMetadata(tempProjectDir) {
  recordPhase("installed-package-metadata", "start");
  const installedPkg = await readJsonFile(
    path.join(
      tempProjectDir,
      "node_modules",
      "crumbtrail-node",
      "package.json",
    ),
  );
  if (installedPkg.dependencies?.["crumbtrail-core"] !== "^0.1.0") {
    throw new Error(
      "installed crumbtrail-node must declare crumbtrail-core dependency as ^0.1.0",
    );
  }
  const installedCorePkg = await readJsonFile(
    path.join(
      tempProjectDir,
      "node_modules",
      "crumbtrail-core",
      "package.json",
    ),
  );
  if (
    installedCorePkg.name !== "crumbtrail-core" ||
    installedCorePkg.version !== "0.1.0"
  ) {
    throw new Error("installed crumbtrail-core package metadata mismatch");
  }
  recordPhase("installed-package-metadata", "pass");
}

async function resolveInstalledBin(tempProjectDir) {
  recordPhase("binary-resolution", "start");
  const binName =
    process.platform === "win32"
      ? "crumbtrail-server.cmd"
      : "crumbtrail-server";
  const binPath = path.join(tempProjectDir, "node_modules", ".bin", binName);
  await fs.access(binPath);
  recordPhase(
    "binary-resolution",
    "pass",
    `bin=${path.relative(tempProjectDir, binPath)}`,
  );
  return binPath;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `Expected JSON from ${url}, got ${response.status}: ${text.slice(0, 200)}`,
    );
  }
  return { response, body };
}

async function postJson(baseUrl, urlPath, body) {
  return fetchJson(`${baseUrl}${urlPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Crumbtrail-Auth": authToken,
    },
    body: JSON.stringify(body),
  });
}

async function waitForHealth(healthUrl, child, output) {
  recordPhase("health-readiness", "start", `url=${healthUrl}`);
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(
        `server exited before readiness with code ${child.exitCode}`,
      );
    }

    try {
      const { response, body } = await fetchJson(healthUrl, {
        headers: { "X-Crumbtrail-Auth": authToken },
      });
      if (response.ok && body?.ok === true && body?.status === "ready") {
        recordPhase(
          "health-readiness",
          "pass",
          `service=${body.service} version=${body.version}`,
        );
        return body;
      }
      lastError = new Error(
        `health returned ${response.status} status=${body?.status ?? "unknown"}`,
      );
    } catch (err) {
      lastError = err;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `timed out waiting for readiness: ${lastError?.message ?? "no response"}\nstdout=${boundedTail(output.stdout)}\nstderr=${boundedTail(output.stderr)}`,
  );
}

function assertHealthyPayload(body, outputDir, staticDir, port) {
  if (body?.service !== "crumbtrail-node")
    throw new Error("health payload missing service");
  if (body?.config?.port !== port)
    throw new Error("health payload port mismatch");
  if (body?.config?.outputDir !== outputDir)
    throw new Error("health payload outputDir mismatch");
  if (body?.config?.staticDir !== staticDir)
    throw new Error("health payload staticDir mismatch");
  if (body?.config?.authEnabled !== true)
    throw new Error("health payload did not report auth enabled");
  if (body?.config?.allowedOriginCount !== 1)
    throw new Error("health payload did not report allowed-origin count");
  if (body?.checks?.outputDir?.writable !== true)
    throw new Error("health payload did not report writable outputDir");
  const serialized = JSON.stringify(body);
  if (serialized.includes(authToken) || serialized.includes(allowedOrigin)) {
    throw new Error("health payload leaked sensitive config values");
  }
}

async function assertSelfHostArtifacts(baseUrl, outputDir) {
  recordPhase("self-host-artifact-proof", "start");
  const sessionId = "fresh_install_failed_request";
  const start = await postJson(baseUrl, "/api/session/start", {
    sessionId,
    metadata: {
      app: "fresh-install-verifier",
      rootUrl: "http://127.0.0.1/local-app",
    },
  });
  if (!start.response.ok || start.body?.ok !== true)
    throw new Error(`session start failed: ${start.response.status}`);

  const events = [
    { t: 1_000, k: "nav", d: { from: "", to: "/checkout", tr: "init" } },
    {
      t: 1_050,
      k: "net.req",
      d: { id: "req-500", m: "POST", url: "https://api.example.test/checkout" },
    },
    {
      t: 1_090,
      k: "net.res",
      d: { id: "req-500", st: 500, ok: false, dur: 40 },
    },
    {
      t: 1_100,
      k: "err",
      d: {
        msg: "Checkout failed after POST /checkout",
        file: "app.js",
        line: 10,
      },
    },
  ];
  const eventWrite = await postJson(baseUrl, "/api/events", {
    sessionId,
    events,
  });
  if (!eventWrite.response.ok || eventWrite.body?.ok !== true)
    throw new Error(`event write failed: ${eventWrite.response.status}`);

  const end = await postJson(baseUrl, "/api/session/end", { sessionId });
  if (!end.response.ok || end.body?.ok !== true)
    throw new Error(`session end failed: ${end.response.status}`);

  // The session is finalized into the V2 partition layout, not the flat outputDir/id path.
  const sessionDir = await findSessionDir(outputDir, sessionId);
  const requiredFiles = [
    "meta.json",
    "events.ndjson",
    "index.json",
    "CANDIDATES.md",
    "timeline.md",
    "search.jsonl",
  ];
  for (const artifact of requiredFiles) {
    const artifactPath = path.join(sessionDir, artifact);
    const stat = await fs.stat(artifactPath);
    if (!stat.isFile() || stat.size === 0)
      throw new Error(`artifact ${artifact} was empty or missing`);
  }

  const index = await readJsonFile(path.join(sessionDir, "index.json"));
  if (
    !Array.isArray(index.failedReqs) ||
    index.failedReqs.length !== 1 ||
    index.failedReqs[0].st !== 500
  ) {
    throw new Error("index.json did not capture the failed request");
  }
  const candidates = await fs.readFile(
    path.join(sessionDir, "CANDIDATES.md"),
    "utf8",
  );
  if (!candidates.includes("HTTP 500"))
    throw new Error("CANDIDATES.md did not describe the failed request");

  const list = await fetchJson(`${baseUrl}/api/sessions`, {
    headers: { "X-Crumbtrail-Auth": authToken },
  });
  if (
    !list.response.ok ||
    !Array.isArray(list.body) ||
    !list.body.some((entry) => entry.id === sessionId)
  ) {
    throw new Error(
      "/api/sessions did not expose the finalized session summary",
    );
  }

  recordPhase(
    "self-host-artifact-proof",
    "pass",
    `session=${sessionId} artifacts=${requiredFiles.length}`,
  );
}

async function startInstalledServer(
  binPath,
  tempProjectDir,
  outputDir,
  staticDir,
  port,
) {
  recordPhase("binary-startup", "start", `port=${port}`);
  const output = { stdout: "", stderr: "" };
  const child = spawn(
    binPath,
    [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--output",
      outputDir,
      "--static",
      staticDir,
      "--allow-origin",
      allowedOrigin,
      "--auth-token",
      authToken,
    ],
    {
      cwd: tempProjectDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    },
  );

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output.stdout = boundedTail(output.stdout + chunk);
  });
  child.stderr.on("data", (chunk) => {
    output.stderr = boundedTail(output.stderr + chunk);
  });

  const healthUrl = `http://127.0.0.1:${port}/health`;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const healthBody = await waitForHealth(healthUrl, child, output);
    assertHealthyPayload(healthBody, outputDir, staticDir, port);
    if (!output.stdout.includes("Allowed browser origins: 1 configured")) {
      throw new Error(
        "startup diagnostics did not report allowed-origin count",
      );
    }
    if (
      !output.stdout.includes("Auth token protection enabled for /api/* routes")
    ) {
      throw new Error(
        "startup diagnostics did not report auth-token protection",
      );
    }
    if (
      output.stdout.includes(authToken) ||
      output.stderr.includes(authToken)
    ) {
      throw new Error("startup diagnostics leaked auth token content");
    }
    recordPhase("binary-startup", "pass");
    return { child, output, baseUrl };
  } catch (err) {
    await shutdownServer(child);
    fail("binary-startup", err, output);
  }
}

async function shutdownServer(child) {
  recordPhase("shutdown", "start");
  if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
  recordPhase("shutdown", "pass", `exitCode=${child.exitCode ?? "killed"}`);
}

async function main() {
  let tmpRoot;
  let child;
  try {
    tmpRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "crumbtrail-fresh-install-"),
    );
    const packDir = path.join(tmpRoot, "packed");
    const tempProjectDir = path.join(tmpRoot, "project");
    const staticDir = path.join(tmpRoot, "static");
    const outputDir = path.join(tmpRoot, "sessions");
    await fs.mkdir(packDir, { recursive: true });
    await fs.mkdir(tempProjectDir, { recursive: true });
    await fs.mkdir(staticDir, { recursive: true });
    await fs.writeFile(
      path.join(staticDir, "index.html"),
      "<!doctype html><title>Crumbtrail fresh install</title><h1>fresh install ok</h1>",
    );

    await assertPackageMetadata();
    // core must be built first so node's build can bundle it in.
    await runCommand("package-build", "pnpm", [
      "--filter",
      "crumbtrail-core",
      "build",
    ]);
    await runCommand("package-build", "pnpm", [
      "--filter",
      "crumbtrail-node",
      "build",
    ]);

    const coreTarball = await packPackage(coreRoot, packDir);
    const nodeTarball = await packPackage(nodeRoot, packDir);
    await assertPackedNodeDependency(
      nodeTarball,
      path.join(tmpRoot, "packed-node-manifest"),
    );
    await installTempProject(tempProjectDir, coreTarball, nodeTarball);
    await assertInstalledPackageMetadata(tempProjectDir);

    const binPath = await resolveInstalledBin(tempProjectDir);
    const port = await getFreePort();
    const started = await startInstalledServer(
      binPath,
      tempProjectDir,
      outputDir,
      staticDir,
      port,
    );
    child = started.child;
    await assertSelfHostArtifacts(started.baseUrl, outputDir);
    await shutdownServer(child);
    child = undefined;

    recordPhase("complete", "pass", `project=${tempProjectDir}`);
    console.log(
      "CRUMBTRAIL_FRESH_INSTALL_PASS phases=package-metadata,package-build,package-pack,temp-install,installed-package-metadata,binary-resolution,binary-startup,health-readiness,self-host-artifact-proof,shutdown",
    );
  } catch (err) {
    if (child) await shutdownServer(child).catch(() => undefined);
    fail("unexpected", err);
  } finally {
    if (tmpRoot)
      await fs
        .rm(tmpRoot, { recursive: true, force: true })
        .catch(() => undefined);
  }
}

main();
