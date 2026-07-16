import { describe, expect, it } from "vitest";
import {
  DEFAULT_APP_URL,
  DEFAULT_ENDPOINT,
  dashboardBase,
  normalizeBase,
  resolveEndpoint,
} from "../net";

describe("resolveEndpoint", () => {
  it("prefers the --endpoint flag, then env, then the default", () => {
    expect(resolveEndpoint("https://flag.example/", {})).toBe(
      "https://flag.example",
    );
    expect(
      resolveEndpoint(null, { CRUMBTRAIL_BASE_URL: "https://env.example/" }),
    ).toBe("https://env.example");
    expect(resolveEndpoint(null, {})).toBe(DEFAULT_ENDPOINT);
  });
});

describe("dashboardBase", () => {
  it("rewrites the default API host to the app host that serves the SPA", () => {
    // The CLI talks to api.crumbtrail.ai, but the browser dashboard (mint key,
    // /bugs, session deep-links) lives on the app host — never send the user to
    // the API host, which never returns the SPA shell.
    expect(dashboardBase(DEFAULT_ENDPOINT)).toBe(DEFAULT_APP_URL);
    expect(dashboardBase(`${DEFAULT_ENDPOINT}/`)).toBe(DEFAULT_APP_URL);
  });

  it("leaves a custom endpoint untouched (self-host serves both from one origin)", () => {
    expect(dashboardBase("https://cloud.example")).toBe("https://cloud.example");
    expect(dashboardBase(normalizeBase("https://cloud.example/"))).toBe(
      "https://cloud.example",
    );
  });
});
