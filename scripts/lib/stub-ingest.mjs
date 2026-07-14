// In-memory ingest recorder for the installer regression harness.
//
// Records every ingest request (method / path / headers / body) the driven CLI
// (or, in CP1+, the wired SDK) pushes at the stub cloud, and exposes assert
// helpers the orchestrator uses to prove an AUTHED session reached ingest:
//   · POST /api/session/start was seen
//   · at least one event batch (POST /api/events) landed
//   · the ingest auth header (X-Crumbtrail-Auth) was present
//
// This module owns only the ingest surface; stub-cloud.mjs mounts it and layers
// the token / provision / sessions / install-tarball routes around it.

/** Case-insensitive header lookup against a node req.headers bag. */
function header(headers, name) {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === lower) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

export function createIngestRecorder() {
  /** @type {Array<{method:string,path:string,headers:Record<string,unknown>,auth:string|undefined,body:unknown}>} */
  const records = [];

  /**
   * Handle an ingest request. Returns true when this recorder claimed the path
   * (so stub-cloud stops walking its route list), false otherwise.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} urlPath
   * @param {string} rawBody
   */
  function handle(req, res, urlPath, rawBody) {
    const ingestPaths = new Set([
      "/api/session/start",
      "/api/events",
      "/api/session/end",
    ]);
    if (req.method !== "POST" || !ingestPaths.has(urlPath)) return false;

    let body;
    try {
      body = rawBody ? JSON.parse(rawBody) : undefined;
    } catch {
      body = rawBody;
    }
    records.push({
      method: req.method,
      path: urlPath,
      headers: req.headers,
      auth: header(req.headers, "x-crumbtrail-auth"),
      body,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  const seen = (urlPath) => records.filter((r) => r.path === urlPath);

  return {
    records,
    handle,
    /** Every recorded request for a path. */
    seen,
    /** POST /api/session/start was received at least once. */
    assertSessionStartSeen() {
      if (seen("/api/session/start").length === 0) {
        throw new Error(
          "ingest assertion failed: no POST /api/session/start reached the stub",
        );
      }
    },
    /** At least one event batch (POST /api/events) with a non-empty `events` array. */
    assertEventBatchSeen() {
      const batches = seen("/api/events").filter(
        (r) => Array.isArray(r.body?.events) && r.body.events.length > 0,
      );
      if (batches.length === 0) {
        throw new Error(
          "ingest assertion failed: no non-empty event batch reached the stub",
        );
      }
    },
    /** Every recorded ingest request carried the X-Crumbtrail-Auth header. */
    assertAuthPresent() {
      const ingest = records.filter((r) => r.path !== undefined);
      if (ingest.length === 0) {
        throw new Error(
          "ingest assertion failed: no ingest requests recorded at all",
        );
      }
      const missing = ingest.filter((r) => !r.auth);
      if (missing.length > 0) {
        throw new Error(
          `ingest assertion failed: ${missing.length} ingest request(s) missing X-Crumbtrail-Auth`,
        );
      }
    },
    /** The auth key value carried on the first recorded ingest request. */
    firstAuthKey() {
      return records.find((r) => r.auth)?.auth;
    },
  };
}
