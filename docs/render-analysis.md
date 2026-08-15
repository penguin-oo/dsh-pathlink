# DSH 前端「消息路径/链接识别 + Ctrl+点击」cliente 插件可行性分析

> 分析对象：`C:\Users\MECHREVO\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai`
> 分析方式：read/grep/glob 读打包产物（`lib/client.js`、`lib/index.js`）与 `.d.ts` 类型声明（含完整 JSDoc 契约说明）。
> 结论时间点：DSH `0.1.0-rc.6` 一代的 client 包袱。

---

## 0. 总体结论（TL;DR）

DSH 前端**已经内置了一条官方的、几乎正好命中本需求的链路**：

- Markdown 用一个**自研的 mdast→React 渲染器**（非 react-markdown / markdown-it）直接渲染，链接已渲染成 `<a target="_blank" rel="noopener noreferrer">`。
- 存在一个官方的 **`MarkdownFileMentions` / `chatFileMentions`** 服务缝：把「行内代码 token」解析为「可点击打开的文件」，点击后调用 `openFile(path)` → `ctx.workspaces.openPath(...)`，在宿主操作系统里打开文件/文件夹。
- 现成例子就是 **`dsh-client-ui-deliverables`** 插件：它已经实现了「识别本 turn 产生的文件路径 → 渲染为可点击 chip + 行内代码 file-mention」。
- 每条消息的**动作条**有官方槽位 `conversation.chat.assistant-actions`（list），`dsh-client-ui-message-feedback` 就是通过它挂 Like/Dislike 按钮，纯槽位方式、不动 DOM。

**推荐接入方案**：优先走官方缝（`chatFileMentions` 服务 + `ctx.workspaces.openPath`），而不是 MutationObserver。两者可组合：用官方服务缝做「已知文件的高亮/点击」，用一层轻量的「捕获阶段 click 委托 + Ctrl/⌘ 修饰键判断」做「任意路径文本的 Ctrl+点击 → 打开所在文件夹」这一增量能力。

---

## 1. 消息正文由谁渲染？markdown 用什么渲染？链接是否已 `<a>`？

### 1.1 组件链

消息正文（用户与助手）由 `dsh-client-ui-conversation` 渲染，`chat view` 通过 keyed 槽位 `conversation.chat.node` 按节点类型分发：

- 助手正文：`AssistantNodeView`（`lib/types/client/chat/AssistantNodeView.d.ts` / 同名 .js in client.js）→ `AssistantMarkdown`（`react.memo`）→ `MarkdownText`（`dsh-client-ui-primitives`）。
- 用户正文：`UserMessageNodeView`（`MessageItem.d.ts`），渲染成 `.userRow > .userStack > .bubble`（文本非 markdown，直接文本）。
- `MessageItem.d.ts` 声明了全部 keyed renderer：`UserMessageNodeView` / `ContextMessageNodeView` / `CompactionNodeView` / `RetryNodeView` / `TurnErrorNodeView` / `TurnMaxTokensNodeView` / `UnknownNodeView`。

`AssistantMarkdownProps`（`AssistantMarkdown.d.ts`）字段：

```ts
blocks: readonly AssistantBlock[]; streaming: boolean; interrupted?; loadImage?;
mentions?: MarkdownFileMentions | undefined; t;
```

### 1.2 markdown 渲染器（关键）

`dsh-client-ui-primitives` 的 `markdown/render.d.ts` 第一段即写明：

> "Direct mdast→React markdown renderer. Replaces the react-markdown / remark-rehype pipeline with one switch over parsed nodes so streaming can cache frozen blocks as React elements…"

- **不是** react-markdown（虽然它曾是，现已被替换）；**不是** markdown-it；是**自研的 mdast→React** 直渲。
- 解析用 micromark 生态：`mdast-util-from-markdown` + `mdast-util-gfm` + `mdast-util-math` + `micromark-*`（见 `package.json` deps）。
- 流式：`MarkdownText` 是 `react.memo`，流式时**只重解析 tail，前面的 block 冻结成缓存 React element**（`incremental` / `PositionedBlock`），key 稳定 → React reconcile 而非 remount。这对 MutationObserver 方案是**好消息**（前面的 DOM 不会被整段替换，只在 tail 追加/替换尾部节点）。

