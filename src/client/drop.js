// dsh-pathlink — client half, drop/paste side: give a dropped file a path.
//
// The composer only accepts images on drop/paste ("仅支持 PNG、JPG、WebP、GIF
// 格式的图片"): every dropped file is pushed through the image intake, and a
// browser cannot read a dropped file's path. So a plain file is handed to the
// host instead, which locates the real file by name+size (and, failing that,
// saves the bytes and returns the saved path) — the composer then receives a
// usable path, exactly like a desktop agent does.
//
// Images are left completely alone: the shipped overlay and attachment flow
// stay in charge.
const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Host routes registered by the node half (see lib/index.js). */
const HOST_BASE = "/pathlink/drop";

const isImage = (file) => typeof file.type === "string" && IMAGE_MEDIA_TYPES.has(file.type.toLowerCase());

/** The composer textarea — hashed class first, any visible textarea as fallback. */
function findComposer() {
  const preferred = document.querySelector("textarea.uV2eYG_input");
  if (preferred !== null) return preferred;
  return [...document.querySelectorAll("textarea")].find((el) => el.offsetParent !== null) ?? null;
}

/** Insert text at the caret so the composer's own state machine sees it. */
function insertIntoComposer(text) {
  const textarea = findComposer();
  if (textarea === null) return false;
  const needsBreak = textarea.value.length > 0 && !textarea.value.endsWith("\n");
  const payload = (needsBreak ? "\n" : "") + text;
  textarea.focus();
  let inserted = false;
  try {
    inserted = document.execCommand("insertText", false, payload);
  } catch {
    inserted = false;
  }
  if (!inserted || !textarea.value.includes(text.split("\n")[0])) {
    const proto = HTMLTextAreaElement.prototype;
    const next = textarea.value + payload;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(textarea, next);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.setSelectionRange(next.length, next.length);
  }
  return true;
}

/** file:// URLs from the drag payload, when the source app exposes them. */
function pathsFromDataTransfer(dataTransfer) {
  const out = new Map();
  if (dataTransfer === null || typeof dataTransfer.getData !== "function") return out;
  for (const type of ["text/uri-list", "text/plain"]) {
    let raw = "";
    try {
      raw = dataTransfer.getData(type) ?? "";
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.toLowerCase().startsWith("file://")) continue;
      try {
        const url = new URL(trimmed);
        let path = decodeURIComponent(url.pathname);
        if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
        path = path.replace(/\//g, "\\");
        out.set(path.split("\\").pop().toLowerCase(), path);
      } catch {
        /* ignore malformed URI */
      }
    }
  }
  return out;
}

async function locateOnHost(file) {
  const response = await fetch(
    `${HOST_BASE}/locate?name=${encodeURIComponent(file.name)}&size=${file.size}`,
    { headers: { accept: "application/json" } },
  );
  if (!response.ok) throw new Error(`locate ${response.status}`);
  return response.json();
}

