import { defaultSessionStore } from "./session-store";

export interface McpReadStore {
  listSessions(): Promise<Array<{ id: string; dir: string }>>;
  resolveSessionDir(sessionId: string): Promise<string>;
  readArtifact(sessionDir: string, name: string): Promise<Buffer | undefined>;
  statArtifact(
    sessionDir: string,
    name: string,
  ): Promise<{ bytes: number; isDir: boolean } | undefined>;
}

export class FilesystemMcpReadStore implements McpReadStore {
  constructor(private readonly outputDir: string) {}

  async listSessions(): Promise<Array<{ id: string; dir: string }>> {
    return defaultSessionStore.listSessions(this.outputDir);
  }

  async resolveSessionDir(sessionId: string): Promise<string> {
    return defaultSessionStore.resolveSessionDir(sessionId, this.outputDir);
  }

  async readArtifact(
    sessionDir: string,
    name: string,
  ): Promise<Buffer | undefined> {
    return defaultSessionStore.readArtifact(sessionDir, name);
  }

  async statArtifact(
    sessionDir: string,
    name: string,
  ): Promise<{ bytes: number; isDir: boolean } | undefined> {
    return defaultSessionStore.statArtifact(sessionDir, name);
  }
}

interface RemoteMcpReadStoreConfig {
  baseUrl: string;
  token: string;
  /** Test seam for a short failure budget; production uses 15 seconds. */
  timeoutMs?: number;
}

export class RemoteMcpReadStore implements McpReadStore {
  private static readonly MAX_BODY_BYTES = 16 * 1024 * 1024;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor({
    baseUrl,
    token,
    timeoutMs = 15_000,
  }: RemoteMcpReadStoreConfig) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async listSessions(): Promise<Array<{ id: string; dir: string }>> {
    const sessions: Array<{ id: string; dir: string }> = [];
    const limit = 100;

    try {
      for (let page = 0; page < 50; page += 1) {
        const body = await this.fetchBody(
          `/api/agent/sessions?limit=${limit}&offset=${page * limit}`,
        );
        if (!body) return [];
        const payload: unknown = JSON.parse(body.toString("utf-8"));
        if (
          typeof payload !== "object" ||
          payload === null ||
          !Array.isArray((payload as { sessions?: unknown }).sessions)
        ) {
          return [];
        }

        const pageSessions = (payload as { sessions: unknown[] }).sessions;
        sessions.push(
          ...pageSessions
            .filter(
              (session): session is { id: string } =>
                typeof session === "object" &&
                session !== null &&
                typeof (session as { id?: unknown }).id === "string",
            )
            .map((session) => ({ id: session.id, dir: session.id })),
        );
        if (pageSessions.length < limit) return sessions;
      }
      return sessions;
    } catch {
      return [];
    }
  }

  async resolveSessionDir(sessionId: string): Promise<string> {
    return sessionId;
  }

  async readArtifact(
    sessionId: string,
    name: string,
  ): Promise<Buffer | undefined> {
    return this.fetchBody(this.artifactPath(sessionId, name));
  }

  async statArtifact(
    sessionId: string,
    name: string,
  ): Promise<{ bytes: number; isDir: boolean } | undefined> {
    const path = this.artifactPath(sessionId, name);
    const head = await this.fetchHead(path);
    if (!head) return undefined;

    const headerBytes = this.contentLength(head);
    if (headerBytes !== undefined) {
      return headerBytes <= RemoteMcpReadStore.MAX_BODY_BYTES
        ? { bytes: headerBytes, isDir: false }
        : undefined;
    }

    // No Content-Length came back, so the endpoint answered with chunked
    // framing and the size is only knowable by downloading the artifact. This
    // fallback pays for a SECOND request and streams the whole body just to
    // measure it, so it is a real cost, not a formality: it stays bounded and
    // timed rather than trusting an unbounded response.
    //
    // Crumbtrail's own cloud declares the length and takes the cheap path
    // above; it did not always, and the omission silently doubled every stat.
    // This path is for endpoints that still omit the header.
    const bytes = await this.fetchBody(path, "byteLength");
    return bytes === undefined ? undefined : { bytes, isDir: false };
  }

  private artifactPath(
    sessionId: string,
    name: string,
  ): string {
    return `/api/agent/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(name)}`;
  }

  /**
   * Stats an artifact with a GET that is discarded after the headers arrive.
   *
   * The agent router answers GET only and rejects every other method at entry,
   * so a HEAD stat can never succeed against it. fetch() resolves at the
   * headers, so the caller still only pays for the header round trip — but the
   * body MUST be cancelled here rather than buffered, otherwise a stalled or
   * oversized artifact would hang the stat or hold the socket open.
   */
  private async fetchHead(path: string): Promise<Response | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await globalThis.fetch(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.token}` },
        signal: controller.signal,
      });
      // Headers are all this stat consumes; drop the body without reading it.
      void response.body?.cancel().catch(() => undefined);
      return response.status === 200 ? response : undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  private fetchBody(path: string): Promise<Buffer | undefined>;
  private fetchBody(path: string, mode: "byteLength"): Promise<number | undefined>;
  private async fetchBody(
    path: string,
    mode: "buffer" | "byteLength" = "buffer",
  ): Promise<Buffer | number | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await globalThis.fetch(`${this.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: controller.signal,
      });
      if (!response.ok || this.exceedsBodyLimit(response)) {
        void response.body?.cancel().catch(() => undefined);
        return undefined;
      }
      return mode === "buffer"
        ? await this.readBoundedBody(response)
        : await this.readBoundedBodyByteLength(response);
    } catch {
      return undefined;
    } finally {
      // The deadline deliberately remains armed while the response stream is
      // consumed. fetch() only resolves at headers, while a body can stall.
      clearTimeout(timeout);
    }
  }

  private contentLength(response: Response): number | undefined {
    const value = response.headers.get("content-length");
    if (value === null) return undefined;
    const bytes = Number(value);
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
  }

  private exceedsBodyLimit(response: Response): boolean {
    const bytes = this.contentLength(response);
    return bytes !== undefined && bytes > RemoteMcpReadStore.MAX_BODY_BYTES;
  }

  private async readBoundedBody(
    response: Response,
  ): Promise<Buffer | undefined> {
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > RemoteMcpReadStore.MAX_BODY_BYTES) {
          await reader.cancel();
          return undefined;
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, bytes);
    } finally {
      reader.releaseLock();
    }
  }

  private async readBoundedBodyByteLength(
    response: Response,
  ): Promise<number | undefined> {
    if (!response.body) return 0;
    const reader = response.body.getReader();
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return bytes;
        bytes += value.byteLength;
        if (bytes > RemoteMcpReadStore.MAX_BODY_BYTES) {
          await reader.cancel();
          return undefined;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

export function selectMcpReadStore(outputDir: string): McpReadStore {
  const baseUrl = process.env.CRUMBTRAIL_CLOUD_URL;
  const token = process.env.CRUMBTRAIL_CLOUD_TOKEN;
  if (baseUrl && token) return new RemoteMcpReadStore({ baseUrl, token });
  return new FilesystemMcpReadStore(outputDir);
}
