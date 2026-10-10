// Diagnostic: open the live GUI and capture what happens to the four plugin
// client bundles — console errors, page errors, and whether their boot entries
// register.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const CDP_PORT = 9417;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PLUGINS = ["dsh-pathlink", "dsh-bookmarks", "dsh-quota-hub", "dsh-delegate-router"];

const profile = mkdtempSync(join(tmpdir(), "dsh-boot-diag-"));
const edge = spawn(EDGE, [
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  "--headless=new", "--disable-gpu", "--window-size=1500,950", "about:blank",
], { stdio: "ignore" });

try {
  let browser = null;
  for (let i = 0; i < 60 && !browser; i++) {
    try {
      await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
      browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP_PORT}`, protocolTimeout: 180000 });
    } catch { await sleep(500); }
  }
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  const logs = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${String(e).slice(0, 300)}`));
  page.on("requestfailed", (r) => logs.push(`[requestfailed] ${r.url().slice(0, 160)} ${r.failure()?.errorText ?? ""}`));

  await page.goto("http://127.0.0.1:3737/", { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(12000);

  // 1) are the four client bundles served?
  const served = await page.evaluate(async (names) => {
    const out = {};
    for (const name of names) {
      try {
        const res = await fetch(`/plugins/${name}/client.js`, { cache: "no-store" });
        const text = await res.text();
        out[name] = { status: res.status, bytes: text.length, head: text.slice(0, 60) };
      } catch (error) {
        out[name] = { status: "fetch-failed", error: String(error).slice(0, 120) };
      }
    }
    return out;
  }, PLUGINS);
  console.log("SERVED:", JSON.stringify(served, null, 1));

  // 2) did the client kernel register them?
  const loader = await page.evaluate((names) => {
    const loader = window.__ModuleLoader__;
    const out = { hasLoader: typeof loader === "object" && loader !== null, keys: loader ? Object.keys(loader) : [] };
    try {
      out.registered = names.map((name) => ({ name, ok: typeof loader?.has === "function" ? loader.has(name) : "unknown" }));
    } catch (error) {
      out.lookupError = String(error);
    }
    return out;
  }, PLUGINS);
  console.log("LOADER:", JSON.stringify(loader));

  // 3) DOM signals each client half installs
  const signals = await page.evaluate(() => ({
    pathlinkStyle: document.getElementById("dshpl-style") !== null,
    hasToast: document.getElementById("dshpl-toast") !== null,
    bodyTextSample: document.body.innerText.replace(/\s+/g, " ").slice(0, 260),
    sidebarButtons: [...document.querySelectorAll("button")].map((b) => (b.innerText || "").trim()).filter((t) => t.length > 0 && t.length < 24).slice(0, 24),
  }));
  console.log("SIGNALS:", JSON.stringify(signals, null, 1));

  console.log("LOGS:", JSON.stringify(logs.slice(0, 40), null, 1));
  await browser.close();
} finally {
  edge.kill();
}
