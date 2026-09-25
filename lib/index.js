// dsh-pathlink — host half.
//
// Two surfaces, both about turning what the browser sees into a real file path:
//
//  1. the `pathlink` Remote service — one read-only method `open`: receives the
//     raw path text the browser recognized in a chat message plus the session
//     that displayed it, resolves relative paths against that session's working
//     directory (falling back to the harness process cwd), verifies the target
//     exists, and hands it to the platform file manager:
//
//       windows  file   → explorer.exe /select,<path>  (file selected in folder)
//       windows  folder → explorer.exe <folder>
//       darwin   file   → open -R <path>
//       darwin   folder → open <folder>
//       linux    file   → xdg-open <parent folder>
//       linux    folder → xdg-open <folder>
//
//  2. the `/pathlink/drop/*` HTTP routes — the drag/paste side. A browser cannot
//     tell a page where a dropped file lives (drop data carries name/size/bytes
//     only), so the client asks the host to find the file by name+size:
//
//       GET  /pathlink/drop/locate?name=…&size=…  → { matches: [{ path, … }] }
//       POST /pathlink/drop/save?name=…           → { path }  (copy of the bytes)
//       GET  /pathlink/drop/state                 → search roots / diagnostics
//
//     Routes are registered through an optional `webServer` injection, so a
//     profile without a web server still runs the Remote half untouched.
//
// The service owns no durable state and never creates or resumes an Agent or
// Session — it only reads session headers to anchor relative paths.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join as joinPath, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Service } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

/** Platform family the opener targets. */
const PLATFORM = process.platform;

// ── small helpers ───────────────────────────────────────────────────────────

/** Build a frozen success branch. */
function success(value) {
  return Object.freeze({ ok: true, value: Object.freeze(value) });
}

/** Build a frozen business-failure branch. */
function rejected(error) {
  return Object.freeze({ ok: false, error: Object.freeze(error) });
}

/**
 * Spawn a detached, fire-and-forget OS process. The browser only needs to know
 * the opener was launched; the OS process outlives the request.
 */
function launch(command, args) {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.on("error", () => {
    /* An opener that failed to spawn surfaces as path-not-found upstream only
       when the target itself is missing; a spawn failure on an existing target
       is unreportable to the UI and is deliberately ignored. */
  });
  child.unref();
}

/** Whether `path` names an existing directory; files and missing paths → false. */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// ── service ─────────────────────────────────────────────────────────────────