### 1.3 链接渲染（已 `<a>`，且已 `target=_blank`）

`dsh-client-ui-primitives/lib/index.js`：

- `renderSafeLink(href, children, key)`（约 5295 行）：`sanitizeUrl` 通过后渲染 `<a href target="_blank" rel="noopener noreferrer">`（仅对 `http:`/`https:` 加 target/rel）。
- `renderNode` 的 `case "link"` → `renderAnchor` → `normalizeUri` → `renderSafeLink`。
- 行内代码若**恰为绝对 HTTP(S) URL**，也渲染成 `<a>`（`inlineCodeHttpUrl` → `renderSafeLink`）。
- **raw HTML 一律当字面文本**，不进入 DOM；`javascript:`/`data:`/`file:`/相对链接/锚点都被 allowlist 拦掉，渲染为纯文本。所以**无法靠现有 `<a>` 承载「文件路径」链接**（file: 被禁用）。

即：**URL 已经有现成 `<a target=_blank>`，无需自己改新标签页**；唯一缺的是「Ctrl+点击在**新标签页打开**」的增量（默认就是新标签页，Ctrl 反而想要「同页」，见 §5）。

---

## 2. 官方「自定义文本/链接渲染」缝

存在，而且就是为「文件路径可点击」而设计的：

1. **`MarkdownFileMentions` 接口**（`markdown/render.d.ts`）：

   ```ts
   interface MarkdownFileMentions {
     resolve(value: string): { open: () => void; label: string; title: string } | undefined;
   }
   ```

   被 `MarkdownText` 的 `fileMentions` prop 消费。`renderNode` 的 `case "inlineCode"`（index.js 5181 行）：

   ```js
   const mention = context.inLink ? undefined : context.fileMentions?.resolve(value);
   if (mention) return <code><button class=fileMention title onClick={mention.open}>{value}</button></code>;
   ```

   **限制**：只作用于**行内代码 token**（反引号包裹的 `` `path` ``），且**只在 settled（非流式）渲染**时生效（流式时词汇不确定，冻结缓存不能烘焙会过期的 handler）。

2. **`ChatFileMentions` 服务**（`conversation/contract/slots.d.ts` 351 行）：通过 **`ctx.get("chatFileMentions")`** 获取（可选服务约定），提供 `forClosing(owner: TurnTailOwnerProps): MarkdownFileMentions | undefined`。`owner` 里带 `openFile(path)`、`turn`、`seq`。

3. **槽位系统**（`dsh-client-ui-slots`，`Slots` 是 `ctx.slots`）：这是 DSH client 插件**唯一官方扩展现有 UI 的方式**——`declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap {...} }` 合并式声明，`ctx.slots.register({ name, ... }, Component)` 注册，`ctx.slots.inject(key, cb)` 生命周期。槽位类型：`single` / `list` / `keyed` / `chain`，scope `root` / `session` / `session-maybe`。

   与本需求直接相关的槽位（`conversation/contract/slots.d.ts` 汇总）：

   | 槽位 key | kind | 用途 |
   |---|---|---|
   | `conversation.chat.assistant-actions` | list | **每条定稿助手消息的动作条**，owner 传 `messageId` |
   | `conversation.chat.node` | keyed | 按 `ChatNodeKind` 分发业务节点渲染器（含 `assistant`） |
   | `conversation.chat.turnTail` | chain | turn 尾部扩展链，owner 含 `openFile`/`turn`/`seq` |
   | `conversation.chat.commandview` | keyed | 命令行渲染 |
   | `conversation.view` | list | 整个会话视图 tab |
   | 各种 `.composer.*` / `.input.*` | — | 输入区扩展（与正文点击无关） |

   - **`conversation.chat.node` 的 owner**（`ChatNodeOwnerProps`，slots.d.ts 400 行）**直接给 renderer `openFile(path)`、`cwd`、`fileMentions(...)`、`loadImage`、`forkAt`、`inspectCall`**！也就是说：**只要注册一个 `assistant`（或自定义）node 渲染器，就能拿到现成的 `openFile` 回调与 `cwd`**，无需去碰 DOM 或自己找 remote。
   - `ChatNodeViewProps<Kind>` = `PropsRuntime<'conversation.chat.node', Kind> & PropsLocale`，其中 owner 部分就是上表的 `ChatNodeOwnerProps`。

   注意：`conversation.chat.node` 是 keyed+session scope，被 chat view（`conversation.view` 的 `children`）声明；`registerChatNodeRenderers(ctx)`（`register-node-renderers.d.ts`）是 conversation 内部注册自家渲染器的函数。

