import { recognize } from "../src/client/pathlink-detect.js";

const t = "试试 D:\\deepseekhrness\\dsh-pathlink\\src\\client\\index.js 和 https://example.com/x 与";
console.log("recognize:", JSON.stringify(recognize(t), null, 1));

const WIN_ABS = /(?<![A-Za-z0-9_.])[A-Za-z]:[\\/](?:[^\\/:*?"<>|,\r\n]+[\\/])*[^\\/:*?"<>|,\r\n]+/g;
const POSIX_ABS = /(?<![A-Za-z0-9_])\/(?:[A-Za-z0-9_@%+=:,.-]+)(?:\/[A-Za-z0-9_@%+=:,.-]+)+/g;
const URL_RE = /\bhttps?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_+.~#?&/=]*)/g;

console.log("WIN:", [...t.matchAll(WIN_ABS)].map((m) => [m.index, m[0]]));
console.log("POSIX:", [...t.matchAll(POSIX_ABS)].map((m) => [m.index, m[0]]));
console.log("URL:", [...t.matchAll(URL_RE)].map((m) => [m.index, m[0]]));
