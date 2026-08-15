// dsh-pathlink — client half: recognize file paths and URLs in rendered chat
// messages and open them with Ctrl/⌘+click.
//
//   path  → Host `pathlink` Remote: open the containing folder (or the folder
//           itself) in the OS file manager, with the file selected.
//   link  → window.open in a new tab (plain links already open natively;
//           this covers bare URLs the renderer did not linkify, e.g. user
//           bubbles, and matches the same Ctrl+click gesture).
//
// The whole surface is a DOM layer (see scanner.js for why the renderer seam
// is not used): zero UI chrome, zero per-message components, one delegated
// capture-phase listener.
import { TYPERT_REMOTE } from "../../lib/typert.remote-client.js";
import { PathlinkScanner } from "./scanner.js";

/** Cordis service dependencies. */
const inject = ["remote", "sessions"];

/**
 * Present one transient notice near the bottom of the window. Plain DOM, so
 * it never fights the React tree. Colors follow the theme aliases with
 * fallbacks for surfaces outside the themed subtree.
 */
function toast(message) {
  let host = document.getElementById("dshpl-toast");
  if (host === null) {
    host = document.createElement("div");
    host.id = "dshpl-toast";
    host.style.cssText =
      "position:fixed;left:50%;bottom:36px;transform:translateX(-50%);z-index:2147483000;" +
      "pointer-events:none;font:12px/1.5 system-ui,sans-serif;";
    document.body.appendChild(host);
  }
  const pill = document.createElement("div");
  pill.style.cssText =
    "background:var(--dsw-alias-bg-overlay,rgba(28,30,34,.96));" +
    "color:var(--dsw-alias-label-primary,#f4f6f8);" +
    "border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));" +
    "padding:7px 14px;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.28);" +
    "white-space:nowrap;margin-top:8px;text-align:center;";
  pill.textContent = message;
  host.replaceChildren(pill);
  setTimeout(() => {
    if (pill.parentNode === host) pill.remove();
  }, 3000);
}

/** Human-readable notice for one structured open failure. */
function failureNotice(error) {
  switch (error?.code) {
    case "path-not-found":
      return `路径不存在：${error.tried[0] ?? "?"}`;
    case "path-blank":
      return "路径为空，无法打开";
    case "path-too-long":
      return `路径过长（超过 ${error.maxChars} 字符）`;
    case "unsupported-platform":
      return `当前平台（${error.platform}）不支持打开文件夹`;
    default:
      return "打开失败，请重试";
  }
}

/**
 * Client plugin body: mount the `pathlink` Remote contribution and start the
 * DOM scanner.
 * @param ctx - client root context.
 */
async function apply(ctx) {
  await ctx.remote.$mount(TYPERT_REMOTE);
  const remote = ctx.get("remote.pathlink");

  const scanner = new PathlinkScanner({
    titleOf: (kind) =>
      kind === "path" ? "Ctrl+点击：在文件夹中打开 (⌘ on macOS)" : "Ctrl+点击：在浏览器打开 (⌘ on macOS)",
    getSessionId: () => ctx.sessions.list.getSnapshot().current ?? null,
    onOpenPath: async (value) => {
      const sessionId = ctx.sessions.list.getSnapshot().current ?? null;
      try {
        // Wire shape: transport carrier {ok, value} wrapping the business
        // union {ok, value | error}.
        const carried = await remote.open({ sessionId, path: value });
        if (!carried.ok) {
          toast("打开失败：服务暂时不可用");
          return;
        }
        const result = carried.value;
        if (!result.ok) {
          toast(failureNotice(result.error));
          return;
        }
        // Success is the Explorer/Finder window itself; no toast.
      } catch {
        toast("打开失败：服务暂时不可用");
      }
    },
  });

  ctx.effect(() => () => scanner.dispose(), "pathlink: scanner lifecycle");
}

// Snippet appended to the document head exactly once: a subtle dotted
// underline marks recognized spans so users can discover the gesture.
const STYLE_ID = "dshpl-style";
if (typeof document !== "undefined" && document.getElementById(STYLE_ID) === null) {
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    [data-dshpl-guard] {
      cursor: pointer;
      text-decoration: underline dotted
        color-mix(in srgb, currentColor 45%, transparent);
      text-decoration-thickness: 1px;
      text-underline-offset: 3px;
    }
    [data-dshpl-guard]:hover {
      text-decoration-color: var(--dsw-alias-brand-primary, #4d6bfe);
    }
  `;
  document.head.appendChild(style);
}

export { apply, inject };
