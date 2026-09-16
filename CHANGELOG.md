# Changelog

All notable changes to this project are documented in this file.

Format based on Keep a Changelog.
Project uses Semantic Versioning.

## [1.4.4] - 2026-09-16

### Added

- 重新设计预览区「框选-高亮」方案：在 DOMPurify 钩子中放行 `data-source-line` / `data-source-line-end` 行锚点（需 `forceKeepAttr`），并改用「渲染文本与源码逐字符相等 → 偏移量恒等映射」精确定位（`locateSelectionInBlock`），支持跨多行、重复文本、加粗/斜体内部选区，整段选中已高亮块可一键取消
- 文件树新增「眼镜」过滤按钮：只看可打开的 Markdown/文本文件，及其后代仍含可打开文件的目录；自底向上剪枝（不保留空壳文件夹），过滤状态持久化，切换时复用扫描缓存不重新遍历
- 新增 `src/file-tree.js`（`isOpenableFile` / `pruneNonOpenable` 纯函数，可单测），统一三处散落的文件类型判定（文件树 / 打开按钮 / 拖拽，均含 `.txt`），消除口径不一致

### Changed

- 限制预览视图下的编辑行为：预览区不再做 WYSIWYG 回写源码，改为只读，仅保留「高亮」作为唯一可写操作，从源头避免脏 DOM 累加与格式重排；高亮失败提示改为两行居中（主提示 + `G码--原因`）
- 重新设计左侧功能区：大纲与文件双视图切换，文件视图支持文件夹浏览并可在选中文件夹时显示眼镜过滤按钮（单个文件打开时不显示）
- 顶部视图模式按钮顺序调整为「纯编辑 → 分屏 → 纯预览」，默认进入纯预览，且不再持久化记忆（每次打开固定纯预览）
- 高亮后预览区保持滚动位置，不再回顶

### Notes

- 高亮写回源码的方式：在选区对应 Markdown 源码处包裹 `<mark>…</mark>`，预览区通过行锚点 + 偏移映射反查源码区间；切换过滤不重新扫描目录
- 早期遗留的 `src/outline.js`（孤儿模块，未被引用）已删除

## [1.4.3] - 2026-08-21

### Security

- Sanitize preview HTML with DOMPurify; keep limited tags (`mark`, `center`, `font`, `span`, `sup`, `sub`)
- Mermaid `securityLevel: 'strict'` and sanitize rendered SVG before insert
- File tree names use `textContent` (no HTML interpolation)
- Strip event handlers / `javascript:` from html→md raw-tag round-trip
- Lock down translate-fetch SW proxy: same-extension sender, POST, https + host_permissions origins, header allowlist
- Drop `scripting` / `tabs` / `optional_host_permissions`; add extension_pages CSP
- Reject `javascript:` / `vbscript:` / `chrome:` image sources

## [1.4.2] - 2026-07-14

### Added

- Reading-time bilingual translation in the preview pane (does not modify Markdown source)
- Toolbar toggle + settings: pick a service preset, paste API Key only
- Default preset: MiniMax Token Plan · Anthropic (`sk-cp-` key, `/anthropic/v1/messages`)
- Dual protocol for MiniMax / StepFun Token Plans (Anthropic Messages + OpenAI-compatible)
- Built-in presets: OpenAI / DeepSeek / Gemini / Groq / Mistral, Kimi / Qwen / 智谱 / 豆包, MiniMax · StepFun, OpenRouter · 硅基流动 · AiHubMix · 302.AI · API2D · CloseAI · Together · Fireworks · OneAPI, DeepL Free/Pro, custom endpoints
- Preset base URLs and model IDs verified via Context7 against official docs (2026-07-13)
- Background service-worker proxy for translation fetch (avoids CORS on `x-api-key` / Anthropic headers)
- Per-segment translation cache and progress status
- Visible build stamp (`v1.4.2`) in the toolbar and page title

### Fixed

- Do not call `chrome.permissions.request` on the translate path (false "未授权" after async gaps)
- MiniMax Anthropic Token Plan calls go through the SW proxy with correct headers

### Notes

- Translation sends document text to the provider you configure; keep that in mind for private docs
- After upgrade, reload the extension at `chrome://extensions` and close old editor tabs

## [1.3.1] - 2026-07-13

### Changed

- Removed the jarring HTML style-preset toolbar (居粗 / 居红 / 字号等); keep the editor chrome calm
- Startup + toolbar **?** open a real short user manual; example file is a full 说明书

### Kept

- Multi-instance tabs, session restore, local images, preview HTML round-trip for people who type tags in Markdown

## [1.3.0] - 2026-07-13

### Added

- Multi-instance editors: each toolbar click / each local `.md` open gets its own tab (`?i=` + per-instance storage keys) — thanks [@zhangweildlh](https://github.com/zhangweildlh) (PR #4 / Issue #3)
- Style toolbar: center/bold/color, highlight, font face/size presets; superscript and subscript
- Session restore: reopen the extension restores last edited content and filename (Issue #2; FileSystemHandle cannot persist, so Save may ask for a path again)
- Richer first-run help tips for common Markdown / HTML snippets

### Fixed

- Preview WYSIWYG round-trip: normalize extra blank lines and preserve `<mark>/<center>/<font>/<span>/<sup>/<sub>` when syncing back to source (helps Issue #1 path/style corruption)
- Local image preview and original `src` preservation remain in place from 1.2.0 (Issue #1)

### Changed

- Extension and package version aligned to **1.3.0**

## [1.2.0] - 2026-07-13

### Added

- Local image preview for relative paths when a folder or `file://` context is available
- Paste image into the editor: writes to sibling `images/` when folder write access exists, otherwise embeds a data URL
- First-run onboarding overlay (drag file / open folder / open example)
- Feedback entry in the status bar linking to GitHub Issues
- Reproducible icon pipeline (`npm run icons`) and Markdown-recognizable toolbar icons
- Unit tests for image path resolution and preview link safety (`npm test`)
- Pack script: `npm run pack` builds and produces `chrome-md-editor-v*.zip` with a nested `dist/` folder

### Fixed

- Preview-pane links open reliably while the preview stays contenteditable for WYSIWYG
- Preserve original Markdown image sources when syncing WYSIWYG preview back to source (avoids writing blob URLs into the document)
- Addresses user report of local images not rendering and path corruption after preview edit (see GitHub Issue #1; please re-test on 1.2.0 before closing)

### Changed

- README quick start and installation guidance oriented around GitHub Releases
- Aligned `package.json` version with `manifest.json` at **1.2.0**

### Notes

- GitHub previously only published **v1.0.0** while `main` already contained the above work. This release closes that distribution gap.
- There was no separate public **v1.1.0** tag. DEVLOG mentions 1.1.0 during content-script work; that stream is included here under 1.2.0.

## [1.0.0] - 2026-02-28

### Added

- Initial Chrome extension (Manifest V3) Markdown editor
- CodeMirror 6 source editing, markdown-it preview, Mermaid diagrams
- WYSIWYG editing in the preview pane
- File System Access open/save and project folder sidebar
- `file://` content script intercept for local `.md` files
- Light/dark themes and split / editor / preview layouts
