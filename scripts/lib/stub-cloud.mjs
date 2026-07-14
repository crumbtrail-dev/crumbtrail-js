// Stub Crumbtrail cloud for the installer regression harness.
//
// Stands in for packages/cloud so the harness never touches the real deploy: it
// serves exactly the surface the setup wizard drives end-to-end —
//   · token probe / mint      GET  /api/projects, POST /api/cli/token, /device
//   · provision               POST /api/projects, /api/projects/:id/services,
//                             POST /api/services/:id/keys
//   · verify — synthetic      ingest recorder (POST /api/session/start|events|end)
//   · verify — real-event poll GET  /api/sessions  (startedAt-bearing rows)
//   · SDK tarball fallback    GET  /install/manifest.json, /install/<file>.tgz
//
// It can seed the on-disk auth cache (auth.json) so a non-TTY run skips login,
// and can seed sessions with explicit startedAt values so the wizardStart poll
// filter (verify.ts) can be exercised RED→GREEN.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function bearer(req) {
  const auth = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(Array.isArray(auth) ? auth[0] : auth);
  return m ? m[1] : undefined;
}

/**
 * The StoredAuth shape (packages/cli/src/auth.ts). Written to
 * <XDG_CONFIG_HOME>/crumbtrail/auth.json so ensureToken() reuses it and the
 * wizard skips the interactive login legs entirely.
 */
export function seedAuthCache(xdgConfigHome, { base, token, expiresAt }) {
  const dir = path.join(xdgConfigHome, "crumbtrail");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "auth.json");
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        token,
        expiresAt: expiresAt ?? "2099-01-01T00:00:00Z",
        endpoint: base,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  return file;
}

/**
 * @param {object} opts
 * @param {ReturnType<import('./stub-ingest.mjs').createIngestRecorder>} opts.ingest
 * @param {string} [opts.token] token every Bearer probe accepts (any Bearer ok if unset)
 * @param {string} [opts.projectId] project id echoed back on provision
 * @param {string} [opts.apiKey] ingest key minted on provision
 * @param {string} [opts.tarballsDir] dir holding pack-manifest.json + *.tgz (fix #5 fallback)
 */