4. **provider 缝**：`ctx.provide(name, impl)` / `ctx.get(name)`（cordis 服务），例如 `ctx.provide("chatFileMentions", {...})`（deliverables 就这么做）。这也是干净的自定义渲染数据源扩展点。

---

## 3. 渲染后消息 DOM 结构

从 `dsh-client-ui-conversation/lib/client.js` 的 JSX + CSS module 常量里提取到的关键结构（class 名是 hashed CSS module）：

- **滚动容器**：`.Md3f7G_scroll`（`ChatView`），带 `data-conversation-scroll` 属性在更外层 scrollport。
- **消息流列**：`.Md3f7G_column`，属性 **`data-chat-flow`**。
- **每条 flow item**：`.Md3f7G_flowItem`，带三个稳定语义属性（`ChatView` 约 5227 行）：

  ```html
  <div class="Md3f7G_flowItem" data-chat-anchor-key="…" data-chat-flow-key="…" data-chat-flow-kind="assistant|user|command|tool-call|…">
  ```

  - `data-chat-flow-kind` = `routedNode.kind`，是本插件做 DOM 定位/命中过滤最可靠的钩子。
  - `data-chat-anchor-key` 用作滚动锚点（内部 `list.querySelectorAll("[data-chat-anchor-key]")`）。
- **用户消息**：`.gdEzaW_userRow[data-time-hover-root][data-pending-steering?] > .gdEzaW_userStack > .gdEzaW_bubble`。
- **助手动作条**：`.p-xYUq_actions`（`MessageIconActions`），内含 `.p-xYUq_action`（28×28 圆角 icon 按钮）、`extraActions` 参数渲染槽位结果（feedback 按钮就 render 在这里）、时间 `.p-xYUq_timeStart/End`、复制/分支按钮。
- **markdown 根**：`.markdown`（`MarkdownText_module_css_default.markdown`），链接 `<a>`、代码块 `CodeBlock`、表格 `.tableScroll`、行内代码 `<code>`、file-mention `<button class="fileMention">`。
- **assistant 停止标记**：`data-state` 等（见 9080 附近 `message.stopped`）。

命名规律：**纯 hashed CSS module**（`.Md3f7G_`、`.gdEzaW_`、`.p-xYUq_`、`.P4kPIW_`、`.ZuhsRW_`、`.pC0e7a_` 等，对应 package + 模块名），**不要对 class 名做稳定匹配**；**要匹配就匹配 `data-*` 属性**（`data-chat-flow-kind`、`data-chat-anchor-key`、`data-conversation-scroll`、`data-time-hover-root`、`data-composer-card`、`data-context-*` 等，这些是人为稳定语义名）。

**流式重渲染对 MutationObserver 的影响**：`MarkdownText` 的冻结缓存机制保证**前面已渲染 block 的 React element 是缓存的**，流式只追加/替换尾部 → 大部分 message DOM 子树在流式期间是**稳定的**；但 message 容器会被 React 重渲染（props 变化）。若用 MutationObserver，应观察 `data-chat-flow` 容器并**用 `data-chat-flow-key` 去重**（每条消息处理一次，或按增量处理新增 child），且要能承受尾部节点反复替换。整体上，官方缝 > 粗暴全量 MutationObserver，官方缝已经绕过了「哪些 token 是文件」的判断难题（deliverables 用工具产物的 `locations` 精确决定）。

---

## 4. `dsh-client-ui-message-feedback` 如何挂按钮（client 插件范例）

完整读 `lib/client.js`，非常干净，纯槽位、零 DOM 操作：

