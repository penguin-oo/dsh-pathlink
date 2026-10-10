// Probe: reproduce the pathlink-composer freeze. Types a URL into the real
// composer slowly and checks whether pathlink wrapper spans invade the
// composer's internal layers (data-input-backdrop / data-input-mirror).
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const DSH_URL = "http://127.0.0.1:3737";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const CDP_PORT = 9391;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, payload) {
  const res = await fetch(`${DSH_URL}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: "probe-1", method, payload }),
  });
  const json = await res.json();
  if (!json.result?.ok) throw new Error(`${method} failed: ${JSON.stringify(json.result?.error)}`);
  return json.result.value;
}

const profile = mkdtempSync(join(tmpdir(), "dsh-probe-"));
const edge = spawn(EDGE, [
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  "--headless=new", "--disable-gpu", "about:blank",
], { stdio: "ignore" });

try {
  let browser = null;
  for (let i = 0; i < 60 && !browser; i++) {
    try {
      await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
      browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP_PORT}`, protocolTimeout: 180000 });
    } catch { await sleep(500); }
  }
  if (!browser) throw new Error("no browser");
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  // fresh scratch session so the composer is active
  const created = await rpc("session.create", { cwd: "D:/deepseekhrness" });
  await rpc("session.rename", { sessionId: created.sessionId, title: "probe-fix" });

  await page.goto(DSH_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await sleep(12000);

  // open the sidebar and click the probe session
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "打开侧边栏");
    btn?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  });
  await sleep(3000);
  for (let i = 0; i < 30; i++) {
    const hit = await page.evaluate(() => {
      const el = [...document.querySelectorAll("div, a, button, li, span")]
        .find((n) => n.childElementCount === 0 && (n.textContent || "").trim() === "probe-fix");
      if (!el) return false;
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    });
    if (hit) break;
    await sleep(1000);
  }
  await sleep(8000);

  // dump editing surfaces
  const surfaces = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("textarea, [contenteditable='true'], [role='textbox'], [data-input-backdrop], [data-input-mirror], [data-input]")) {
      out.push({
        tag: el.tagName,
        attrs: [...el.attributes].map((a) => `${a.name}="${a.value}"`).join(" ").slice(0, 160),
        cls: el.className?.toString?.().slice(0, 80) ?? "",
        text: (el.textContent ?? "").slice(0, 60),
      });
    }
    return out;
  });
  console.log("EDITING SURFACES:", JSON.stringify(surfaces, null, 1));

  // focus the real input (textarea preferred)
  const focused = await page.evaluate(() => {
    const el = document.querySelector("textarea") ?? document.querySelector("[role='textbox']");
    if (!el) return false;
    el.focus();
    return true;
  });
  console.log("composer focused:", focused);
  await sleep(800);

  const url = "https://open.bigmodel.cn/api/coding/paas/v4";
  await page.keyboard.type(url, { delay: 150 });
  await sleep(2500);

  const state = await page.evaluate(() => {
    const ta = document.querySelector("textarea");
    const input = document.querySelector("input[type='text'], input:not([type])");
    const textbox = document.querySelector("[role='textbox']");
    // find any pathlink guard spans that are NOT inside a chat-flow row
    const guards = [...document.querySelectorAll("[data-dshpl-guard]")].map((s) => {
      const chain = [];
      let n = s.parentElement;
      for (let i = 0; n && i < 6; i++, n = n.parentElement) chain.push(n.tagName + (n.getAttribute?.("data-chat-flow-kind") ? `[kind=${n.getAttribute("data-chat-flow-kind")}]` : "") + (n.id ? `#${n.id}` : ""));
      return { text: s.textContent.slice(0, 40), chain: chain.join(" < ") };
    });
    const mirrorText = document.querySelector("[data-input-mirror]")?.textContent ?? null;
    return {
      guardsTotal: guards.length,
      guards: guards.slice(0, 10),
      textareaValue: ta ? ta.value.slice(0, 80) : null,
      textboxText: textbox ? (textbox.textContent ?? "").slice(0, 80) : null,
      mirrorText,
      hasComposerSurfaces: !!document.querySelector("[data-input-backdrop], [data-input-mirror]"),
    };
  });
  console.log("STATE:", JSON.stringify(state, null, 1));
  await browser.close();
} finally {
  edge.kill();
}