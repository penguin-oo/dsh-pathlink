// E2E: drop files into the real GUI and check what lands in the composer.
//  1. a file that exists on disk → its real path is inserted, and the built-in
//     full-screen "drop images here" overlay never appears
//  2. a file that exists nowhere → a saved copy path is inserted
//  3. an image → the shipped overlay + attachment flow stay untouched
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const CDP_PORT = 9415;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REAL_FILE = "D:\\deepseekhrness\\drop-test-target.txt";
writeFileSync(REAL_FILE, "drop path e2e target 2026-09-16");

const profile = mkdtempSync(join(tmpdir(), "dsh-drop-e2e-"));
const edge = spawn(EDGE, [
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  "--headless=new", "--disable-gpu", "--window-size=1400,900", "about:blank",
], { stdio: "ignore" });

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` — ${detail}`}`);
};

try {
  let browser = null;
  for (let i = 0; i < 60 && !browser; i++) {
    try {
      await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
      browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP_PORT}`, protocolTimeout: 180000 });
    } catch { await sleep(500); }
  }
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
  page.on("pageerror", (e) => errors.push("[pageerror] " + String(e).slice(0, 160)));

  await page.goto("http://127.0.0.1:3737/", { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(10000);

  const composerValue = () => page.evaluate(() => document.querySelector("textarea")?.value ?? null);
  const overlayVisible = () => page.evaluate(() => {
    const byId = document.querySelector("#dshDropOverlayClip") !== null;
    const byText = /拖动到此处|Drag images here/.test(document.body.innerText);
    return byId || byText;
  });
  const clearComposer = () => page.evaluate(() => {
    const ta = document.querySelector("textarea");
    if (ta === null) return;
    const proto = HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(ta, "");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });

  const dragEvent = (kind, name, type, content) => page.evaluate((k, fileName, mime, body) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(body)], fileName, { type: mime }));
    const target = document.querySelector("textarea") ?? document.body;
    target.dispatchEvent(new DragEvent(k, { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, kind, name, type, Array.from(content));

  // ---- 1) existing file: drag-in must not raise the built-in overlay ----
  const realBytes = [...readFileSync(REAL_FILE)];
  await clearComposer();
  await dragEvent("dragenter", "drop-test-target.txt", "text/plain", realBytes);
  await dragEvent("dragover", "drop-test-target.txt", "text/plain", realBytes);
  await sleep(1200);
  check("drop overlay stays hidden during a file drag", (await overlayVisible()) === false);
  await dragEvent("drop", "drop-test-target.txt", "text/plain", realBytes);
  await sleep(6000);
  const value1 = await composerValue();
  check("existing file inserts its real path", value1 === REAL_FILE, JSON.stringify(value1));
  check("overlay still hidden after the drop", (await overlayVisible()) === false);

  // ---- 2) unknown file → saved copy path ----
  await clearComposer();
  const ghost = [...Buffer.from("ghost content " + Date.now())];
  await dragEvent("drop", "ghost-file-xyz-9999.bin", "application/octet-stream", ghost);
  await sleep(6000);
  const value2 = await composerValue();
  check("unknown file inserts a saved copy path", typeof value2 === "string" && value2.includes("dsh-drops"), JSON.stringify(value2));

  // ---- 3) image: shipped overlay + attachment flow preserved ----
  await clearComposer();
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
    0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00,
    0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
  await dragEvent("dragenter", "tiny2.png", "image/png", png);
  await dragEvent("dragover", "tiny2.png", "image/png", png);
  await sleep(1200);
  check("image drag keeps the shipped overlay", (await overlayVisible()) === true);
  await dragEvent("drop", "tiny2.png", "image/png", png);
  await sleep(4000);
  check("image still attaches (no path inserted)", (await composerValue()) === "");
  check("image drop clears the overlay", (await overlayVisible()) === false);
  check("image rail present", await page.evaluate(() => document.querySelector("[class*='attachments']") !== null));

  check("no console errors", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
  console.log(failures === 0 ? "\nall pathlink drop checks passed" : `\n${failures} check(s) failed`);
  await browser.close();
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  edge.kill();
}