1. 打包为 `window.__ModuleLoader__.load({ id, factory(require){...} })`（见 §6）。
2. 导出：
   ```js
   exports.apply = apply;
   exports.inject = inject;   // inject = ["slots","remote","remote.messageFeedback","locale"]
   ```
   - `inject` 是**依赖服务名数组**，cordis 会等这些服务就绪/注入。
   - `remote.messageFeedback` 的 `remote` 是**业务 Remote namespace**，`ctx.remote`（注意这里用 `remote.messageFeedback`，即 `ctx.remote.messageFeedback`）。
3. `apply(ctx)` 内：
   ```js
   ctx.slots.inject("conversation.chat.assistant-actions", () => {
     const dispose = ctx.slots.register({
       name: "conversation.chat.assistant-actions",
       id: "feedback", order: 10, locale: "feedback",
       inject: (sessionId) => ({ hooks: { feedback: controller }, ensure, rate, toggle, clearNote, clear })
     }, MessageFeedbackActions);
     return () => { dispose(); /* 清理 controller */ };
   });
   ```
4. 组件 `MessageFeedbackActions({ messageId, ensure, rate, ..., useFeedback, t })`：
   - **`messageId` 直接来自槽位 owner**（`AssistantActionOwnerProps` → `messageId`），无需自己找。
   - `useFeedback` 是 framework 把 `hooks.feedback`（`HostObservable`）绑定成的 selector hook。
   - 按钮 `onClick` → `toggle(messageId, rating)` → controller → `remote.messageFeedback.put/delete/list`。

**结论**：这是挂「每条消息动作」的标准姿势。但注意：`conversation.chat.assistant-actions` 的 owner 只给 `messageId`，**不给正文文本**（正文不在 owner 里）。若插件只想要「在某条消息上放一个动作按钮」，走这个槽位即可；但本需求是**要识别正文里的路径文本**，动作条槽位帮不上，真正对口的是 §2 的 `chatFileMentions` 服务 / `conversation.chat.node` owner（那里有 `openFile` 和 turn 数据），或 DOM 方案。

---

## 5. 消息内容点击事件缝 / 键盘修饰键惯例

- **没有统一的全局消息点击 handler / 快捷键体系**对正文生效。body 级点击处理只见于具体组件自己的 `onClick`（copy、feedback、branch、compact 等）。
- **Ctrl/⌘ 修饰键惯例**：只在 `InputBar` 的键盘处理里有统一处理（`dsh-client-ui-conversation/lib/client.js` 3466-3498 行）：
  ```js
  const accelerated = e.ctrlKey || e.metaKey;   // 统一把 Ctrl 与 ⌘ 当同一修饰键
  if ((e.metaKey || e.ctrlKey) && (key==='z'||key==='y')) … undo/redo
  ```
  即 DSH 的惯例是 **`ctrlKey || metaKey` 视为同一修饰键**（跨平台 accelerant 判断）。你的插件应沿用 `const accel = e.ctrlKey || e.metaKey`。
- 现有链接点击是新标签页（`target=_blank`），**没有**「Ctrl+点击=同页/不同行为」的拦截器。若你实现「Ctrl+点击链接在新标签页」，由于默认已新标签页，实际需要的是：**无修饰点击=X / Ctrl+点击=Y** 的分支语义，需要你自己在 `<a>` 上（或委托）加 click 拦截。
- 没有发现 MutationObserver 在前端核心里的使用惯例（有几处 `ResizeObserver`、`getComputedStyle`，但都是测量布局，非内容扫描）。

---

## 6. `dsh-client-modules` 的 `__ModuleLoader__` API 与可 require 清单

### 6.1 运行模型（`manifest.d.ts` + `system.d.ts`）

- 浏览器侧是一个 **lazy CJS 表**：`ClientModuleSystem implements ClientModuleLoader`。
- 每个插件 bundle 执行时只**注册工厂**：`window.__ModuleLoader__.load({ id, factory })`；factory 闭包内 `require(spec)`，**首次 import/require 时才 materialize（执行副作用）**，结果 memoize 到 `loadCache`。
- `require` 解析顺序：**seed 词 → shell 静态注册 → 已 memoize 记录 → 已注册 factory（递归 materialize）**；（`import` 多一个「graph row → fetch bundle + materialize」）。`require` 只能拿到**已注册**的模块；`import(specifier)` 能触发 fetch。
- API 面（`ClientModuleLoader` / `ClientModuleSystem`）：
  - `import(specifier, parentURL, attrs): Promise<unknown>`
  - `registerStatic(id, module)`
  - `prefetch(id): Promise<void>`
  - `invalidate(id): void`
  - `loadCache: Map<string, ClientModuleRecord>`
  - `version: 'client'`
  - window 槽：`__DSH_BOOT__`（graph）、`__ModuleLoader__.load(handoff)`、`__DSH_MODULES__`（kernel 实例）。
  - `ctx.modules`（cordis Context 挂载），由 `./client` wrapper `apply(ctx)` 提供。

