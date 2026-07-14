// Minimal Playwright chromium page loader for the installer regression harness.
//
// Frontend recipes (Next, etc.) can only be proven by loading the BUILT app in a
// real browser: the injected client init has to actually execute and push an
// authed session (+ a captured reproduction window) at the ingest stub. This
// helper is deliberately tiny — launch headless chromium, load the URL, provoke
// one uncaught error so PRESET_PASSIVE's autoFlagOnError captures + flushes an
// event batch, wait for the flush, then tear the browser down.
//
// It uses the repo-root `playwright` dependency (chromium browser already in the
// ms-playwright cache). No new dependency is added.

import { chromium } from "playwright";

/**
 * Load `url` in headless chromium and (by default) trigger a client error so the
 * wired SDK flushes at least one event batch.
 *
 * @param {object} opts
 * @param {string} opts.url                 the running app URL to load
 * @param {boolean} [opts.triggerError]     throw an uncaught error to exercise autoFlagOnError (default true)
 * @param {number} [opts.settleMs]          how long to wait after load/trigger for the flush (default 3500)
 * @param {number} [opts.navTimeoutMs]      goto timeout (default 30000)
 * @returns {Promise<{ html: string, pageErrors: string[] }>}
 */
export async function loadAndCapture(opts) {
  const {
    url,
    triggerError = true,
    settleMs = 3500,
    navTimeoutMs = 30_000,
  } = opts;

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    /** @type {string[]} */
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    // Opt-in diagnostics for a headless run that captured nothing.
    if (process.env.BL_BROWSER_DEBUG) {
      page.on("console", (m) => console.log("  [console]", m.type(), m.text()));
      page.on("requestfailed", (r) =>
        console.log("  [reqfailed]", r.url(), r.failure()?.errorText),
      );
      page.on("request", (r) => console.log("  [req]", r.method(), r.url()));
    }

    await page.goto(url, { waitUntil: "load", timeout: navTimeoutMs });
    const html = await page.content();

    if (triggerError) {
      // A real uncaught error: the window 'error' collector records it and
      // autoFlagOnError flags a bug, which flushes the captured events batch.
      await page.evaluate(() => {
        setTimeout(() => {
          throw new Error("bl-installer-harness-trigger");
        }, 0);
      });
      // A stray click as a second, behavioral nudge (rage-click signals).
      await page.mouse.click(20, 20).catch(() => {});
    }

    await page.waitForTimeout(settleMs);
    return { html, pageErrors };
  } finally {
    await browser.close();
  }
}