async function saveOnHost(file) {
  const response = await fetch(`${HOST_BASE}/save?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!response.ok) throw new Error(`save ${response.status}`);
  return response.json();
}

/**
 * Install the drag/paste → path behaviour.
 * @param {{ toast: (message: string) => void }} deps - the client half's notice helper.
 * @returns disposer removing every listener.
 */
export function installDropToPath({ toast }) {
  let busy = false;

  const handleFiles = async (files, hintedPaths) => {
    if (busy) return;
    busy = true;
    const label = files.length === 1 ? files[0].name : `${files.length} 个文件`;
    toast(`正在定位 ${label} …`);
    const inserted = [];
    const copies = [];
    const missed = [];
    try {
      for (const file of files) {
        const hinted = hintedPaths.get(file.name.toLowerCase());
        if (typeof hinted === "string") {
          inserted.push(hinted);
          continue;
        }
        let found = null;
        try {
          const located = await locateOnHost(file);
          const matches = Array.isArray(located?.matches) ? located.matches : [];
          if (matches.length > 0) found = matches[0].path;
        } catch {
          found = null;
        }
        if (found !== null) {
          inserted.push(found);
          continue;
        }
        try {
          const saved = await saveOnHost(file);
          if (typeof saved?.path === "string") {
            inserted.push(saved.path);
            copies.push(saved.path);
            continue;
          }
        } catch {
          /* fall through to the miss list */
        }
        missed.push(file.name);
      }

      if (inserted.length > 0 && !insertIntoComposer(inserted.join("\n"))) {
        toast(`已定位路径但没找到输入框：${inserted.join(" ")}`);
        return;
      }
      const parts = [];
      if (inserted.length > 0) parts.push(`已插入 ${inserted.length} 个路径`);
      if (copies.length > 0) parts.push(`其中 ${copies.length} 个未找到原件，已存副本`);
      if (missed.length > 0) parts.push(`未处理：${missed.join("、")}`);
      if (parts.length > 0) toast(parts.join("；"));
    } finally {
      busy = false;
    }
  };

  const filesOf = (event) => {
    const transfer = event.dataTransfer ?? event.clipboardData ?? null;
    if (transfer === null) return { files: [], hinted: new Map() };
    const files = event.type === "paste"
      ? Array.from(transfer.items ?? [])
          .filter((item) => item.kind === "file")
          .map((item) => item.getAsFile())
          .filter((file) => file !== null)
      : Array.from(transfer.files ?? []);
    return { files, hinted: pathsFromDataTransfer(transfer) };
  };

  /** A drag carrying files (as opposed to dragged text or a DOM selection). */
  const isFileDrag = (transfer) =>
    transfer !== null && Array.from(transfer.types ?? []).includes("Files");

  /** MIME types the payload advertises while the drag is still in the air. */
  const draggedTypes = (transfer) =>
    Array.from(transfer?.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => (item.type || "").toLowerCase());

  /**
   * Keep the composer's full-screen "drop images here" overlay away from plain
   * file drags: the composer turns its dragActive state on at dragenter and only
   * clears it in its own drop/dragleave handlers — and this plugin owns the drop
   * for non-images, so the overlay would otherwise stay on screen.
   */
  const onDragOverlayGuard = (event) => {
    const transfer = event.dataTransfer ?? null;
    if (!isFileDrag(transfer)) return;
    const types = draggedTypes(transfer);
    if (types.length > 0 && types.every((type) => IMAGE_MEDIA_TYPES.has(type))) return;
    if (event.type === "dragenter" || event.type === "dragover") event.preventDefault();
    event.stopImmediatePropagation();
  };

  const onDrop = (event) => {
    const { files, hinted } = filesOf(event);
    if (files.length === 0 || files.every(isImage)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void handleFiles(files, hinted);
  };

  const onPaste = (event) => {
    const { files, hinted } = filesOf(event);
    if (files.length === 0 || files.every(isImage)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void handleFiles(files, hinted);
  };

  // Capture phase: these run before the composer's own document-level handlers,
  // so a plain file never triggers the image-only overlay or notice.
  document.addEventListener("dragenter", onDragOverlayGuard, true);
  document.addEventListener("dragover", onDragOverlayGuard, true);
  document.addEventListener("dragleave", onDragOverlayGuard, true);
  document.addEventListener("drop", onDrop, true);
  document.addEventListener("paste", onPaste, true);
  window.addEventListener("dragend", onDragOverlayGuard, true);

  return () => {
    document.removeEventListener("dragenter", onDragOverlayGuard, true);
    document.removeEventListener("dragover", onDragOverlayGuard, true);
    document.removeEventListener("dragleave", onDragOverlayGuard, true);
    document.removeEventListener("drop", onDrop, true);
    document.removeEventListener("paste", onPaste, true);
    window.removeEventListener("dragend", onDragOverlayGuard, true);
  };
}