let PathlinkService = class PathlinkService extends TypertRemoteService {
  static inject = ["sessions", "sessionPersistence"];

  maxPathChars;

  constructor(ctx, config) {
    super(ctx, "pathlink");
    this.maxPathChars = resolvePositiveInt(config?.maxPathChars, 1024, "maxPathChars");
    this.drop = resolveDropConfig(config);
    this.workspaceCtx = null;

    // Optional workspace roots: the harness's own workspace list is the best
    // source of search roots, but a profile without the registry still works.
    ctx.inject(["workspaceRegistry"], (scoped) => {
      this.workspaceCtx = scoped;
      return () => {
        this.workspaceCtx = null;
      };
    });

    // Optional HTTP routes: only a profile with a web server serves the browser
    // half's drop lookups. The Remote `open` method above is unaffected.
    ctx.inject(["webServer"], (scoped) => {
      const handler = (req, res) => void this.handleDropRequest(req, res);
      const dispose = scoped.webServer.register({ kind: "prefix", path: "/pathlink/drop", handler });
      scoped.logger?.info?.(`[dsh-pathlink] drop routes ready; roots=${this.dropSearchRoots().join(" | ")}`);
      return () => dispose();
    });
  }

  /**
   * Open the folder containing a recognized path (or the folder itself when
   * the path names a directory) in the OS file manager.
   * @param {{ sessionId: string|null, path: string }} request
   */
  async open(request) {
    const raw = typeof request?.path === "string" ? request.path.trim() : "";
    if (raw.length === 0) return rejected({ code: "path-blank" });
    if (raw.length > this.maxPathChars)
      return rejected({ code: "path-too-long", maxChars: this.maxPathChars });

    const stripped = stripShellDecoration(raw);
    const candidates = await this.resolveCandidates(stripped, request?.sessionId ?? null);
    const target = candidates.find((candidate) => existsSync(candidate));
    if (target === void 0)
      return rejected({ code: "path-not-found", tried: Object.freeze(candidates) });

    return this.launchFor(target);
  }

  /** Candidate absolute paths, in preference order, for one raw path text. */
  async resolveCandidates(raw, sessionId) {
    const bases = [];
    if (sessionId !== null) {
      const cwd = await this.sessionCwd(sessionId);
      if (cwd !== null) bases.push(cwd);
    }
    bases.push(process.cwd());
    const seen = new Set();
    const candidates = [];
    const consider = (candidate) => {
      if (seen.has(candidate)) return;
      seen.add(candidate);
      candidates.push(candidate);
    };
    if (isAbsolute(raw)) consider(raw);
    for (const base of bases) consider(resolve(base, raw));
    return candidates;
  }

  /** Working directory of one session: live header first, snapshot next. */
  async sessionCwd(sessionId) {
    const live = this.ctx.sessions.get(sessionId);
    if (live !== void 0 && typeof live.header?.cwd === "string" && live.header.cwd.length > 0)
      return live.header.cwd;
    try {
      // Header-only catalog read — full-log inspection is far too heavy for a
      // click-time lookup.
      const snapshots = await this.ctx.sessionPersistence.listSnapshots();
      const hit = snapshots.find((snapshot) => snapshot.header.id === sessionId);
      const cwd = hit?.header?.cwd;
      if (typeof cwd === "string" && cwd.length > 0) return cwd;
    } catch {
      /* catalog failures fall through to the process cwd */
    }
    return null;
  }

  /** Verify the platform is supported, then launch the right opener. */
  launchFor(target) {
    const folder = isDirectory(target);
    const kind = folder ? "folder" : "file";
    switch (PLATFORM) {
      case "win32":
        // Explorer returns exit code 1 even on success; the launch is detached
        // and unref'd so the code is never read anyway. The /select flag and
        // the path are two separate argv entries (the canonical recipe): a
        // single quoted "/select,<path>" argument breaks Explorer's parser
        // when the path contains spaces and ends up opening the target itself.
        launch("explorer.exe", folder ? [windowsPath(target)] : ["/select,", windowsPath(target)]);
        break;
      case "darwin":
        launch("open", folder ? [target] : ["-R", target]);
        break;
      case "linux":
        launch("xdg-open", [folder ? target : parentOf(target)]);
        break;
      default:
        return rejected({ code: "unsupported-platform", platform: PLATFORM });
    }
    console.log(`[dsh-pathlink] open ${kind} → ${target}`);
    return success({ kind, resolved: target });
  }

  // ── drop/paste side ───────────────────────────────────────────────────────

  /** Search roots for one drop lookup: config → workspaces → cwd/desktop/… */
  dropSearchRoots() {
    const harvested = [];
    try {
      const list = this.workspaceCtx?.workspaceRegistry?.list?.() ?? [];
      for (const workspace of list) {
        const path = workspace?.path;
        if (typeof path === "string" && path.length > 0) harvested.push(path);
      }
    } catch {
      /* registry unavailable or reshaped — defaults still apply */
    }
    return [...this.drop.roots, ...harvested, ...defaultDropRoots()].filter(
      (value, index, all) => typeof value === "string" && value.length > 0 && all.indexOf(value) === index,
    );
  }

  /** Answer one /pathlink/drop/* request. */
  async handleDropRequest(req, res) {
    try {
      let url;
      try {
        url = new URL(req.url ?? "/", "http://127.0.0.1");
      } catch {
        return dropJson(res, 400, { ok: false, error: "bad-url" });
      }
      const route = url.pathname.replace(/\/+$/, "");

      if (req.method === "GET" && route === "/pathlink/drop/locate") {
        const fileName = url.searchParams.get("name") ?? "";
        const size = Number(url.searchParams.get("size") ?? "0");
        if (fileName.length === 0) return dropJson(res, 400, { ok: false, error: "missing-name" });
        const started = Date.now();
        const { matches, rootsTried } = await locateDroppedFile(
          fileName,
          Number.isFinite(size) ? size : 0,
          { ...this.drop, roots: this.dropSearchRoots() },
        );
        return dropJson(res, 200, { ok: true, matches, rootsTried, elapsedMs: Date.now() - started });
      }

      if (req.method === "POST" && route === "/pathlink/drop/save") {
        const fileName = safeDropName(url.searchParams.get("name"));
        let body;
        try {
          body = await readRequestBody(req, MAX_SAVE_BYTES);
        } catch (error) {
          return dropJson(res, 413, { ok: false, error: String(error) });
        }
        try {
          const target = await this.saveDroppedCopy(fileName, body);
          return dropJson(res, 200, { ok: true, path: target, size: body.length, dropDir: this.drop.dropDir });
        } catch (error) {
          return dropJson(res, 500, { ok: false, error: String(error) });
        }
      }

      if (req.method === "GET" && route === "/pathlink/drop/state") {
        return dropJson(res, 200, {
          ok: true,
          dropDir: this.drop.dropDir,
          roots: this.dropSearchRoots(),
          maxDepth: this.drop.maxDepth,
          budgetMs: this.drop.budgetMs,
        });
      }

      return dropJson(res, 404, { ok: false, error: "not-found" });
    } catch (error) {
      return dropJson(res, 500, { ok: false, error: String(error) });
    }
  }

  /** Write the dropped bytes under the drop directory, never clobbering a name. */
  async saveDroppedCopy(fileName, body) {
    mkdirSync(this.drop.dropDir, { recursive: true });
    let target = joinPath(this.drop.dropDir, fileName);
    const dot = fileName.lastIndexOf(".");
    const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
    const ext = dot > 0 ? fileName.slice(dot) : "";
    for (let index = 2; index < 1000; index += 1) {
      let taken = true;
      try {
        await stat(target);
      } catch {
        taken = false;
      }
      if (!taken) break;
      target = joinPath(this.drop.dropDir, `${stem}-${index}${ext}`);
    }
    writeFileSync(target, body);
    return target;
  }
};

