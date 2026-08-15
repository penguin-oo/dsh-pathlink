// dsh-pathlink — wire zod schemas shared by the host Typert manifest, the
// Remote client contribution, and the runtime service. Failure branches are
// precise discriminated unions so strict codecs never strip payload fields.
import { z } from "zod";

// ── requests ────────────────────────────────────────────────────────────────

/**
 * One open request: the raw path text as it appeared in the message plus the
 * session that displayed it, used to resolve relative paths against that
 * session's working directory. `sessionId` is `null` when the client cannot
 * attribute the message to a session.
 */
export const openRequestSchema = z
  .object({
    sessionId: z.union([z.null(), z.string().min(1).max(160)]),
    path: z
      .string()
      .min(1, "pathlink: path must not be blank")
      .max(4096, "pathlink: path exceeds the wire bound")
      .refine((value) => !value.includes("\u0000"), {
        message: "pathlink: path must not contain NUL bytes",
      }),
  })
  .describe("openRequest");

// ── results ─────────────────────────────────────────────────────────────────

/** Success branch: what was opened, and the exact path handed to the OS. */
const openValueSchema = z.object({
  kind: z.enum(["file", "folder"]),
  resolved: z.string().max(4096),
});

/** Business-failure branches, one per failure mode. */
const openErrorSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("path-blank") }),
  z.object({
    code: z.literal("path-too-long"),
    maxChars: z.number().int().positive(),
  }),
  z.object({
    code: z.literal("path-not-found"),
    tried: z.array(z.string().max(4096)),
  }),
  z.object({
    code: z.literal("unsupported-platform"),
    platform: z.string(),
  }),
]);

/** Strict result union: every branch is exact, so codecs keep all fields. */
export const openResultSchema = z
  .discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value: openValueSchema }),
    z.object({ ok: z.literal(false), error: openErrorSchema }),
  ])
  .describe("openResult");
