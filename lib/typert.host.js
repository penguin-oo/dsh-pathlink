// dsh-pathlink — hand-written Typert host manifest (equivalent of the
// generated ./typert artifact). Consumed by @deepseek-ai/dsh-typert-loader,
// which validates the shape at load time.
import { openRequestSchema, openResultSchema } from "./schemas.js";

// dsh 0.2: every strict codec needs a create() factory (memoized, as the
// official typert artifacts do).
let openRequestSchema$value;
const openRequestSchema$create = () => (openRequestSchema$value ??= openRequestSchema);
let openResultSchema$value;
const openResultSchema$create = () => (openResultSchema$value ??= openResultSchema);

const PACKAGE = "dsh-pathlink";

export const TYPERT = {
  package: PACKAGE,
  face: "host",
  schemas: [],
  invocations: [
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
  model: {
    services: [
      {
        key: "pathlink",
        exportName: "PathlinkService",
        tags: [],
        description:
          "Read-only sidecar service that opens the folder containing a recognized file path (or the folder itself) in the OS file manager. It resolves relative paths against the addressed session's working directory and never creates or resumes an Agent or Session.",
        summary: "Open folders from chat paths.",
        jsDoc: "/**\n * Read-only folder-opening sidecar service.\n */",
        members: [
          {
            kind: "method",
            name: "open",
            signature:
              "@Remote('open') open(request: OpenRequest): Promise<OpenResult>",
          },
        ],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
};