**插件自己的 exports 是 `{ apply, inject }`**（`apply(ctx)` + `inject: string[]`），由 cordis Loader 消费。这是 client 插件的唯一入口约定。

### 6.2 可 `require` 的模块清单（seed，唯一权威）

来自 `dsh-client-web/lib/index.js` `getStaticModules()`（165-178 行），这是**平台单例表**，每个 bundle 的 externals 都对着它：

```js
{
  "react": React,
  "react/jsx-runtime": ReactJsxRuntime,
  "react-dom": ReactDom,
  "react-dom/client": ReactDomClient,
  "@deepseek-ai/cordis": Cordis,
  "@deepseek-ai/dsh-client-ui-slots": UiSlots,          // ctx.slots 类型/契约
  "@deepseek-ai/dsh-client-web-react": WebReact,          // createSlotRenderer/useInvoke 等
  "@deepseek-ai/dsh-client-ui-primitives": UiPrimitives,  // MarkdownText/按钮/图标/CodeBlock 等
  "@deepseek-ai/dsh-client-ui-attachment": UiAttachment,
  "@deepseek-ai/dsh-client-schema-form": SchemaForm
}
```

另有 shell 静态注册：`APP_SHELL_ID = "@deepseek-ai/dsh-client-app-shell"`（`registerStatic`），以及 `MODULES_ID = "@deepseek-ai/dsh-client-modules"`。

**其余 `@deepseek-ai/dsh-client-*` 包是通过 graph（host 注入 `__DSH_BOOT__`）动态 prefetch/import 的 bundle**（如 `dsh-client-runtime/client`、`dsh-client-connection/client`、`dsh-client-ui-conversation` 等），它们在工厂里被 `require(...)` 依赖时，由「已注册 factory → materialize」或「graph row → fetch」解析。**你的插件若要 import 这些包，必须依赖它们在 graph 里且被 `require`**；值导入（cross-plugin value import）在建时的 bundle 纯度门口已被禁止，factory 里 `require("react")` 等 seed 词是安全路径。

> 关键约束（manifest.d.ts 注释）：`require` 是**同步**的，走 seed → static → memoized → factory，**不包括 fetch**；所以工厂内 `require` 一个「未注册的 graph 模块」会 loud throw。插件工厂顶层能安全 `require` 的只有上表 seed 词 + app-shell/modules。要拿 runtime 类型/函数（如 `resolveWorkspacePath`），靠 `dsh-client-runtime/client`——它在 graph 里由 runtime 插件自身 materialize 后可用（deliverables factory 里 `require("@deepseek-ai/dsh-client-runtime/client")` 成功，说明该包已作为立即 tier 注册）。

---

## 7. DSH 是否已有「文件路径」高亮/点击处理？（搜 path/highlight/mention/clickable/regex）

**已经有一整套，落在 `dsh-client-ui-deliverables`（client 插件）+ `dsh-client-ui-primitives` 的 mention 渲染：**

- **识别来源不是 regex 猜路径**，而是**工具产物**：deliverables 通过 `conversationEvents.register(deliverablesDefinition)`（第 343 行）订阅 `turn/start`/`tool/call`/`tool/result`，从「diff 卡片」或 `kind==='edit'` 的 generic 卡片的 `locations[]` 提取**真正创建/修改过的文件路径**（`producedPaths` / `producedForClosing`）。
- **渲染两个面**：
  1. **产文件 chip 行** `ProducedFiles`（`conversation.chat.turnTail` 链，`selectProducedFiles` 匹配）：`.P4kPIW_root` + `.P4kPIW_file` button，`onClick → openFile(path)`；还有 `data-produced-files-row` 属性；隐藏产物过多时显示 `showInFolder`（`openFile(".")` → "在文件夹中显示"）。
  2. **行内代码 file-mention**：`ctx.provide("chatFileMentions", { forClosing(owner) {...} })`（第 358 行）→ `producedFileMentions(paths, owner.openFile, label)` → `MarkdownFileMentions.resolve`。`resolve` 用**精确路径匹配**或**唯一 basename 匹配**（两路径同 basename 则不点击，避免开错文件）。
