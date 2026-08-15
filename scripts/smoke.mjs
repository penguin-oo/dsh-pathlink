// CI-friendly host smoke test: module import, Remote markers, Typert manifest
// validation, and the Remote contribution descriptors.
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";
import { validateTypertManifest } from "@deepseek-ai/dsh-typert-loader";
import { PathlinkService } from "../lib/index.js";
import { TYPERT } from "../lib/typert.host.js";
import { TYPERT_REMOTE } from "../lib/typert.remote-client.js";

const dummy = Object.create(PathlinkService.prototype);
const methods = remoteMethods(dummy).map((m) => `${m.method}/${m.invocation.kind}`);
const expected = ["open/direct"];
if (methods.join(",") !== expected.join(",")) {
  throw new Error(`pathlink: Remote markers mismatch — got [${methods.join(", ")}]`);
}
validateTypertManifest("dsh-pathlink", TYPERT);
if (TYPERT_REMOTE.descriptors.length !== 1) {
  throw new Error(`pathlink: expected 1 Remote descriptor, got ${TYPERT_REMOTE.descriptors.length}`);
}
console.log("smoke: OK —", methods.join(", "));
