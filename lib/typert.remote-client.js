// dsh-pathlink — hand-written Typert client Remote contribution (equivalent
// of the generated ./remote artifact). The browser half imports this module
// and mounts it through ctx.remote.$mount(...); exporting it also keeps the
// descriptors available to future client-side aggregation.
import { openRequestSchema, openResultSchema } from "./schemas.js";

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
            schema: openRequestSchema,
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: `${PACKAGE}#OpenResult`,
        schema: openResultSchema,
      },
      sourceLocation: { file: "lib/index.js", line: 1, column: 1 },
    },
  ],
};

export default TYPERT_REMOTE;
export { TYPERT_REMOTE };
