// Builds a standalone IIFE bundle of the recognizer for docs/demo.html, so
// the demo page reuses the exact production detection logic instead of a copy.
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";

const result = await build({
  entryPoints: ["src/client/pathlink-detect.js"],
  bundle: true,
  format: "iife",
  globalName: "DshplRecognize",
  platform: "browser",
  target: "es2020",
  write: false,
  logLevel: "info",
});

if (result.outputFiles.length !== 1) {
  throw new Error(`build-demo: expected one output file, got ${result.outputFiles.length}`);
}
mkdirSync("docs", { recursive: true });
writeFileSync("docs/demo-recognizer.js", result.outputFiles[0].text);
console.log(`build-demo: wrote docs/demo-recognizer.js (${result.outputFiles[0].contents.length} bytes)`);
