// dsh-pathlink — DOM layer: recognizes file paths and URLs inside rendered
// chat messages, wraps them in inert inline spans, and opens them on
// Ctrl/⌘+click through injected callbacks.
//
// Why DOM instead of a renderer seam: DSH's official `chatFileMentions` seam
// is a single-provider service (the built-in ui-deliverables plugin provides
// it unconditionally, so a second provider would conflict), and it only
// covers settled inline-code tokens. A MutationObserver-driven scanner covers
// every surface — prose, inline code, code blocks, user bubbles, tool cards —
// with one uniform Ctrl+click gesture, and React re-renders are absorbed by
// reprocessing only the text nodes whose data actually changed.
import { recognize } from "./pathlink-detect.js";

/** Attribute set on wrapper spans: kind + raw value. */
export const KIND_ATTR = "data-dshpl-kind";
const VALUE_ATTR = "data-dshpl-value";
const GUARD_ATTR = "data-dshpl-guard";

/** Containing elements that identify rendered conversation content. */
const FLOW_SELECTOR = "[data-chat-flow], [data-conversation-scroll]";
/** Elements whose text must never be scanned or wrapped. */
const SKIP_SELECTOR = "script, style, textarea, input, select, [contenteditable]";
/** Attribute-presence selector for wrapper spans. */
const GUARD_SELECTOR = `[${GUARD_ATTR}]`;

const MAX_TEXT_LENGTH = 20000;

/**
 * Whether a text node lives inside rendered conversation content and is
 * eligible for recognition.
 */
function isEligible(node) {
  const parent = node.parentElement;
  if (parent === null) return false;
  if (parent.closest(GUARD_SELECTOR) !== null) return false;
  if (parent.closest(SKIP_SELECTOR) !== null) return false;
  if (parent.closest("a") !== null) return false; // native links already open
  return parent.closest(FLOW_SELECTOR) !== null;
}

export class PathlinkScanner {
  #onOpenPath;
  #getSessionId;
  #titleOf;
  #processed = new WeakMap();
  #dirty = new Set();
  #scheduled = false;
  #observer;
  #interval;
  #clickHandler;
  #disposed = false;

  /**
   * @param {object} options
   * @param {(value: string) => void} options.onOpenPath - called with the raw
   *   recognized path text for a Ctrl+click on a path span.
   * @param {() => string | null | undefined} options.getSessionId - current
   *   session at click time (for host-side relative-path resolution).
   * @param {(kind: "path" | "link") => string} options.titleOf - tooltip text.
   */
  constructor({ onOpenPath, getSessionId, titleOf }) {
    this.#onOpenPath = onOpenPath;
    this.#getSessionId = getSessionId;
    this.#titleOf = titleOf;
    this.#clickHandler = (event) => this.#handleClick(event);
    document.addEventListener("click", this.#clickHandler, true);
    this.#observer = new MutationObserver((records) => this.#ingest(records));
    this.#observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    window.addEventListener("load", () => this.#scanAll(), { once: true });
    this.#interval = setInterval(() => this.#scanAll(), 4000);
    this.#scanAll();
  }

  /** Drop the observer, interval, and delegated listener. */
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    clearInterval(this.#interval);
    this.#observer.disconnect();
    document.removeEventListener("click", this.#clickHandler, true);
    this.#dirty.clear();
  }

  // ── mutation ingestion ────────────────────────────────────────────────────

  #ingest(records) {
    for (const record of records) {
      if (record.type === "characterData") {
        this.#dirty.add(record.target);
        continue;
      }
      for (const added of record.addedNodes) {
        if (added.nodeType !== 1 && added.nodeType !== 3) continue;
        if (added.nodeType === 3) {
          this.#dirty.add(added);
          continue;
        }
        // Added subtree: collect its text nodes. The text-level processed map
        // makes the walk idempotent, so re-added (moved) subtrees cost a walk
        // but never re-wrap; the periodic full sweep is the final backstop.
        const walker = document.createTreeWalker(added, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) this.#dirty.add(node);
      }
    }
    this.#schedule();
  }

  #schedule() {
    if (this.#scheduled || this.#disposed) return;
    this.#scheduled = true;
    requestAnimationFrame(() => {
      this.#scheduled = false;
      this.#flush();
    });
  }

  #flush() {
    if (this.#dirty.size === 0) return;
    const nodes = [...this.#dirty];
    this.#dirty.clear();
    for (const node of nodes) this.#process(node);
  }

  // ── text processing ───────────────────────────────────────────────────────

  /** Full sweep over every conversation container (belt-and-braces). */
  #scanAll() {
    if (this.#disposed) return;
    const containers = document.querySelectorAll(FLOW_SELECTOR);
    for (const container of containers) {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) this.#process(node);
    }
  }

  /** Recognize and wrap one text node when its data changed or is unknown. */
  #process(node) {
    if (node.nodeType !== 3) return;
    const data = node.data;
    if (data.length === 0 || data.length > MAX_TEXT_LENGTH) return;
    if (this.#processed.get(node) === data) return;
    if (!isEligible(node)) {
      this.#processed.set(node, data);
      return;
    }
    const matches = recognize(data);
    this.#processed.set(node, data);
    if (matches.length === 0) return;
    this.#wrap(node, matches);
  }

  /** Replace one text node with text + span fragments for every match. */
  #wrap(node, matches) {
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const match of matches) {
      if (match.start > cursor) fragment.appendChild(this.#text(node.data.slice(cursor, match.start)));
      const span = document.createElement("span");
      span.setAttribute(KIND_ATTR, match.kind);
      span.setAttribute(VALUE_ATTR, match.value);
      span.setAttribute(GUARD_ATTR, "");
      span.title = this.#titleOf(match.kind);
      span.textContent = node.data.slice(match.start, match.end);
      fragment.appendChild(span);
      cursor = match.end;
    }
    if (cursor < node.data.length) fragment.appendChild(this.#text(node.data.slice(cursor)));
    const parent = node.parentNode;
    if (parent !== null) parent.replaceChild(fragment, node);
  }

  /** Create a text node already marked as processed (never re-scanned). */
  #text(data) {
    const node = document.createTextNode(data);
    this.#processed.set(node, data);
    return node;
  }

  // ── click handling ────────────────────────────────────────────────────────

  #handleClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const span = target.closest(`[${KIND_ATTR}]`);
    if (span === null) return;
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    event.stopPropagation();
    const kind = span.getAttribute(KIND_ATTR);
    const value = span.getAttribute(VALUE_ATTR) ?? "";
    if (kind === "link") {
      window.open(value, "_blank", "noopener,noreferrer");
      return;
    }
    if (kind === "path") this.#onOpenPath(value);
  }
}
