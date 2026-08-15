// dsh-pathlink — pure text recognizer for file paths and URLs in chat text.
// No DOM access here; the scanner layer feeds it text-node strings and wraps
// the returned ranges.

// ── URL patterns ────────────────────────────────────────────────────────────

/** Explicit http(s) URL. Conservative: no scheme-less matching. */
const URL_RE =
  /\bhttps?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_+.~#?&/=]*)/g;

// ── path patterns ───────────────────────────────────────────────────────────

/** One segment of a path: anything but whitespace and shell/URL metacharacters. */
const SEGMENT = "[^\\s<>\"|?*]+";

/** Windows drive absolute: C:\... or C:/... (comma excluded so "a.txt, b.py" splits). */
const WIN_ABS = /(?<![A-Za-z0-9_.])[A-Za-z]:[\\/](?:[^\\/:*?"<>|,\r\n]+[\\/])*[^\\/:*?"<>|,\r\n]+/g;

/** UNC: \\server\share\... */
const UNC = /\\\\[^\\/:*?"<>|,\r\n]+\\[^\\/:*?"<>|,\r\n]+(?:\\[^\\/:*?"<>|,\r\n]+)+/g;

/** POSIX absolute: /a/b/... with at least two segments. */
const POSIX_ABS = /(?<![A-Za-z0-9_])\/(?:[A-Za-z0-9_@%+=:,.-]+)(?:\/[A-Za-z0-9_@%+=:,.-]+)+/g;

/** Explicit relative: ./a/b or ../a/b */
const REL_EXPLICIT = /(?<![A-Za-z0-9_.])(?:\.{1,2}[\\/])+(?:[A-Za-z0-9_@%+=:,.-]+)(?:[\\/][A-Za-z0-9_@%+=:,.-]+)+/g;

/**
 * Bare relative like src/main.js or scripts/build.mjs: at least one separator
 * and an extension-ish tail, which keeps false positives out of prose.
 */
const REL_BARE = /(?<![A-Za-z0-9_.])(?:[A-Za-z0-9_@%+=:,.-]+[\\/]){1,4}[A-Za-z0-9_@%+=:,.-]+\.(?:[A-Za-z0-9]{1,16})/g;

/**
 * Recognized matches, ordered by start position, longest first at equal
 * starts. URL matches win over path matches that overlap them (a URL always
 * contains slashes but is not a file path).
 * @param {string} text
 * @returns {{start:number, end:number, kind:"path"|"link", value:string}[]}
 */
export function recognize(text) {
  const matches = [];
  for (const regex of [WIN_ABS, UNC, POSIX_ABS, REL_EXPLICIT, REL_BARE]) {
    for (const match of text.matchAll(regex)) {
      const [raw] = match;
      const { value, head, tail } = trimEdge(raw);
      const start = match.index + head;
      const end = match.index + raw.length - tail;
      matches.push({ start, end, kind: "path", value });
    }
  }
  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0];
    const { value, tail } = trimUrl(raw);
    const start = match.index;
    matches.push({ start, end: start + raw.length - tail, kind: "link", value });
  }
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  return dropOverlaps(matches);
}

/** Characters that end a sentence rather than belong to a path. */
const TRAILING = new Set("),;:，。；]}>\"'`");

/** Whether one character is a CJK glyph or full-width punctuation. */
function isCjk(character) {
  const code = character.codePointAt(0);
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

/**
 * Trim characters that belong to the sentence, not the path: cut at the
 * first whitespace-followed CJK glyph (the next sentence starts there, while
 * CJK directory names glued to a segment survive), then strip trailing
 * closing brackets, quotes, punctuation, whitespace, and CJK prose, plus a
 * leading opening bracket.
 * @returns {{value: string, head: number, tail: number}} the trimmed text and
 *   how many characters were stripped from each end (so callers can adjust
 *   match bounds for overlap resolution).
 */
function trimEdge(raw) {
  let end = raw.length;
  for (let index = 0; index + 1 < raw.length; index += 1) {
    const before = raw[index];
    const after = raw[index + 1];
    if ((before === " " || before === "\t" || before === "\u3000") && isCjk(after)) {
      end = index + 1;
      break;
    }
  }
  while (end > 0) {
    const character = raw[end - 1];
    if (
      TRAILING.has(character) ||
      character === " " ||
      character === "\t" ||
      character === "\u3000" ||
      isCjk(character)
    )
      end -= 1;
    else break;
  }
  let start = 0;
  while (start < end && "([{<\"'`".includes(raw[start])) start += 1;
  return { value: raw.slice(start, end), head: start, tail: raw.length - end };
}

/**
 * Strip sentence punctuation off a URL tail (e.g. "https://x.com/a)." →
 * "https://x.com/a"). Never strips a `/`, `?`, `&`, `=`, or `#`.
 */
function trimUrl(raw) {
  const URL_TRAILING = new Set(".,;:!?'\"`)]}>，。；：！？、】》」』");
  let end = raw.length;
  while (end > 0 && URL_TRAILING.has(raw[end - 1])) end -= 1;
  return { value: raw.slice(0, end), tail: raw.length - end };
}

/**
 * Drop matches that overlap an earlier, longer-or-equal match (sort order
 * puts the winner first); keeps links over paths of equal span.
 */
function dropOverlaps(sorted) {
  const kept = [];
  let boundary = -1;
  for (const match of sorted) {
    if (match.start < boundary) continue;
    kept.push(match);
    boundary = match.end;
  }
  return kept;
}
