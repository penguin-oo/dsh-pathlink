# Linux Do 发布草稿（请自行检查修改后再发布）

> 说明：本文件是按你的风格整理的草稿，发布前请自己过一遍、按社区规则调整。

## 建议信息

- 板块：资源荟萃
- 分类/tag：开源推广、人工智能、DeepSeek-Harness
- 标题：dsh-pathlink：在 DeepSeek Harness 对话里 Ctrl+点击路径与链接

## 正文草稿

给 DeepSeek Harness 做的一个小插件 **dsh-pathlink**，已经发布到
GitHub / npm / npmmirror，并提交了 awesome-deepseek-harness 等目录。

**解决什么问题**：Agent 回复里到处都是文件路径，以前只能手动复制再去
资源管理器里翻。现在消息里的路径和链接会被自动识别、加一条淡淡的虚线下
划线，**Ctrl+点击**（macOS 用 ⌘）：

- 路径 → 直接打开所在文件夹，并选中该文件（Windows explorer /select、
  macOS open -R、Linux xdg-open）
- 链接 → 新标签页打开
- 路径不存在 → 弹 toast 提示，不会静默失败
- 普通点击不触发，不影响选中/复制

**实现上**：纯 DOM 扫描器 + 宿主 pathlink Remote 服务，不占用官方
chatFileMentions 缝（与内置 deliverables 共存），零配置开箱即用，仅 web
配置档。

**安装**：

```
dsh plugin --profile web add dsh-pathlink
```

**链接**：
- GitHub：https://github.com/penguin-oo/dsh-pathlink
- npm：https://www.npmjs.com/package/dsh-pathlink
- 截图见仓库 README（中英双语）

欢迎试用反馈～

---

## 图片

两张实测截图在仓库里：
- https://github.com/penguin-oo/dsh-pathlink/blob/main/docs/screenshot-recognized.png
- https://github.com/penguin-oo/dsh-pathlink/blob/main/docs/screenshot-tooltip.png

发帖时可以直接引用 raw 链接：
- https://raw.githubusercontent.com/penguin-oo/dsh-pathlink/main/docs/screenshot-recognized.png
- https://raw.githubusercontent.com/penguin-oo/dsh-pathlink/main/docs/screenshot-tooltip.png
