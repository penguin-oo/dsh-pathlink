// End-to-end check against a sandbox instance: open the tokenized GUI URL in a
// real browser and report console errors plus the DOM signals each client half
// installs.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const CDP_PORT = 9419;
const target = process.argv[2];
if (target === undefined) throw new Error("usage: node gui-e2e.mjs <tokenized-url>");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), "dsh-gui-e2e-"));
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
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(`[${m.type()}] ${m.text().slice(0, 240)}`); });
  page.on("pageerror", (e) => logs.push(`[pageerror] ${String(e).slice(0, 240)}`));
  page.on("requestfailed", (r) => logs.push(`[requestfailed] ${r.url().slice(0, 140)}`));

  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(15000);

  const state = await page.evaluate(() => {
    const text = document.body.innerText.replace(/\s+/g, " ");
    const buttons = [...document.querySelectorAll("button")].map((b) => (b.innerText || "").trim()).filter((t) => t.length > 0 && t.length < 20);
    return {
      title: document.title,
      authenticated: !/authentication required/i.test(text),
      pathlinkStyle: document.getElementById("dshpl-style") !== null,
      hasComposer: document.querySelector("textarea") !== null,
      panels: {
        bookmarks: /收藏/.test(text),
        quota: /额度/.test(text),
        ledger: /分派记录/.test(text),
      },
      buttons: [...new Set(buttons)].slice(0, 20),
      sample: text.slice(0, 200),
    };
  });
  console.log("STATE:", JSON.stringify(state, null, 1));
  console.log("LOGS:", JSON.stringify(logs.slice(0, 25), null, 1));
  await browser.close();
} finally {
  edge.kill();
}