- **打开路径** = `owner.openFile(path)` → chat view 的 `openFile`（`conversation/client.js` 9731 行）：

  ```js
  openFile: (path) => {
    const cwd = sessions.list.getSnapshot().byId[sessionId]?.cwd;
    workspaces.openPath(resolveWorkspacePath(cwd, path)).catch(()=>{});
  }
  ```

  `resolveWorkspacePath`（`dsh-client-runtime/client` `workspaces/path.ts`）：相对路径按 session `cwd` 解析成绝对路径。
- **`ctx.workspaces.openPath(path)`**（`dsh-client-runtime` `contract/workspaces.d.ts` / `workspaces/service.d.ts` 119 行）→ host RPC `host.openPath`（`dsh-host-apiproxy` `api/host`）→ **用宿主 OS 默认应用打开该路径**（文件则打开该文件=`openFile`；目录则打开目录，等于「打开所在文件夹」）。

  > 因此「Ctrl+点击路径 → **打开所在文件夹**」可以直接 = `ctx.workspaces.openPath(<所在目录>)`（或 `openPath(".")` 相对 cwd）。若要更精确的「在文件管理器中定位并选中」，host 层 face 里没有单独 reveal-选中 primitive（见 `dsh-host-apiproxy` `api-proxy.d.ts` 与 `native-path-opener.js` 有 darwin `-R` / win 平台分支），client 侧可复用 `openPath(dir)` 打开目录这一语义。

- **目录选择器里的路径展示**（`dsh-client-ui-directory-picker-browse/lib/client.js`）：Miller 列 + 面包屑（`.ZuhsRW_crumb` / `.ZuhsRW_crumbBar` / `.ZuhsRW_pathInput`）。面包屑 crumb `onClick → navigate(crumb.path)`，通过 `ctx.workspaces.listDirectory/createDirectory`（第 1022-1023 行）工作。列条目 `.ZuhsRW_row[.rowSelected]` + `.ZuhsRW_rowName`，`onClick → onPick(entry.path)`。**这印证 `ctx.workspaces` 是 client 插件直接可用的服务**（目录选择器插件就是 `ctx.workspaces.*` 调用者）。
- `highlight` 关键词只指**代码语法高亮**（shiki，`markdown/highlight.d.ts`），与路径无关。
- `clickable`/`mention`：menton 就是上面这套 file-mention；没有其它独立 mention 系统（`@`/`/` lexicon 是输入法提及菜单，非消息正文）。

**结论**: 路径高亮/点击**已经存在**，但仅覆盖「本 turn 工具真实产生/改写过的文件」（且只对「行内代码」token 生效）。你要做的「识别**任意/更宽泛**路径文本 + Ctrl 修饰 + 打开所在文件夹」是在此之上的**增强**，最省力的做法是**顺着 `chatFileMentions` 服务 + `workspaces.openPath` 现成链路扩展识别逻辑**，而不是另起炉灶。

---

## 8. client 插件能否拿到 host 侧 Remote / `ctx.remote` / `$mount`

