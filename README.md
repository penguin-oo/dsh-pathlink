# dsh-pathlink

**Ctrl+click file paths and links in DeepSeek Harness chat.**

Recognizes file paths and URLs in rendered chat messages (assistant replies, user
bubbles, code blocks, tool cards), marks them with a subtle dotted underline,
and opens them with **Ctrl+click** (⌘ on macOS):

- **Path → containing folder** — the file's folder opens in the OS file manager
  with the file selected (Windows `explorer /select`, macOS `open -R`, Linux
  `xdg-open` on the parent directory). A path that names a directory opens the
  directory itself.
- **Link → new browser tab** — covers bare URLs the renderer did not linkify
  (e.g. in user bubbles); markdown links already open in new tabs natively.

Plain clicks stay inert, so text selection and copy are never disturbed. When a
path does not exist, a small toast explains why instead of failing silently.

![demo](docs/screenshot-demo.png)

> The screenshot above is from the bundled local demo page (`docs/demo.html`),
> which reuses the exact production recognizer.

## Install

```sh
dsh plugin --profile web add dsh-pathlink
```

or via GitHub:

```sh
dsh plugin --profile web add github:penguin-oo/dsh-pathlink
```

Restart the web GUI afterwards. Requires the **web** profile (a browser is the
only surface that can receive the click).

## Usage

1. Wait for a settled message that mentions a path or a link — recognized
   tokens get a **dotted underline**.
2. Hold **Ctrl** (or **⌘** on macOS) and click.
   - Path → folder opens in Explorer/Finder with the file selected.
   - Link → opens in a new browser tab.
3. Relative paths resolve against the session's workspace directory first,
   then the harness working directory; missing paths show a toast.

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `maxPathChars` | `1024` | Longest accepted path text, in characters |

## How it works

- **Client half** (`dsh.client`, platform `web`): a MutationObserver-driven
  scanner watches the rendered conversation containers (`data-chat-flow` /
  `data-conversation-scroll`), recognizes paths and URLs in text nodes, wraps
  matches in inert inline spans, and handles one delegated capture-phase click
  listener. The official `chatFileMentions` seam is deliberately not used so
  the plugin never conflicts with the built-in deliverables provider and
  covers every surface uniformly.
- **Host half** (`pathlink` Remote service): one read-only `open` method that
  resolves relative paths against the addressed session's working directory,
  verifies existence, and launches the platform file manager. No durable
  state; it never creates or resumes an Agent or Session.

## Development

```sh
npm install
npm run build   # bundle src/client → lib/client.js
npm run smoke   # Remote markers + Typert manifest validation
node scripts/e2e-synthetic.mjs   # browser E2E against http://127.0.0.1:3738
```

`docs/demo.html` is built with `node scripts/build-demo.mjs` (reuses the
production recognizer) and screenshotted by `node scripts/e2e-screenshot.mjs`.

## Limitations

- Web GUI only (the click surface is a browser); the host opener covers
  Windows / macOS / Linux.
- Path recognition is heuristic: CJK directory names survive, but a path whose
  final segment is a bare English word (no extension) followed directly by
  prose may occasionally be over-matched — the existence check then shows the
  not-found toast instead of opening anything wrong.

## License

MIT

## Acknowledgements

Built for the DeepSeek Harness plugin ecosystem — thanks to the community on
[LINUX DO](https://linux.do/) for feedback and testing.
