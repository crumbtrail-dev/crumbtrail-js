import type { Symptom } from "crumbtrail-core";
import {
  jiraToSymptom,
  zendeskToSymptom,
  trelloToSymptom,
  type TicketProvider,
} from "./normalize";

export interface TicketConnector {
  fetchSymptom(id: string): Promise<Symptom>;
}

/**
 * Extension of TicketConnector for providers that can write an advisory
 * comment back to the ticket. Declared as a separate interface (not an
 * optional method on TicketConnector) so read-only connectors stay honest and
 * callers that need commenting — the cloud webhook writer — type against the
 * capability explicitly (contract decision #10).
 */
export interface CommentingTicketConnector extends TicketConnector {
  postComment(
    ticketKey: string,
    adfBody: unknown,
    retry?: BoundedRetryOptions,
  ): Promise<void>;
}

/** Thrown when a ticket provider REST call fails, or required env config is missing (status 0). */
export class TicketError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TicketError";
    this.status = status;
  }
}

/**
 * Source-identification User-Agent sent on EVERY outbound integration request.
 * Atlassian's third-party app guidance requires apps to "identify their source
 * transparently"; a stable, descriptive UA is how a Jira/Confluence admin (and
 * Atlassian's own abuse tooling) can attribute traffic to Crumbtrail. Applied to
 * Zendesk/Trello too for consistency. Kept version-light on purpose so it does
 * not churn every release — it identifies the source, not an exact build.
 */
export const CRUMBTRAIL_USER_AGENT =
  "Crumbtrail/0.1 (+https://crumbtrail.ai; integrations@crumbtrail.ai)";

/** Strip query params and userinfo from a url before it can reach a log or error message. */
function sanitizeUrl(u: string): string {
  try {
    const p = new URL(u);
    return `${p.origin}${p.pathname}`;
  } catch {
    return u.split("?")[0];
  }
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const res = await fetchImpl(url, {
    headers: { "User-Agent": CRUMBTRAIL_USER_AGENT, ...headers },
  });
  if (!res.ok) {
    throw new TicketError(
      res.status,
      `Ticket fetch failed with HTTP ${res.status}: ${sanitizeUrl(url)}`,
    );
  }
  return res.json();
}

/** Options for {@link withBoundedRetry}. All fields optional; production callers
 *  rely on the defaults, tests inject `baseDelayMs: 0`/a fake `sleep` to run fast. */
export interface BoundedRetryOptions {
  /** Total attempts (not extra retries). Default 3. */
  attempts?: number;
  /** Linear backoff base; the wait before attempt N is `baseDelayMs * (N-1)`. */
  baseDelayMs?: number;
  /** Decide whether a thrown error is worth retrying. Default: transient only. */
  isRetryable?: (error: unknown) => boolean;
  /** Sleep hook (overridable in tests). Default: real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Transient outbound failures worth retrying: a network/connection error (any
 * non-TicketError thrown by fetch) or a 429/5xx from the API. A hard 4xx
 * (auth/not-found/bad-request) will not get better on retry, so it is not
 * retried — mirroring how Jira itself only retries 408/409/425/429/5xx.
 */
function isTransientTicketError(error: unknown): boolean {
  if (error instanceof TicketError) {
    return error.status === 429 || error.status >= 500;
  }
  return true;
}

/**
 * Run `fn` with a small bounded retry (default 3 attempts, short linear
 * backoff). Re-throws the last error once attempts are exhausted or the error is
 * non-retryable. Deliberately tiny — no queue, no jitter; comment posting is the
 * one caller and a v1 best-effort write.
 */
export async function withBoundedRetry<T>(
  fn: () => Promise<T>,
  options: BoundedRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const isRetryable = options.isRetryable ?? isTransientTicketError;
  const sleep = options.sleep ?? realSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryable(error)) throw error;
      await sleep(baseDelayMs * attempt);
    }
  }
  throw lastError;
}

/** HTTP Basic auth: Atlassian API token bound to an account email
 *  (`email:token`, base64). This is the self-host / API-token path. */
export interface JiraBasicAuth {
  type: "basic";
  email: string;
  apiToken: string;
}

/** OAuth 3LO bearer auth: a short-lived access token. Per Atlassian, OAuth API
 *  calls go to `https://api.atlassian.com/ex/jira/{cloudId}` (NOT the
 *  `*.atlassian.net` site base) with `Authorization: Bearer <accessToken>`; the
 *  caller sets `baseUrl` accordingly. The client never refreshes — the cloud
 *  connector boundary hands in an already-valid access token. */
export interface JiraBearerAuth {
  type: "bearer";
  accessToken: string;
}

export type JiraAuth = JiraBasicAuth | JiraBearerAuth;

/** Legacy positional shape — kept byte-compatible so existing callers
 *  (ticketClientFromEnv, self-host) construct exactly as before. */
export interface JiraTicketClientConfigLegacy {
  baseUrl: string;
  email: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
}

/** Discriminated-auth shape (basic OR bearer) with an explicit baseUrl. */
export interface JiraTicketClientConfigWithAuth {
  baseUrl: string;
  auth: JiraAuth;
  fetchImpl?: typeof fetch;
}

