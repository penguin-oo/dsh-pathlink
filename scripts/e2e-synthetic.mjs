// dsh-pathlink — synthetic-container browser E2E against a local DSH instance.
//
// Never touches real sessions (the test instance shares the live profile):
// it proves plugin boot, span wrapping, Ctrl+click → host open, and the
// not-found toast inside a throwaway DOM container marked data-chat-flow.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const DSH_URL = process.env.DSH_URL ?? "http://127.0.0.1:3738";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const CDP_PORT = 9330;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browserErrors = [];

const profile = mkdtempSync(join(tmpdir(), "dshpl-e2e-"));
const edge = spawn(
  EDGE,
  [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" },
);

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
  throw new Error("e2e: Edge CDP did not come up");
}

try {
  const browser = await connect();
  const page = await browser.newPage();
  page.on("console", (message) => {
    if (message.type() === "error" || /dshpl|pathlink/i.test(message.text())) {
      browserErrors.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on("popup", (popup) => {
    globalThis.__popupUrl = popup.url();
  });

  console.log(`e2e: navigating ${DSH_URL}`);
  await page.goto(DSH_URL, { waitUntil: "domcontentloaded", timeout: 90000 });

  // 1. Plugin module materialized: our style tag exists.
  await page.waitForSelector("#dshpl-style", { timeout: 60000 });
  console.log("e2e: [ok] plugin style injected (module materialized)");

  // 2. Synthetic flow container → recognition + wrapping.
  await page.evaluate(() => {
    const host = document.createElement("div");
    host.setAttribute("data-chat-flow", "");
    host.style.display = "none";
    const paragraph = document.createElement("p");
    paragraph.textContent =
      "试试 D:\\deepseekhrness\\dsh-pathlink\\src\\client\\index.js 和 https://example.com/x 与 ./package.json 不存在路径 C:\\nope\\missing\\file.xyz";
    host.appendChild(paragraph);
    document.body.appendChild(host);
  });
  await sleep(1200);
  const spans = await page.evaluate(() =>
    [...document.querySelectorAll("[data-dshpl-kind]")].map((span) => ({
      kind: span.getAttribute("data-dshpl-kind"),
      value: span.getAttribute("data-dshpl-value"),
      title: span.title,
    })),
  );
  console.log("e2e: spans:", JSON.stringify(spans, null, 2));
  const expected = [
    ["path", "D:\\deepseekhrness\\dsh-pathlink\\src\\client\\index.js"],
    ["link", "https://example.com/x"],
    ["path", "./package.json"],
    ["path", "C:\\nope\\missing\\file.xyz"],
  ];
  for (const [kind, value] of expected) {
    if (!spans.some((span) => span.kind === kind && span.value === value)) {
      throw new Error(`e2e: expected span ${kind}:${value} missing`);
    }
  }
  console.log("e2e: [ok] all four spans recognized and wrapped");

  // 3. Ctrl+click the real path → Host opens the folder (see instance log).
  await page.evaluate(() => {
    const span = [...document.querySelectorAll("[data-dshpl-kind='path']")].find(
      (candidate) => candidate.getAttribute("data-dshpl-value").includes("dsh-pathlink"),
    );
    if (!span) throw new Error("e2e: path span not found");
    span.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }),
    );
  });
  await sleep(1500);
  console.log("e2e: [ok] ctrl+click dispatched (check instance log for '[dsh-pathlink] open')");

  // 4. Ctrl+click the link span → a new page with the URL opens (poll targets).
  await page.evaluate(() => {
    const span = document.querySelector("[data-dshpl-kind='link']");
    if (!span) throw new Error("e2e: link span not found");
    span.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }),
    );
  });
  let popupUrl = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(250);
    const urls = await Promise.all(
      browser.targets().filter((target) => target.type() === "page").map(async (target) => {
        try {
          return await target.page().then((targetPage) => targetPage.url()).catch(() => "");
        } catch {
          return "";
        }
      }),
    );
    const hit = urls.find((url) => url.includes("example.com/x"));
    if (hit) {
      popupUrl = hit;
      break;
    }
  }
  console.log("e2e: popup url:", popupUrl);
  if (popupUrl !== "https://example.com/x") {
    throw new Error("e2e: link popup did not open the expected URL");
  }
  console.log("e2e: [ok] link opened in new tab");

  // 5. Ctrl+click the missing path → toast appears (poll up to 6s).
  await page.evaluate(() => {
    const span = [...document.querySelectorAll("[data-dshpl-kind='path']")].find(
      (candidate) => candidate.getAttribute("data-dshpl-value").includes("nope"),
    );
    if (!span) throw new Error("e2e: missing-path span not found");
    span.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }),
    );
  });
  let toastText = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(250);
    toastText = await page.evaluate(
      () => document.getElementById("dshpl-toast")?.textContent ?? "",
    );
    if (toastText.length > 0) break;
  }
  console.log("e2e: toast:", toastText);
  if (toastText.length === 0) {
    console.log("e2e: browser errors so far:\n" + browserErrors.join("\n"));
  }
  if (!toastText.includes("路径不存在")) throw new Error("e2e: not-found toast missing");
  console.log("e2e: [ok] not-found toast shown");

  // 6. Plain click (no modifier) must NOT open anything.
  const pagesBefore = browser.targets().filter((target) => target.type() === "page").length;
  await page.evaluate(() => {
    const span = document.querySelector("[data-dshpl-kind='link']");
    span.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await sleep(1200);
  const pagesAfter = browser.targets().filter((target) => target.type() === "page").length;
  if (pagesAfter !== pagesBefore) throw new Error("e2e: plain click opened a link");
  console.log("e2e: [ok] plain click inert");

  const relevant = browserErrors.filter((entry) => /dsh-pathlink|pathlink|ModuleLoader/i.test(entry));
  if (relevant.length > 0) {
    console.error("e2e: relevant browser errors:\n" + relevant.join("\n"));
    throw new Error("e2e: plugin-related browser errors");
  }
  console.log("e2e: ALL OK");
  await browser.close();
} finally {
  edge.kill();
}