function resolvePositiveInt(value, fallback, name) {
  if (value === void 0) return fallback;
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`pathlink: ${name} must be a positive safe integer`);
  return value;
}

/** Parent directory of an existing non-directory path (used by linux files). */
function parentOf(path) {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index > 0 ? path.slice(0, index) : path;
}

/** Explorer wants backslash-separated absolute paths. */
function windowsPath(path) {
  return path.replace(/\//g, "\\");
}

// ── drop/paste helpers ──────────────────────────────────────────────────────

/** Directories a locate scan never descends into. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "target",
  "__pycache__", ".venv", "venv", ".next", ".nuxt", ".cache", "coverage",
  ".idea", ".vscode", ".pnpm-store", "vendor",
]);

/** Largest dropped file this host is willing to copy (locate still works). */
const MAX_SAVE_BYTES = 64 * 1024 * 1024;

/** Roots searched when neither config nor the workspace registry provides any. */
function defaultDropRoots() {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  return [
    process.cwd(),
    joinPath(home, "Desktop"),
    joinPath(home, "Downloads"),
    joinPath(home, "Documents"),
  ];
}

/** Drop-side config knobs (all optional, all validated to safe defaults). */
function resolveDropConfig(config) {
  const positive = (value, fallback) => (Number.isSafeInteger(value) && value > 0 ? value : fallback);
  return {
    roots: Array.isArray(config?.dropRoots)
      ? config.dropRoots.filter((value) => typeof value === "string" && value.length > 0)
      : [],
    maxDepth: positive(config?.dropMaxDepth, 6),
    budgetMs: positive(config?.dropBudgetMs, 2500),
    limit: positive(config?.dropLimit, 10),
    dropDir: typeof config?.dropDir === "string" && config.dropDir.length > 0
      ? config.dropDir
      : joinPath(tmpdir(), "dsh-drops"),
  };
}

/**
 * Find files on disk matching one dropped file's name and size.
 *
 * Roots are scanned in order and the first root that yields anything wins: the
 * common case is a project file inside a workspace, and a short scan keeps the
 * round trip short. `readdir`/`stat` are async so a big tree never blocks the
 * harness event loop.
 */
async function locateDroppedFile(fileName, size, options) {
  const wanted = fileName.toLowerCase();
  const deadline = Date.now() + options.budgetMs;
  const seen = new Set();

  const walk = async (dir, depth, matches) => {
    if (depth > options.maxDepth || Date.now() > deadline || matches.length >= options.limit) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (Date.now() > deadline || matches.length >= options.limit) return;
      const full = joinPath(dir, entry.name);
      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (SKIP_DIRS.has(lower) || entry.name.startsWith(".")) continue;
        await walk(full, depth + 1, matches);
        continue;
      }
      if (!entry.isFile() || entry.name.toLowerCase() !== wanted) continue;
      if (seen.has(full)) continue;
      let info;
      try {
        info = await stat(full);
      } catch {
        continue;
      }
      if (size > 0 && info.size !== size) continue;
      seen.add(full);
      matches.push({ path: full, size: info.size, mtime: info.mtimeMs });
    }
  };

  const rootsTried = [];
  for (const root of options.roots) {
    if (typeof root !== "string" || root.length === 0) continue;
    rootsTried.push(root);
    const matches = [];
    try {
      await walk(root, 0, matches);
    } catch {
      continue;
    }
    if (matches.length > 0) {
      matches.sort((a, b) => b.mtime - a.mtime);
      return { matches, rootsTried };
    }
    if (Date.now() > deadline) break;
  }
  return { matches: [], rootsTried };
}

