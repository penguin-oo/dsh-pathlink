var DshplRecognize = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/client/pathlink-detect.js
  var pathlink_detect_exports = {};
  __export(pathlink_detect_exports, {
    recognize: () => recognize
  });
  var URL_RE = /\bhttps?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_+.~#?&/=]*)/g;
  var WIN_ABS = /(?<![A-Za-z0-9_.])[A-Za-z]:[\\/](?:[^\\/:*?"<>|,\r\n]+[\\/])*[^\\/:*?"<>|,\r\n]+/g;
  var UNC = /\\\\[^\\/:*?"<>|,\r\n]+\\[^\\/:*?"<>|,\r\n]+(?:\\[^\\/:*?"<>|,\r\n]+)+/g;
  var POSIX_ABS = /(?<![A-Za-z0-9_])\/(?:[A-Za-z0-9_@%+=:,.-]+)(?:\/[A-Za-z0-9_@%+=:,.-]+)+/g;
  var REL_EXPLICIT = /(?<![A-Za-z0-9_.])(?:\.{1,2}[\\/])+(?:[A-Za-z0-9_@%+=:,.-]+)(?:[\\/][A-Za-z0-9_@%+=:,.-]+)+/g;
  var REL_BARE = /(?<![A-Za-z0-9_.])(?:[A-Za-z0-9_@%+=:,.-]+[\\/]){1,4}[A-Za-z0-9_@%+=:,.-]+\.(?:[A-Za-z0-9]{1,16})/g;
  function recognize(text) {
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
  var TRAILING = new Set("),;:\uFF0C\u3002\uFF1B]}>\"'`");
  function isCjk(character) {
    const code = character.codePointAt(0);
    return code >= 19968 && code <= 40959 || code >= 12288 && code <= 12351 || code >= 65280 && code <= 65519;
  }
  function trimEdge(raw) {
    let end = raw.length;
    for (let index = 0; index + 1 < raw.length; index += 1) {
      const before = raw[index];
      const after = raw[index + 1];
      if ((before === " " || before === "	" || before === "\u3000") && isCjk(after)) {
        end = index + 1;
        break;
      }
    }
    while (end > 0) {
      const character = raw[end - 1];
      if (TRAILING.has(character) || character === " " || character === "	" || character === "\u3000" || isCjk(character))
        end -= 1;
      else break;
    }
    let start = 0;
    while (start < end && "([{<\"'`".includes(raw[start])) start += 1;
    return { value: raw.slice(start, end), head: start, tail: raw.length - end };
  }
  function trimUrl(raw) {
    const URL_TRAILING = new Set(".,;:!?'\"`)]}>\uFF0C\u3002\uFF1B\uFF1A\uFF01\uFF1F\u3001\u3011\u300B\u300D\u300F");
    let end = raw.length;
    while (end > 0 && URL_TRAILING.has(raw[end - 1])) end -= 1;
    return { value: raw.slice(0, end), tail: raw.length - end };
  }
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
  return __toCommonJS(pathlink_detect_exports);
})();