export type JiraTicketClientConfig =
  | JiraTicketClientConfigLegacy
  | JiraTicketClientConfigWithAuth;

function hasAuth(
  config: JiraTicketClientConfig,
): config is JiraTicketClientConfigWithAuth {
  return "auth" in config && config.auth != null;
}

export class JiraTicketClient implements CommentingTicketConnector {
  private baseUrl: string;
  private auth: JiraAuth;
  private fetchImpl: typeof fetch;

  constructor(config: JiraTicketClientConfig) {
    this.baseUrl = config.baseUrl;
    // Accept BOTH shapes: the discriminated { auth } union and the legacy
    // { email, apiToken } positional form (which is Basic auth). Existing
    // self-host / env callers keep working unchanged.
    this.auth = hasAuth(config)
      ? config.auth
      : { type: "basic", email: config.email, apiToken: config.apiToken };
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** The Authorization header value for the configured auth mode. The secret
   *  (token/access token) only ever lives inside this header string — it is
   *  never surfaced in an error message (only sanitized URLs are). */
  private authHeader(): string {
    if (this.auth.type === "bearer") return `Bearer ${this.auth.accessToken}`;
    const basic = Buffer.from(
      `${this.auth.email}:${this.auth.apiToken}`,
    ).toString("base64");
    return `Basic ${basic}`;
  }

  async fetchSymptom(id: string): Promise<Symptom> {
    const payload = await getJson(
      `${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(id)}`,
      { Authorization: this.authHeader() },
      this.fetchImpl,
    );
    return jiraToSymptom(payload);
  }

  /**
   * POST an advisory comment to a Jira issue. `adfBody` is an Atlassian Document
   * Format doc (see buildAdvisoryComment); it is sent as `{ body: <adf> }`.
   * Wrapped in a small bounded retry so a transient 5xx/429/network blip does not
   * drop the comment. Throws TicketError on a non-2xx that survives the retries —
   * the API token never appears in the message (only the sanitized URL does).
   */
  async postComment(
    issueIdOrKey: string,
    adfBody: unknown,
    retry?: BoundedRetryOptions,
  ): Promise<void> {
    const url = `${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/comment`;
    await withBoundedRetry(async () => {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "User-Agent": CRUMBTRAIL_USER_AGENT,
          Authorization: this.authHeader(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body: adfBody }),
      });
      if (!res.ok) {
        throw new TicketError(
          res.status,
          `Jira comment post failed with HTTP ${res.status}: ${sanitizeUrl(url)}`,
        );
      }
    }, retry);
  }
}

export interface ZendeskTicketClientConfig {
  subdomain: string;
  email: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
}

export class ZendeskTicketClient implements TicketConnector {
  private subdomain: string;
  private email: string;
  private apiToken: string;
  private fetchImpl: typeof fetch;

  constructor(config: ZendeskTicketClientConfig) {
    this.subdomain = config.subdomain;
    this.email = config.email;
    this.apiToken = config.apiToken;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async fetchSymptom(id: string): Promise<Symptom> {
    const auth = Buffer.from(`${this.email}/token:${this.apiToken}`).toString(
      "base64",
    );
    const payload = await getJson(
      `https://${this.subdomain}.zendesk.com/api/v2/tickets/${id}.json`,
      { Authorization: `Basic ${auth}` },
      this.fetchImpl,
    );
    return zendeskToSymptom(payload);
  }
}

export interface TrelloTicketClientConfig {
  key: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export class TrelloTicketClient implements TicketConnector {
  private key: string;
  private token: string;
  private fetchImpl: typeof fetch;

  constructor(config: TrelloTicketClientConfig) {
    this.key = config.key;
    this.token = config.token;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async fetchSymptom(id: string): Promise<Symptom> {
    const payload = await getJson(
      `https://api.trello.com/1/cards/${id}?key=${this.key}&token=${this.token}`,
      {},
      this.fetchImpl,
    );
    return trelloToSymptom(payload);
  }
}

function requireEnv(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name];
  if (!value) {
    throw new TicketError(0, `Missing required env var: ${name}`);
  }
  return value;
}

/** Build a `TicketConnector` for `provider` from the documented env vars. Throws `TicketError` naming the first missing var. */
export function ticketClientFromEnv(
  provider: TicketProvider,
  env: Record<string, string | undefined> = process.env,
): TicketConnector {
  switch (provider) {
    case "jira":
      return new JiraTicketClient({
        baseUrl: requireEnv(env, "JIRA_BASE_URL"),
        email: requireEnv(env, "JIRA_EMAIL"),
        apiToken: requireEnv(env, "JIRA_API_TOKEN"),
      });
    case "zendesk":
      return new ZendeskTicketClient({
        subdomain: requireEnv(env, "ZENDESK_SUBDOMAIN"),
        email: requireEnv(env, "ZENDESK_EMAIL"),
        apiToken: requireEnv(env, "ZENDESK_API_TOKEN"),
      });
    case "trello":
      return new TrelloTicketClient({
        key: requireEnv(env, "TRELLO_KEY"),
        token: requireEnv(env, "TRELLO_TOKEN"),
      });
    default:
      throw new TypeError(`Unknown ticket provider: ${String(provider)}`);
  }
}
