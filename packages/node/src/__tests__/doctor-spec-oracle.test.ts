import { describe, expect, it } from "vitest";
import { checkSpecOracle } from "../doctor";
import {
  CONFLUENCE_API_TOKEN_ENV,
  CONFLUENCE_BASE_URL_ENV,
  CONFLUENCE_EMAIL_ENV,
  CONFLUENCE_SPACE_KEYS_ENV,
} from "../knowledge";

/**
 * `checkSpecOracle` is the only shipped behavior in the spec-oracle checkpoint
 * that is not itself a guard, so it gets the same rigor the checkpoint applies
 * to `knowledge/`.
 *
 * The credential-leak assertions at the bottom are the load-bearing ones: the
 * detail string is built from `${origin}${pathname}`, and a refactor to
 * `parsed.href` (or dropping the sanitizer entirely) would leak both userinfo
 * and query-string credentials into the doctor report. Those tests fail on that
 * refactor; a shape-only test would not.
 */

const configured = (): Record<string, string | undefined> => ({
  [CONFLUENCE_BASE_URL_ENV]: "https://acme.atlassian.net/wiki",
  [CONFLUENCE_EMAIL_ENV]: "ops@acme.example",
  [CONFLUENCE_API_TOKEN_ENV]: "confluence-token",
});

/** Every string a `DoctorCheck` can surface to an operator, concatenated. */
function emitted(check: {
  name: string;
  detail: string;
  remediation?: string;
}): string {
  return [check.name, check.detail, check.remediation ?? ""].join("\n");
}

describe("checkSpecOracle — warn branch", () => {
  it("warns with every required var named when nothing is set", () => {
    const check = checkSpecOracle({});
    expect(check.name).toBe("spec-oracle");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain(CONFLUENCE_BASE_URL_ENV);
    expect(check.detail).toContain(CONFLUENCE_EMAIL_ENV);
    expect(check.detail).toContain(CONFLUENCE_API_TOKEN_ENV);
    expect(check.remediation).toBeTruthy();
  });

  it.each([
    CONFLUENCE_BASE_URL_ENV,
    CONFLUENCE_EMAIL_ENV,
    CONFLUENCE_API_TOKEN_ENV,
  ])("warns naming only %s when only that var is missing", (missing) => {
    const env = configured();
    delete env[missing];

    const check = checkSpecOracle(env);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain(missing);

    const others = [
      CONFLUENCE_BASE_URL_ENV,
      CONFLUENCE_EMAIL_ENV,
      CONFLUENCE_API_TOKEN_ENV,
    ].filter((name) => name !== missing);
    for (const name of others) {
      expect(check.detail).not.toContain(`missing ${name}`);
    }
  });

  it.each([
    CONFLUENCE_BASE_URL_ENV,
    CONFLUENCE_EMAIL_ENV,
    CONFLUENCE_API_TOKEN_ENV,
  ])("treats an empty %s as missing, as the doc promises", (name) => {
    // `confluence-spec-oracle.md`: "configured iff all three required variables
    // are set to non-empty strings".
    const env = { ...configured(), [name]: "" };
    const check = checkSpecOracle(env);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain(name);
  });

  it("does not warn merely because the optional space allowlist is unset", () => {
    expect(checkSpecOracle(configured()).status).toBe("pass");
  });

  it.each(["", " , , ", "BAD!"])(
    "warns when a configured allowlist has no valid keys (%j)",
    (spaceKeys) => {
      const check = checkSpecOracle({
        ...configured(),
        [CONFLUENCE_SPACE_KEYS_ENV]: spaceKeys,
      });

      expect(check.status).toBe("warn");
      expect(check.detail).toContain(CONFLUENCE_SPACE_KEYS_ENV);
      expect(check.detail).not.toContain("all readable spaces");
      expect(check.remediation).toContain("alphanumeric or underscore");
      expect(emitted(check)).not.toContain("confluence-token");
    },
  );

  it("warns when a configured allowlist mixes valid and malformed keys", () => {
    const check = checkSpecOracle({
      ...configured(),
      [CONFLUENCE_SPACE_KEYS_ENV]: "ENG,BAD!",
    });

    expect(check.status).toBe("warn");
    expect(check.detail).toContain(CONFLUENCE_SPACE_KEYS_ENV);
    expect(check.detail).not.toContain("space allowlist: ENG");
    expect(check.detail).not.toContain("all readable spaces");
    expect(check.remediation).toContain("alphanumeric or underscore");
    expect(emitted(check)).not.toContain("BAD!");
  });
});