/** Collect a request body, refusing anything over `limit`. */
function readRequestBody(req, limit) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
        rejectPromise(new Error("too-large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks)));
    req.on("error", rejectPromise);
  });
}

/** Strip anything that cannot live in a file name. */
function safeDropName(rawName) {
  const base = String(rawName ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, "_").trim();
  return cleaned.length > 0 && cleaned !== "." && cleaned !== ".." ? cleaned.slice(0, 120) : "dropped-file";
}

/** Answer one drop route with JSON. */
function dropJson(res, code, payload) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

/**
 * Strip decoration the recognizer may have left on a path: paired wrapping
 * quotes/backticks and trailing closing brackets/commas/semicolons that belong
 * to the sentence, not the path. Windows drive letters and UNC roots survive
 * untouched.
 */
function stripShellDecoration(raw) {
  let text = raw;
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'")) ||
      (text.startsWith("`") && text.endsWith("`")))
  )
    text = text.slice(1, -1);
  text = text.replace(/[),;:：，。；]+$/u, "");
  return text;
}

// ── Remote markers ──────────────────────────────────────────────────────────
//
// Equivalent of @Remote("open") without decorator syntax (see
// @deepseek-ai/dsh-typert-protocol). The manual initializer writes exactly the
// marker table the real decorator would, and `remoteMethods(instance)` reads
// it back.

Remote("open")(void 0, {
  private: false,
  static: false,
  name: "open",
  addInitializer(init) {
    init.call(Object.create(PathlinkService.prototype));
  },
});

export { PathlinkService, PathlinkService as default };
