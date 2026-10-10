// Smoke v2 (deterministic): checks (a) whether the browser module table can
// resolve "zod", (b) whether the pathlink client boots with the current
// lib/client.js build, (c) message-side guard spans after a demo reply.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const DSH_URL = "http://127.0.0.1:3737";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const CDP_PORT = 9393;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, payload) {
  const res = await fetch(`${DSH_URL}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: "smoke2", method, payload }),
  });
  const json = await res.json();
  if (!json.result?.ok) throw new Error(`${method} failed: ${JSON.stringify(json.result?.error)}`);
  return json.result.value;
}

const profile = mkdtempSync(join(tmpdir(), "dsh-smoke2-"));
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
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (["error", "warning"].includes(msg.type())) consoleErrors.push(`[console.${msg.type()}] ${msg.text().slice(0, 220)}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${String(err).slice(0, 220)}`));

  const created = await rpc("session.create", { cwd: "D:/deepseekhrness" });
  await rpc("session.rename", { sessionId: created.sessionId, title: "smoke2" });
  await page.goto(DSH_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await sleep(12000);

  // (a) module table inspection: does anything expose zod?
  const loaderInfo = await page.evaluate(() => {
    const lw = window.__ModuleLoader__;
    const probe = typeof lw === "object" && lw !== null;
    let keys = [];
    if (probe) {
      for (const k of ["load", "resolve", "require", "modules", "registry", "table"]) {
        if (typeof lw[k] === "function" || (lw[k] && typeof lw[k] === "object")) keys.push(k);
      }
    }
    return { hasLoader: probe, topKeys: keys };
  });
  console.log("LOADER:", JSON.stringify(loaderInfo));

  // (b) is pathlink applied? its style tag is appended by the module body.
  await sleep(4000);
  const stylePresent = await page.evaluate(() => !!document.getElementById("dshpl-style"));
  console.log("pathlink style tag (client applied):", stylePresent);

  // open sidebar and click the session (best effort; chat usually auto-opens newest)
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "打开侧边栏");
    btn?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  });
  await sleep(3000);
  let clicked = false;
  for (let i = 0; i < 30 && !clicked; i++) {
    clicked = await page.evaluate(() => {
      const el = [...document.querySelectorAll("div, a, button, li, span")]
        .find((n) => n.childElementCount === 0 && (n.textContent || "").trim() === "smoke2");
      if (!el) return false;
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    });
    if (!clicked) await sleep(1000);
  }
  await sleep(6000);
  const hasFlow = await page.evaluate(() => !!document.querySelector("[data-chat-flow], [data-conversation-scroll]"));
  console.log("leaf clicked:", clicked, "| flow container present:", hasFlow);

  // (c) demo reply + guards
  await rpc("session.prompt", {
    sessionId: created.sessionId, mode: "queue",
    content: [{ type: "text", text: "请把下面这一行原样回复给我，一字不改：\n演示路径 D:\\demo\\data\\report.txt" }],
  });
  let found = false;
  for (let i = 0; i < 120 && !found; i++) {
    await sleep(1500);
    found = await page.evaluate(() => [...document.querySelectorAll("[data-chat-flow-kind='assistant-step']")]
      .some((r) => (r.textContent || "").includes("演示路径"))).catch(() => false);
  }
  await sleep(2000);
  const state = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-chat-flow-kind='assistant-step']")];
    const row = rows.find((r) => (r.textContent || "").includes("演示路径"));
    const guards = row ? [...row.querySelectorAll("[data-dshpl-guard]")] : [];
    return {
      replyFound: !!row,
      guards: guards.map((g) => ({ kind: g.getAttribute("data-dshpl-kind"), text: g.textContent.slice(0, 50) })),
      anyGuardsOnPage: document.querySelectorAll("[data-dshpl-guard]").length,
    };
  }).catch(() => null);
  console.log("REPLY:", JSON.stringify(state));
  console.log("CONSOLE:", JSON.stringify(consoleErrors.slice(0, 10), null, 1));
  await browser.close();
} finally {
  edge.kill();
}