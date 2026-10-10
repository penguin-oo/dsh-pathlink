// Probe: what happens when a non-image file is dropped onto the composer?
// Synthesizes a real DataTransfer drop (the handler sees Files only) and
// captures any toast/notice text the GUI shows.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const CDP_PORT = 9411;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), "dsh-drop-"));
const edge = spawn(EDGE, [
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  "--headless=new", "--disable-gpu", "--window-size=1400,900", "about:blank",
], { stdio: "ignore" });

try {
  let browser = null;
  for (let i = 0; i < 60 && !browser; i++) {
    try {
      await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
      browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP_PORT}`, protocolTimeout: 120000 });
    } catch { await sleep(500); }
  }
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const console_errors = [];
  page.on("console", (m) => { if (m.type() === "error") console_errors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => console_errors.push("[pageerror] " + String(e).slice(0, 200)));

  await page.goto("http://127.0.0.1:3737/", { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(9000);

  const composer = await page.evaluate(() => {
    const ta = document.querySelector("textarea");
    return { found: ta !== null, cls: ta?.className ?? null, value: ta?.value ?? null };
  });
  console.log("composer:", JSON.stringify(composer));

  // baseline: what does the page look like
  const before = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 160));
  console.log("page before:", before);

  const runDrop = async (label, fileName, mime, content) => {
    const res = await page.evaluate((name, type, body) => {
      const dt = new DataTransfer();
      dt.items.add(new File([body], name, { type }));
      const target = document.querySelector("textarea") ?? document.body;
      for (const kind of ["dragenter", "dragover", "drop"]) {
        const ev = new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: dt });
        target.dispatchEvent(ev);
      }
      return { defaultPrevented: true };
    }, fileName, mime, content);
    await sleep(2500);
    const state = await page.evaluate(() => {
      const text = document.body.innerText.replace(/\s+/g, " ");
      const notices = [...document.querySelectorAll("[class*='notice'], [class*='toast'], [role='alert'], [class*='error']")]
        .map((el) => (el.innerText || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, 6);
      const ta = document.querySelector("textarea");
      return {
        notices,
        composerValue: ta?.value ?? null,
        hasRail: document.querySelector("[class*='attachments']") !== null,
        tail: text.slice(-260),
      };
    });
    console.log(`--- DROP ${label} (${fileName}, ${mime}) ---`);
    console.log(JSON.stringify(state, null, 1));
  };

  await runDrop("text file", "hello.txt", "text/plain", "hello world");
  await runDrop("png image", "tiny.png", "image/png", Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082", "hex"));

  console.log("CONSOLE:", JSON.stringify(console_errors.slice(0, 8), null, 1));
  await browser.close();
} finally {
  edge.kill();
}
