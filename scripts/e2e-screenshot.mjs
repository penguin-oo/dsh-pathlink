// Screenshots docs/demo.html (full-page and toast scene) with headless Edge.
// The demo page contains no user data.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const CDP_PORT = 9332;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const profile = mkdtempSync(join(tmpdir(), "dshpl-shot-"));
const edge = spawn(EDGE, [
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`,
  "--headless=new",
  "about:blank",
], { stdio: "ignore" });

async function connect() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      await response.json();
      return puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP_PORT}` });
    } catch {
      await sleep(500);
    }
  }
  throw new Error("screenshot: Edge CDP did not come up");
}

try {
  const browser = await connect();
  const page = await browser.newPage();
  await page.setViewport({ width: 860, height: 640, deviceScaleFactor: 2 });
  await page.goto(`file:///${join(process.cwd(), "docs", "demo.html").replaceAll("\\", "/")}`, {
    waitUntil: "load",
  });
  await sleep(300);
  await page.screenshot({ path: "docs/screenshot-demo.png" });
  console.log("screenshot: wrote docs/screenshot-demo.png");
  await browser.close();
} finally {
  edge.kill();
}
