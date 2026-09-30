// dsh-pathlink — hand-written Typert client Remote contribution (equivalent
// of the generated ./remote artifact). The browser half imports this module
// and mounts it through ctx.remote.$mount(...); exporting it also keeps the
// descriptors available to future client-side aggregation.
import { openRequestSchema, openResultSchema } from "./schemas.js";

// dsh 0.2: every strict codec needs a create() factory (memoized, as the
// official typert artifacts do).
let openRequestSchema$value;
const openRequestSchema$create = () => (openRequestSchema$value ??= openRequestSchema);
let openResultSchema$value;
const openResultSchema$create = () => (openResultSchema$value ??= openResultSchema);

const PACKAGE = "dsh-pathlink";

const TYPERT_REMOTE = {
  package: PACKAGE,
  descriptors: [
    {
      id: `${PACKAGE}#pathlink/open`,
      service: "pathlink",
      namespace: "pathlink",
      method: "open",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "request",
          wire: "request",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: `${PACKAGE}#OpenRequest`,
            create: openRequestSchema$create,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: `${PACKAGE}#OpenResult`,
        create: openResultSchema$create,
      },
      sourceLocation: { file: "lib/index.js", line: 1, column: 1 },
    },
  ],
};

export default TYPERT_REMOTE;
export { TYPERT_REMOTE };