- **Remote 入口**：`ctx.remote`（`remote` 服务），具体业务 namespace 用 `inject` 声明：如 feedbak 的 `inject: ["remote", "remote.messageFeedback"]` → `ctx.remote.messageFeedback`。远程方法走 typert/项目协议（`put`/`delete`/`list`/`openPath` 等），返回 `{ ok, value/error }` carry 结构。
- **打开文件/文件夹的直接服务**：`ctx.workspaces`（`IWorkspaces`），**client 插件可直接用**，无需自己找 remote：`ctx.workspaces.openPath(path)`、`ctx.workspaces.listDirectory(path, signal)`、`ctx.workspaces.pickDirectory()`（`dsh-client-ui-directory-picker-browse` 与 `dsh-client-ui-conversation` 都直接这么用）。`ctx.workspaces` 由 `dsh-client-runtime` 经 `ctx.reflect.provide("workspaces", this)` 挂载（`client.js` 9848 行）。
- **没有 `$mount` 这种 host 挂载语义**在 client 侧；client 插件 = `window.__ModuleLoader__.load({ id, factory })` + `apply(ctx)` + `inject` 服务数组。真正的 mount 是 shell `AppWebEntry.run()` → `appShell.renderApp()` → 槽位树渲染，插件只在槽位里占座。
- **web-search-deepseek 没有 client 半**（`lib/` 只有 `index.js` / `provider.js` / `types.js`，纯 host 侧，无 `client.js`）；所以「Remote 在 client 侧的示例」最权威的还是 `dsh-client-ui-message-feedback`（`remote.messageFeedback`）与 `dsh-client-ui-deliverables`（`connection.hostDescription` 可选服务 + `ctx.provide`）。

---

## 9. 推荐接入方案（对比）

### 方案 A（推荐）—— 官方服务缝 + 打开所在文件夹

1. 写一个 client 插件 `dsh-pathlink`（`apply(ctx)` + `inject: ["slots","workspaces","locale"]`）。
2. 在 `apply` 里 `ctx.provide("chatFileMentions", { forClosing(owner) { … } })`：
   - 用你自己的路径识别逻辑（regex 宽匹配，或复用/仿照 deliverables 的产物语义）生成 `MarkdownFileMentions`。
   - `resolve(value)` 命中时返回 `{ open: () => ctx.workspaces.openPath(resolveWorkspacePath(cwd, dirOf(path))), label, title }`。
   - **优点**：完全复用官方渲染管线的 `<button class=fileMention>` 点击 UI + 流式冻结/缓存语义 + 「已知文件」判断，零 DOM hack，天然多语言（label）、天然 aria。
   - **限制**：只覆盖「行内代码 token」、settled 才生效（见 §2-1）；若你想要「任意 prose 里的裸路径（非代码块）Ctrl+点击」，此缝不够。
3. 需要 `resolveWorkspacePath` 与 `cwd`：`cwd` 可从 `ctx.sessions`（`ctx.sessions.list`）或通过 `chatFileMentions.forClosing(owner)` 的 `owner` 上下文（`owner.openFile` 已封装 cwd 解析）拿；最 clean 是让 `owner.openFile` 承载（它内部已 `resolveWorkspacePath(cwd, path)`）。

### 方案 B（增量补充）—— 捕获阶段 click 委托 + Ctrl/⌘ 判断

针对「**任意路径文本**（含非代码块 prose）Ctrl+点击」这一 方案 A 覆盖不到的增量：

1. 插件里 `useEffect` 对一个稳定容器（`[data-conversation-scroll]` 或 `[data-chat-flow]`）挂**捕获阶段** `click` 监听（`addEventListener('click', h, true)`）。
2. 命中判断：`if (!(e.ctrlKey || e.metaKey)) return;` → 用 `data-chat-flow-kind` 过滤到 assistant/user 消息；对 `e.target` 邻近文本做路径正则匹配（或预先用 `TreeWalker` 扫描文本节点、建弱引用索引，比每次全量 MutationObserver 轻）。
3. 调 `ctx.workspaces.openPath(dirOf(path))`（先 `resolveWorkspacePath`）。
4. **风险**：流式尾部会替换文本节点（§3），需要按 `data-chat-flow-key` 去重/失效索引；也要 `e.preventDefault()` 避免与 markdown `<code>` 等冲突；不要动 class（hashed）只认 `data-*`。

### 方案 C（不推荐作主力）—— 全量 MutationObserver

可用但最重：要观察 `data-chat-flow`，处理流式 tail 替换、虚拟滚动不存在（消息是普通列表）所以还行，但官方缝已覆盖大半价值，MutationObserver 只该作为 B 的兜底，不作主力。

### 关于「Ctrl+点击链接在新标签页」

链接**默认已是新标签页**（`target=_blank`）。若需求是「无修饰 click=某行为 / Ctrl+click=另行为」，需要在 `<a>` 上拦截并 `preventDefault`，差异化处理。若只是「点击链接新标签页」，无需改动（已满足）。注意 `rel="noopener noreferrer"` 已带。