describe("checkSpecOracle — pass branch", () => {
  it("passes and reports the parsed allowlist when CONFLUENCE_SPACE_KEYS is set", () => {
    const check = checkSpecOracle({
      ...configured(),
      [CONFLUENCE_SPACE_KEYS_ENV]: "ENG,OPS",
    });

    expect(check.status).toBe("pass");
    expect(check.detail).toContain("https://acme.atlassian.net/wiki");
    expect(check.detail).toContain("space allowlist: ENG, OPS");
    expect(check.remediation).toBeUndefined();
  });

  it("passes and says all readable spaces are in scope without an allowlist", () => {
    const check = checkSpecOracle(configured());
    expect(check.status).toBe("pass");
    expect(check.detail).toContain(CONFLUENCE_SPACE_KEYS_ENV);
    expect(check.detail).toContain("all readable spaces are in scope");
  });

  it("distinguishes 'configured' from checkEvidenceSources' 'authenticated'", () => {
    // `cli.ts` renders both statuses with the same ✓; the detail is the only
    // place the weaker claim can be stated.
    expect(checkSpecOracle(configured()).detail).toContain(
      "(credentials not verified)",
    );
  });
});

describe("checkSpecOracle — base URL sanitizing", () => {
  it("never reaches the sanitizer's unset branch, because presence is checked first", () => {
    // The sanitizer's `!raw` guard is defense in depth, not a live path: an
    // unset or empty CONFLUENCE_BASE_URL is rejected by the presence check
    // above it, so the report warns instead of describing a URL. Pinned so a
    // future reordering that made the sanitizer authoritative shows up here.
    const env = configured();
    delete env[CONFLUENCE_BASE_URL_ENV];

    const check = checkSpecOracle(env);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain(CONFLUENCE_BASE_URL_ENV);
    expect(emitted(check)).not.toContain("base URL");
    expect(emitted(check)).not.toContain("undefined");
  });

  it("describes a whitespace-only base URL rather than printing 'undefined'", () => {
    // Non-empty, so it clears the presence check and does reach the sanitizer.
    const check = checkSpecOracle({
      ...configured(),
      [CONFLUENCE_BASE_URL_ENV]: "   ",
    });
    expect(check.status).toBe("pass");
    expect(check.detail).toContain("an unparseable base URL");
    expect(check.detail).not.toContain("undefined");
  });

  it("describes an unparseable base URL rather than echoing it", () => {
    const check = checkSpecOracle({
      ...configured(),
      [CONFLUENCE_BASE_URL_ENV]: "not-a-url",
    });
    expect(check.status).toBe("pass");
    expect(check.detail).toContain("an unparseable base URL");
    expect(check.detail).not.toContain("not-a-url");
  });

  it("reduces a normal base URL to origin + path", () => {
    const check = checkSpecOracle({
      ...configured(),
      [CONFLUENCE_BASE_URL_ENV]: "https://acme.atlassian.net/wiki",
    });
    expect(check.detail).toContain("https://acme.atlassian.net/wiki");
  });

  it("never emits a userinfo credential from the base URL", () => {
    const check = checkSpecOracle({
      ...configured(),
      [CONFLUENCE_BASE_URL_ENV]: "https://user:SECRET@acme.atlassian.net/wiki",
    });

    const text = emitted(check);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("user:");
    expect(text).not.toContain("@acme.atlassian.net");
    expect(check.detail).toContain("https://acme.atlassian.net/wiki");
  });

  it("never emits a query-string credential from the base URL", () => {
    const check = checkSpecOracle({
      ...configured(),
      [CONFLUENCE_BASE_URL_ENV]:
        "https://acme.atlassian.net/wiki?token=SECRET&api_key=ALSO_SECRET",
    });

    const text = emitted(check);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("ALSO_SECRET");
    expect(text).not.toContain("token=");
    expect(text).not.toContain("?");
    expect(check.detail).toContain("https://acme.atlassian.net/wiki");
  });

  it("never echoes CONFLUENCE_API_TOKEN's value in either branch", () => {
    const passing = checkSpecOracle({
      ...configured(),
      [CONFLUENCE_API_TOKEN_ENV]: "SECRET-TOKEN-VALUE",
    });
    const warning = checkSpecOracle({
      ...configured(),
      [CONFLUENCE_API_TOKEN_ENV]: "",
      [CONFLUENCE_EMAIL_ENV]: "",
    });

    expect(emitted(passing)).not.toContain("SECRET-TOKEN-VALUE");
    expect(emitted(warning)).not.toContain("SECRET-TOKEN-VALUE");
  });
});
