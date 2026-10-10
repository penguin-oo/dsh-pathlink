// Verify: after the composer fix, message-side pathlink still wraps paths in
// rendered chat rows and the guard lives inside a chat-flow row, not composer.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const DSH_URL = "http://127.0.0.1:3737";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const CDP_PORT = 9392;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, payload) {
  const res = await fetch(`${DSH_URL}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: "probe-2", method, payload }),
  });
  const json = await res.json();
  if (!json.result?.ok) throw new Error(`${method} failed: ${JSON.stringify(json.result?.error)}`);
  return json.result.value;
}

const profile = mkdtempSync(join(tmpdir(), "dsh-msg-"));
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
    if (["error", "warning"].includes(msg.type())) consoleErrors.push(`[console.${msg.type()}] ${msg.text().slice(0, 300)}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${String(err).slice(0, 300)}`));
  const created = await rpc("session.create", { cwd: "D:/deepseekhrness" });
  await rpc("session.rename", { sessionId: created.sessionId, title: "verify-msg" });
  await page.goto(DSH_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await sleep(12000);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "打开侧边栏");
    btn?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  });
  await sleep(3000);
  for (let i = 0; i < 30; i++) {
    const hit = await page.evaluate(() => {
      const el = [...document.querySelectorAll("div, a, button, li, span")]
        .find((n) => n.childElementCount === 0 && (n.textContent || "").trim() === "verify-msg");
      if (!el) return false;
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    });
    if (hit) break;
    await sleep(1000);
  }
  await sleep(8000);

  await rpc("session.prompt", {
    sessionId: created.sessionId, mode: "queue",
    content: [{ type: "text", text: "请把下面这一行原样回复给我，一字不改：\n演示路径 D:\\demo\\data\\report.txt" }],
  });
  let found = false;
  for (let i = 0; i < 240 && !found; i++) {
    await sleep(1500);
    found = await page.evaluate(() => [...document.querySelectorAll("[data-chat-flow-kind='assistant-step']")]
      .some((r) => (r.textContent || "").includes("演示路径")));
  }
  await sleep(3000);
  const state = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-chat-flow-kind='assistant-step']")];
    const row = rows.find((r) => (r.textContent || "").includes("演示路径"));
    const guards = row ? [...row.querySelectorAll("[data-dshpl-guard]")] : [];
    const userRow = [...document.querySelectorAll("[data-chat-flow-kind]")]
      .find((r) => r.getAttribute("data-chat-flow-kind") === "user" && (r.textContent || "").includes("演示路径"));
    const userGuards = userRow ? [...userRow.querySelectorAll("[data-dshpl-guard]")] : [];
    return {
      replyFound: !!row,
      guardsInAssistantRow: guards.map((g) => ({ kind: g.getAttribute("data-dshpl-kind"), text: g.textContent })),
      userGuards: userGuards.map((g) => ({ kind: g.getAttribute("data-dshpl-kind"), text: g.textContent })),
      guardsOutsideFlow: [...document.querySelectorAll("[data-dshpl-guard]")]
        .filter((g) => !g.closest("[data-chat-flow]")).length,
    };
  });
  console.log("VERIFY:", JSON.stringify(state, null, 1));
  console.log("CONSOLE-ERRORS:", JSON.stringify(consoleErrors.slice(0, 8), null, 1));
  await browser.close();
} finally {
  edge.kill();
}