---

## 10. 关键文件路径清单

| 关注点 | 文件 |
|---|---|
| 消息/助手渲染 | `@deepseek-ai/dsh-client-ui-conversation/lib/client.js`（`AssistantNodeView`/`AssistantMarkdown`/`ChatView`/`MessageItem`/`MessageIconActions`）；`lib/types/client/chat/*.d.ts` |
| markdown 渲染器（自研 mdast→React） | `@deepseek-ai/dsh-client-ui-primitives/lib/index.js`（`renderNode`/`renderSafeLink`/`inlineCodeHttpUrl`）与 `lib/types/markdown/{render,parse,incremental,MarkdownText,MessageText}.d.ts` |
| 文件 mention 缝 | `dsh-client-ui-primitives/lib/types/markdown/render.d.ts`（`MarkdownFileMentions`） |
| 文件 mention 服务契约 | `dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts`（`ChatFileMentions`、`ChatNodeOwnerProps.openFile`、`AssistantActionOwnerProps`） |
| 现成客户端插件范例 | `@deepseek-ai/dsh-client-ui-message-feedback/lib/client.js`（槽位挂按钮+`ctx.remote`）、`@deepseek-ai/dsh-client-ui-deliverables/lib/client.js`（`chatFileMentions` 提供方、产文件 chips、`producedFileMentions`） |
| 槽位系统契约 | `dsh-client-ui-slots/lib/types/{index,store,renderer}.d.ts`；运行时 `dsh-client-runtime/lib/types/client/slots.d.ts` |
| 打开路径服务 | `dsh-client-runtime/lib/types/client/workspaces/{service,path}.d.ts`、`contract/workspaces.d.ts`；host 面 `dsh-host-apiproxy/lib/types/api/host*.d.ts` |
| 模块系统 / require 清单 | `dsh-client-modules/lib/types/client/{index,system,manifest}.d.ts`；seed 列表 `dsh-client-web/lib/index.js`（`getStaticModules`） |
| 目录选择器路径展示 | `dsh-client-ui-directory-picker-browse/lib/client.js`（面包屑/Miller 列、`ctx.workspaces.*`） |
| 修饰键惯例 | `dsh-client-ui-conversation/lib/client.js`（InputBar `ctrlKey || metaKey`） |

---

## 11. 需要注意的风险

1. **class 名是 hashed CSS module**，不可稳定匹配；只依赖 `data-*` 语义属性（`data-chat-flow-kind`/`-key`、`data-conversation-scroll`、`data-produced-files-row`）。
2. **`fileMentions` 只在 settled（非流式）渲染生效，且只对行内代码 token**；流式期间词汇不定、冻结缓存不许烘焙会过期 handler。裸 prose 路径识别需方案 B 兜底。
3. **`require` 是同步、无 fetch**：插件工厂内只安全 `require` seed 词（react 等）；其它 client 包要依赖 graph 注册时序（deliverables 能 `require("dsh-client-runtime/client")` 说明它在立即 tier）。严格遵循 `apply`+`inject` 出口，值导入在建时被禁。
4. **`openPath` 是「用宿主默认应用打开」**：目录=打开文件夹、文件=打开文件；没有独立的「reveal-and-select」client primitive，若要“在文件夹中定位选中”需自行组合（打开所在目录）。
5. `MarkerDown` 安全策略禁 `file:` 链接与 raw HTML，故**不能**指望给路径包一个 `<a href="file://…">`；点击必须走 `openPath` RPC 或 `windows.open` 之外自有逻辑。
6. 流式重渲染会让消息 DOM 尾部文本节点被替换；DOM 方案必须按键去重并处理失效，避免重复挂 listener 或陈旧事件闭包。
7. `conversation.chat.assistant-actions` 槽位 owner 只有 `messageId`（无正文），所以「动作按钮」和「正文路径识别」要分两个缝做（前者槽位、后者 chatFileMentions/委托）。
8. 稳定 cwd 解析依赖 `ctx.sessions`/`chatFileMentions.owner.openFile`；直接 `workspaces.openPath` 时要自己 `resolveWorkspacePath(cwd, path)`，不要在 client 端硬编码分隔符假设（有 `backslash` vs `slash` 平台差异）。