export async function startStubCloud(opts) {
  const {
    ingest,
    token: seededToken,
    projectId = "prj_stub_0001",
    apiKey = "bl_key_stub000000000000000000000000",
    tarballsDir,
  } = opts;

  /** @type {Array<{id:string,startedAt:string,serviceId:string|null,serviceName:string|null,finalizedAt:string|null}>} */
  const sessions = [];
  let mintedToken = seededToken ?? "bl_cli_" + "s".repeat(48);
  let devicePolls = 0;
  /** GET /api/sessions count; read #0 is the poll's baseline snapshot. */
  let sessionsReads = 0;
  let autoRealMinted = false;

  const installManifest = () => {
    if (!tarballsDir) return undefined;
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(tarballsDir, "pack-manifest.json"), "utf8"),
      );
      const files = [raw.core, raw.node, raw.cli]
        .filter((p) => typeof p === "string")
        .map((p) => path.basename(p));
      if (files.length < 3) return undefined;
      return { schemaVersion: "install-manifest.v1", files };
    } catch {
      return undefined;
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub.local");
    const urlPath = url.pathname;
    const rawBody =
      req.method === "POST" || req.method === "PUT" ? await readBody(req) : "";

    if (ingest.handle(req, res, urlPath, rawBody)) return;

    // ── token probe + list ─────────────────────────────────────────────────
    if (req.method === "GET" && urlPath === "/api/projects") {
      const tok = bearer(req);
      const ok = seededToken ? tok === seededToken : Boolean(tok);
      if (!ok)
        return send(res, 401, { error: "unauthorized", code: "unauthorized" });
      return send(res, 200, {
        projects: [{ id: projectId, name: "stub-app" }],
      });
    }

    // ── provision ──────────────────────────────────────────────────────────
    if (req.method === "POST" && urlPath === "/api/projects") {
      const body = rawBody ? JSON.parse(rawBody) : {};
      return send(res, 200, { id: projectId, name: body.name ?? "stub-app" });
    }
    if (
      req.method === "POST" &&
      /^\/api\/projects\/[^/]+\/services$/.test(urlPath)
    ) {
      const body = rawBody ? JSON.parse(rawBody) : {};
      return send(res, 200, { id: "svc_stub_0001", name: body.name ?? "api" });
    }
    if (
      req.method === "POST" &&
      urlPath.match(/^\/api\/services\/([^/]+)\/keys$/)
    ) {
      return send(res, 200, { apiKey });
    }

    // ── login (device / browser token exchange) — unused when auth is seeded ─
    if (req.method === "POST" && urlPath === "/api/cli/device") {
      return send(res, 201, {
        deviceCode: "dev-code-stub",
        userCode: "STUB-0000",
        verificationUri: `${baseUrl}/cli/activate`,
        expiresIn: 300,
        interval: 1,
      });
    }
    if (req.method === "POST" && urlPath === "/api/cli/token") {
      const body = rawBody ? JSON.parse(rawBody) : {};
      if (body.deviceCode) devicePolls += 1;
      return send(res, 200, {
        token: mintedToken,
        expiresAt: "2099-01-01T00:00:00Z",
      });
    }

    // ── real-event poll ─────────────────────────────────────────────────────
    if (req.method === "GET" && urlPath === "/api/sessions") {
      // `autoRealSession` stands in for the user booting their wired app WHILE
      // the wizard waits. It must therefore appear only AFTER pollForRealEvent
      // has taken its baseline snapshot — the poll's first read (verify.ts).
      // Any session already present in that baseline is, by definition, not new,
      // so minting earlier (e.g. off the wizard's own synthetic cli-check POST)
      // buries the row in the baseline and the poll can never surface it.
      if (opts.autoRealSession && sessionsReads > 0 && !autoRealMinted) {
        autoRealMinted = true;
        sessions.push({
          id: `ses_stub_real_${Date.now()}`,
          startedAt: new Date().toISOString(),
          serviceId: null,
          serviceName: null,
          finalizedAt: null,
        });
      }
      sessionsReads += 1;
      const rows = [...sessions].sort((a, b) =>
        a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0,
      );
      return send(res, 200, {
        sessions: rows,
        pagination: { limit: rows.length, offset: 0 },
      });
    }

    // ── SDK tarball fallback (fix #5) ───────────────────────────────────────
    if (req.method === "GET" && urlPath === "/install/manifest.json") {
      const manifest = installManifest();
      if (!manifest) return send(res, 404, { error: "not found" });
      return send(res, 200, manifest);
    }
    if (req.method === "GET" && urlPath.startsWith("/install/")) {
      const file = decodeURIComponent(urlPath.slice("/install/".length));
      const manifest = installManifest();
      if (!manifest || !manifest.files.includes(file) || !tarballsDir) {
        return send(res, 404, { error: "not found" });
      }
      const filePath = path.join(tarballsDir, file);
      if (!fs.existsSync(filePath))
        return send(res, 404, { error: "not found" });
      res.writeHead(200, {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${file}"`,
      });
      res.end(fs.readFileSync(filePath));
      return;
    }

    send(res, 404, { error: "not found", code: "not_found" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    port,
    projectId,
    apiKey,
    token: mintedToken,
    sessions,
    get devicePolls() {
      return devicePolls;
    },
    /** Seed one session row with an explicit startedAt (ISO or epoch-ms number). */
    seedSession({ id, startedAt, serviceId = null, serviceName = null }) {
      const iso =
        typeof startedAt === "number"
          ? new Date(startedAt).toISOString()
          : startedAt;
      sessions.push({
        id,
        startedAt: iso,
        serviceId,
        serviceName,
        finalizedAt: iso,
      });
    },
    async stop() {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}
