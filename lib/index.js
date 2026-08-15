// dsh-pathlink — host half: the `pathlink` Remote service.
//
// One read-only method: `open`. It receives the raw path text the browser
// recognized in a chat message plus the session that displayed it, resolves
// relative paths against that session's working directory (falling back to
// the harness process cwd), verifies the target exists, and hands it to the
// platform file manager:
//
//   windows  file   → explorer.exe /select,<path>  (file selected in folder)
//   windows  folder → explorer.exe <folder>
//   darwin   file   → open -R <path>
//   darwin   folder → open <folder>
//   linux    file   → xdg-open <parent folder>
//   linux    folder → xdg-open <folder>
//
// The service owns no durable state and never creates or resumes an Agent or
// Session — it only reads session headers to anchor relative paths.
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
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
        // and unref'd so the code is never read anyway.
        launch("explorer.exe", [folder ? target : `/select,${target}`]);
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
