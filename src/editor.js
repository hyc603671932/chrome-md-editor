// ==========================================
// Markdown Editor - 核心逻辑
// ==========================================

import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightActiveLine, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { oneDark } from '@codemirror/theme-one-dark';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { lintKeymap } from '@codemirror/lint';
import MarkdownIt from 'markdown-it';
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';
import {
  buildImagesRelativePath,
  buildPastedImageMarkdown,
  createPastedImageFilename,
  dirnameFromRelativePath,
  mimeTypeToExtension,
  resolvePreviewImageSource,
  splitRelativePath,
} from './image-support.js';
import { resolvePreviewLinkClickTarget } from './link-support.js';
import { showOnboarding, hideOnboarding } from './onboarding.js';
import { initFeedbackButton } from './feedback.js';
import { rememberLastFile, loadLastFile } from './session-restore.js';
import { newInstanceId, pendingFileStorageKey } from './instance-id.js';
import { isOpenableFile, pruneNonOpenable, OPENABLE_EXTENSIONS } from './file-tree.js';
import {
  selectionInsideRoot,
  locateSelectionInBlock,
} from './preview-format.js';
import { parseOutline, outlineSignature, buildOutlineList, isHeadingLine } from './outline.js';
import {
  applyPreviewTranslation,
  clearPreviewTranslations,
  ensureTranslateHostPermission,
  loadTranslateSettings,
  normalizeTranslateSettings,
  saveTranslateSettings,
} from './translate.js';

/** Visible build stamp so we can tell if Chrome reloaded the new package. */
export const APP_VERSION = '1.4.3';
import {
  getPresetDefaultModel,
  getTranslatePreset,
  groupTranslatePresets,
} from './translate-presets.js';

// ==========================================
// Mermaid 初始化
// ==========================================
mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'strict',
  fontFamily: 'sans-serif',
});

const PREVIEW_PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'strong', 'em', 'b', 'i', 'u', 's', 'del', 'code', 'pre',
    'blockquote', 'ul', 'ol', 'li',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'hr', 'a', 'img',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'mark', 'center', 'font', 'span', 'sup', 'sub',
    'div',
    'input',
  ],
  ALLOWED_ATTR: [
    'href', 'src', 'alt', 'title', 'class',
    'color', 'face', 'size',
    'colspan', 'rowspan', 'align',
    'type', 'disabled', 'checked',
  ],
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'link', 'meta'],
  FORBID_ATTR: ['style'],
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  ALLOWED_URI_REGEXP:
    /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|data|blob|chrome-extension|file):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
};

DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
  // 仅放行 markdown 源码行号标记，供预览区高亮定位使用（其余 data-* 仍按 ALLOW_DATA_ATTR:false 禁止）
  // data-source-line：块起始行（0-based）；data-source-line-end：块结束行（0-based，exclusive）。
  // 一个块（如段落）可能跨多行源码，选中文字未必在起始行，故需整块范围才能定位。
  //
  // ⚠️ 必须用 forceKeepAttr，不能只用 keepAttr：
  // DOMPurify 的 _sanitizeAttributes 在钩子之后仍会调 _isValidAttribute 二次判定，
  // 而 data-* 既不在 ALLOWED_ATTR 里、ALLOW_DATA_ATTR 又是 false，会被判非法并删除。
  // 只有 forceKeepAttr 能在该判定前 continue 跳过后续所有检查（真实 Chrome 3.4.14 实测：
  // keepAttr → 仍被剥；forceKeepAttr → 保留）。
  if (data.attrName === 'data-source-line' || data.attrName === 'data-source-line-end') {
    data.keepAttr = true;
    data.forceKeepAttr = true;
    return;
  }
  if (data.attrName !== 'href') return;
  const v = String(data.attrValue || '').trim().toLowerCase();
  if (
    v.startsWith('javascript:') ||
    v.startsWith('vbscript:') ||
    v.startsWith('data:') ||
    v.startsWith('blob:')
  ) {
    data.keepAttr = false;
  }
});

function sanitizePreviewHtml(html) {
  return DOMPurify.sanitize(html, PREVIEW_PURIFY_CONFIG);
}

function sanitizeMermaidSvg(svg) {
  return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true } });
}

// ==========================================
// Markdown-it 初始化
// ==========================================
const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: true,
});

// 给块级 token 打上源码行号，供预览区「选中文字 → 定位源码」高亮使用。
// token.map[0] 为 0-based 行号；该属性经 DOMPurify 钩子（见 PREVIEW_PURIFY_CONFIG 附近）放行。
{
  const defaultRenderToken = md.renderer.renderToken.bind(md.renderer);
  md.renderer.renderToken = function (tokens, idx, options) {
    const token = tokens[idx];
    if (token.map) {
      token.attrSet('data-source-line', String(token.map[0]));
      token.attrSet('data-source-line-end', String(token.map[1]));
    }
    return defaultRenderToken(tokens, idx, options);
  };
}

// 任务列表支持
md.use(function taskListPlugin(md) {
  md.core.ruler.after('inline', 'task-list', function(state) {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type === 'inline') {
        const content = tokens[i].content;
        if (/^\[[ xX]\]\s/.test(content)) {
          const checked = /^\[[xX]\]/.test(content);
          tokens[i].content = content.replace(/^\[[ xX]\]\s/, '');
          tokens[i].children[0].content = tokens[i].children[0].content.replace(/^\[[ xX]\]\s/, '');

          // 在内容前插入 checkbox
          const checkboxToken = new state.Token('html_inline', '', 0);
          checkboxToken.content = `<input type="checkbox" disabled ${checked ? 'checked' : ''}>`;
          tokens[i].children.unshift(checkboxToken);

          // 给父级 li 添加 class
          for (let j = i - 1; j >= 0; j--) {
            if (tokens[j].type === 'list_item_open') {
              tokens[j].attrSet('class', 'task-list-item');
              break;
            }
          }
        }
      }
    }
  });
});

// ==========================================
// 状态管理
// ==========================================
let editor = null;
let currentFileHandle = null;
let isModified = false;
let currentTheme = localStorage.getItem('md-editor-theme') || 'dark';
// 视图模式不再记忆：每次打开固定从「纯预览」开始（用户切换只在当前会话内有效）。
let currentViewMode = 'preview';
localStorage.removeItem('md-editor-view-mode'); // 清掉旧版本留下的历史值
let currentSidebarPanel = 'outline'; // 默认显示大纲视图
let outlineDirty = false;            // 文档改动后置位，鼠标进入侧栏或切到大纲页时才刷新
let inHeadingLine = false;          // 光标当前是否落在标题行（用于「离开标题行即刷新」）
let lastOutlineSignature = '';       // 上次大纲指纹，未变则不重绘 DOM（防闪烁）
let mermaidCounter = 0; // mermaid 图表 ID 计数器
let currentFileUrl = null; // file:// 打开的 Markdown 原始地址（拖入/关联打开时才有，按钮打开拿不到）
let currentBaseName = ''; // 当前文档原始文件名（用于「保存为」默认建议名，三种打开方式统一在此记录）
let currentDirectoryPath = null; // 相对已打开文件夹根目录的当前 Markdown 目录
let previewObjectUrls = []; // 用于释放通过 File System Access API 生成的 blob URL
let translateEnabled = false; // 预览区阅读翻译（双语对照，不改源码）
let translateBusy = false;
let translateRunId = 0;
let translateSettingsCache = null;

// Theme compartment for dynamic switching
const themeCompartment = new Compartment();

// Custom light theme
const lightTheme = EditorView.theme({
  '&': {
    backgroundColor: '#ffffff',
    color: '#1f2328',
  },
  '.cm-content': {
    caretColor: '#0969da',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: '#0969da',
  },
  '.cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'rgba(9, 105, 218, 0.2)',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(9, 105, 218, 0.04)',
  },
  '.cm-gutters': {
    backgroundColor: '#f6f8fa',
    color: '#8c959f',
    borderRight: '1px solid #e8eaed',
  },
  '.cm-activeLineGutter': {
    backgroundColor: '#f0f2f5',
    color: '#656d76',
  },
}, { dark: false });

// ==========================================
// 编辑器初始化
// ==========================================
function createEditor() {
  const editorContainer = document.getElementById('editorContainer');

  const startDoc = `# 欢迎使用 Markdown Editor

> 一个简洁、高效的 Markdown 编辑器 Chrome 扩展

## 快速开始

- 按 \`Ctrl+O\` 打开本地 .md 文件
- 按 \`Ctrl+S\` 保存当前文件
- 使用工具栏快捷按钮进行格式化
- 拖拽中间分隔条调整编辑/预览比例
- 预览区为只读展示；选中文字后可用工具栏「高亮」按钮加标记

## 支持的 Markdown 语法

### 文本格式

**粗体文本** _斜体文本_ ~~删除线~~ \`行内代码\`

### 列表

- 无序列表项 1
- 无序列表项 2
  - 嵌套列表项

1. 有序列表项 1
2. 有序列表项 2

### 任务列表

- [x] 已完成任务
- [ ] 未完成任务

### 代码块

\`\`\`javascript
function hello() {
  console.log('Hello, Markdown!');
}
\`\`\`

### 表格

| 功能 | 快捷键 | 说明 |
|------|--------|------|
| 打开 | Ctrl+O | 打开文件 |
| 保存 | Ctrl+S | 保存文件 |
| 加粗 | Ctrl+B | 加粗文本 |
| 斜体 | Ctrl+I | 斜体文本 |

### 引用

> 这是一段引用文本。
> 支持多行引用。

### Mermaid 图表

\`\`\`mermaid
graph LR
    A[编辑 Markdown] --> B[实时预览]
    B --> C{满意吗?}
    C -->|是| D[保存文件]
    C -->|否| A
\`\`\`

### 链接和图片

[访问 GitHub](https://github.com)

---

*开始编辑你的 Markdown 文档吧！*
`;

  const extensions = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      ...lintKeymap,
      indentWithTab,
      // 自定义快捷键
      { key: 'Mod-s', run: handleSave, preventDefault: true },
      { key: 'Mod-o', run: handleOpen, preventDefault: true },
      { key: 'Mod-b', run: () => wrapSelection('**', '**'), preventDefault: true },
      { key: 'Mod-i', run: () => wrapSelection('*', '*'), preventDefault: true },
    ]),
    markdown({
      base: markdownLanguage,
      codeLanguages: languages,
    }),
    EditorView.lineWrapping,
    themeCompartment.of(currentTheme === 'dark' ? oneDark : lightTheme),
    // 内容变化时更新预览
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        updatePreview();
        updateStatus();
        markModified();
        outlineDirty = true; // 文档被改动，等用户看大纲时再刷新（鼠标进入侧栏 / 切到大纲页）
      }
      // 标题行进出检测：光标跨越「标题 ↔ 普通」边界且文档有改动时，刷新一次大纲。
      // 这样在标题里打字不会刷新，离开标题行的瞬间才刷（配合 signature 闸门不闪烁）。
      if (update.docChanged || update.selectionSet) {
        const head = update.state.selection.main.head;
        const lineNo = update.state.doc.lineAt(head).number; // 1-based
        const nowHeading = isHeadingLine(update.state.doc.toString(), lineNo);
        const wasHeading = inHeadingLine;
        inHeadingLine = nowHeading;
        if (outlineDirty && wasHeading !== nowHeading) {
          refreshOutlineIfDirty();
        }
      }
      if (update.selectionSet) {
        updateCursorStatus();
      }
    }),
  ];

  editor = new EditorView({
    state: EditorState.create({
      doc: startDoc,
      extensions,
    }),
    parent: editorContainer,
  });

  // 初始化光标所在行是否为标题行，避免首次按键误触发刷新
  inHeadingLine = isHeadingLine(
    editor.state.doc.toString(),
    editor.state.doc.lineAt(editor.state.selection.main.head).number,
  );

  // 编辑器失焦时也刷新一次（覆盖「改完标题直接点编辑器外」的漏刷场景）。
  // 用 focusout 而非 blur：blur 不冒泡，editor.dom 收不到内部 contentDOM 的失焦。
  editor.dom.addEventListener('focusout', () => {
    if (outlineDirty) refreshOutlineIfDirty();
  });

  // 初始化预览
  updatePreview();
  updateStatus();
}

// ==========================================
// 预览更新
// ==========================================
let previewUpdateTimer = null;
// 整篇替换（打开/拖拽/会话恢复）时置 true：下次预览刷新不再保持滚动，回到顶部
let previewScrollResetRequested = false;

/**
 * 预览重渲染前的滚动位置快照。
 * 优先记「视口顶部所在块的 data-source-line + 相对视口偏移」——这样即使上方内容
 * 高度发生变化（在别处编辑、图片撑开）也能保持视觉位置；找不到锚点时退回纯数值。
 * 二分查找定位首個可见块，避免大文档里逐个 getBoundingClientRect 触发大量重排。
 */
function firstVisiblePreviewBlock(previewContainer) {
  const blocks = previewContainer.querySelectorAll('[data-source-line]');
  if (!blocks.length) return null;
  const containerTop = previewContainer.getBoundingClientRect().top;
  let lo = 0;
  let hi = blocks.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].getBoundingClientRect().bottom > containerTop + 1) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return found === -1 ? null : blocks[found];
}

function capturePreviewScroll(previewContainer) {
  if (previewScrollResetRequested) {
    previewScrollResetRequested = false;
    return null;
  }
  const top = previewContainer.scrollTop;
  if (top <= 0) return null;
  const anchorEl = firstVisiblePreviewBlock(previewContainer);
  const anchor = anchorEl
    ? {
        line: anchorEl.getAttribute('data-source-line'),
        delta:
          anchorEl.getBoundingClientRect().top -
          previewContainer.getBoundingClientRect().top,
      }
    : null;
  return { top, anchor };
}

function restorePreviewScroll(previewContainer, saved) {
  if (!saved || !previewContainer) return;
  if (saved.anchor && /^\d+$/.test(saved.anchor.line)) {
    const el = previewContainer.querySelector(
      `[data-source-line="${saved.anchor.line}"]`
    );
    if (el) {
      const delta =
        el.getBoundingClientRect().top -
        previewContainer.getBoundingClientRect().top;
      previewContainer.scrollTop += delta - saved.anchor.delta;
      return;
    }
  }
  previewContainer.scrollTop = saved.top;
}

function updatePreview() {
  // 防抖：快速输入时减少渲染次数；开启翻译时略加长，降低 API 调用频率
  clearTimeout(previewUpdateTimer);
  const delay = translateEnabled ? 450 : 80;
  previewUpdateTimer = setTimeout(() => {
    doUpdatePreview();
  }, delay);
}

async function doUpdatePreview() {
  const previewContainer = document.getElementById('previewContainer');
  const content = editor.state.doc.toString();
  let html = sanitizePreviewHtml(md.render(content));

  // 渲染 Mermaid 图表
  // markdown-it 会把 ```mermaid 渲染成 <pre><code class="language-mermaid">...</code></pre>
  cleanupPreviewObjectUrls();
  const savedScroll = capturePreviewScroll(previewContainer);
  previewContainer.innerHTML = html;
  // 立即恢复一次：消除「innerHTML 清零 scrollTop 导致的回顶闪烁」
  restorePreviewScroll(previewContainer, savedScroll);

  // 诊断：确认 data-source-line 是否真的进了预览 DOM（高亮定位的前提）
  highlightLog('PREVIEW_UPDATED', {
    anchors: previewContainer.querySelectorAll('[data-source-line]').length,
    firstBlock: previewContainer.querySelector('[data-source-line]')
      ? previewContainer.querySelector('[data-source-line]').outerHTML.slice(0, 200)
      : null,
  });

  // 查找所有 mermaid 代码块并渲染
  const mermaidBlocks = previewContainer.querySelectorAll('code.language-mermaid');
  for (const block of mermaidBlocks) {
    const source = block.textContent;
    const pre = block.parentElement;
    try {
      mermaidCounter++;
      const { svg } = await mermaid.render(`mermaid-${mermaidCounter}`, source);
      const div = document.createElement('div');
      div.className = 'mermaid-diagram';
      // 保留 mermaid 源码：预览区 WYSIWYG 回写时靠它还原围栏块，
      // 否则 <pre> 被替换成图表后源码就丢了（html-to-markdown.js 会读这个属性）
      div.dataset.mermaidSource = source;
      div.innerHTML = sanitizeMermaidSvg(svg);
      pre.replaceWith(div);
    } catch (err) {
      // 渲染失败时显示错误
      const div = document.createElement('div');
      div.className = 'mermaid-error';
      // 渲染失败时源码更不能丢，同样挂上
      div.dataset.mermaidSource = source;
      div.textContent = 'Mermaid 渲染错误: ' + err.message;
      pre.replaceWith(div);
    }
  }

  await resolvePreviewImages(previewContainer);

  if (translateEnabled) {
    await runPreviewTranslation(previewContainer);
  } else {
    setTranslateUiState({ active: false });
  }

  // 终态纠正：mermaid / 图片 / 翻译 在上方插入会改变文档高度，
  // 二次恢复可抵消这些异步内容带来的漂移，保持视觉位置不跳。
  restorePreviewScroll(previewContainer, savedScroll);
}

async function getTranslateSettings() {
  if (translateSettingsCache) return translateSettingsCache;
  translateSettingsCache = await loadTranslateSettings();
  return translateSettingsCache;
}

function setTranslateUiState({ active, busy, error, message } = {}) {
  const btn = document.getElementById('btnTranslate');
  const title = document.getElementById('previewPanelTitle');
  const status = document.getElementById('translateStatus');
  const previewContainer = document.getElementById('previewContainer');

  if (btn) {
    btn.classList.toggle('active-translate', !!active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.title = active
      ? '关闭阅读翻译'
      : '阅读翻译：预览双语对照（右键打开设置）';
  }

  if (title) {
    title.textContent = active ? '预览 · 双语' : '预览';
  }

  if (previewContainer) {
    previewContainer.classList.toggle('translate-active', !!active);
  }

  if (!status) return;

  if (busy) {
    status.hidden = false;
    status.className = 'panel-header-meta is-busy';
    status.textContent = message || '翻译中…';
    return;
  }

  if (error) {
    status.hidden = false;
    status.className = 'panel-header-meta is-error';
    status.textContent = message || '翻译失败';
    return;
  }

  if (active && message) {
    status.hidden = false;
    status.className = 'panel-header-meta';
    status.textContent = message;
    return;
  }

  status.hidden = true;
  status.textContent = '';
  status.className = 'panel-header-meta';
}

async function runPreviewTranslation(previewContainer) {
  const runId = ++translateRunId;
  const settings = await getTranslateSettings();

  if (!settings.apiKey) {
    setTranslateUiState({ active: true, error: true, message: '未配置 API Key' });
    showToast('请先配置翻译 API Key', 'error');
    openTranslateSettingsModal();
    return;
  }

  translateBusy = true;
  setTranslateUiState({ active: true, busy: true, message: '翻译中…' });

  try {
    // Validate origin only. Do NOT chrome.permissions.request here — after
    // awaits it loses the user gesture and throws misleading errors.
    await ensureTranslateHostPermission(settings);

    const result = await applyPreviewTranslation(previewContainer, settings, {
      onProgress: ({ done, total }) => {
        if (runId !== translateRunId) return;
        setTranslateUiState({
          active: true,
          busy: true,
          message: `翻译中 ${done}/${total}`,
        });
      },
    });

    if (runId !== translateRunId) return;

    setTranslateUiState({
      active: true,
      message: result.total ? `已译 ${result.applied}/${result.total}` : '无可译段落',
    });
  } catch (err) {
    if (runId !== translateRunId) return;
    console.warn('translate failed', err);
    setTranslateUiState({
      active: true,
      error: true,
      message: '翻译失败',
    });
    const msg = String(err?.message || '翻译失败');
    // Friendlier network / permission failures
    if (/Failed to fetch|NetworkError|ERR_FAILED|blocked/i.test(msg)) {
      showToast(
        '无法连接翻译 API。请确认已重新加载最新扩展，且预设域名正确；自定义域名可在设置保存时授权。',
        'error'
      );
    } else {
      showToast(msg, 'error');
    }
  } finally {
    if (runId === translateRunId) {
      translateBusy = false;
    }
  }
}

async function toggleTranslateMode() {
  if (translateBusy) {
    showToast('翻译进行中，请稍候…');
    return;
  }

  if (translateEnabled) {
    translateEnabled = false;
    translateRunId += 1;
    const previewContainer = document.getElementById('previewContainer');
    clearPreviewTranslations(previewContainer);
    setTranslateUiState({ active: false });
    // Re-render clean preview
    doUpdatePreview();
    showToast('已关闭阅读翻译');
    return;
  }

  const settings = await getTranslateSettings();
  if (!settings.apiKey) {
    openTranslateSettingsModal();
    showToast('请先配置翻译 API Key');
    return;
  }

  translateEnabled = true;
  setTranslateUiState({ active: true, busy: true, message: '翻译中…' });
  await doUpdatePreview();
}

function openTranslateSettingsModal() {
  const modal = document.getElementById('translateSettingsModal');
  if (!modal) return;

  ensureTranslatePresetOptions();
  getTranslateSettings().then((settings) => {
    fillTranslateSettingsForm(settings);
    modal.hidden = false;
    document.getElementById('translateApiKey')?.focus();
  });
}

function closeTranslateSettingsModal() {
  const modal = document.getElementById('translateSettingsModal');
  if (modal) modal.hidden = true;
}

function ensureTranslatePresetOptions() {
  const select = document.getElementById('translatePreset');
  if (!select || select.dataset.ready === '1') return;

  select.innerHTML = '';
  for (const group of groupTranslatePresets()) {
    const og = document.createElement('optgroup');
    og.label = group.groupLabel;
    for (const p of group.items) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label;
      og.appendChild(opt);
    }
    select.appendChild(og);
  }
  select.dataset.ready = '1';
}

function fillTranslateSettingsForm(settings) {
  const s = normalizeTranslateSettings(settings);
  ensureTranslatePresetOptions();

  const presetEl = document.getElementById('translatePreset');
  const apiKey = document.getElementById('translateApiKey');
  const baseUrl = document.getElementById('translateBaseUrl');
  const modelOverride = document.getElementById('translateModel');
  const targetLang = document.getElementById('translateTargetLang');

  if (presetEl) presetEl.value = s.presetId;
  if (apiKey) apiKey.value = s.apiKey;
  if (baseUrl) baseUrl.value = s.baseUrl;
  if (modelOverride) modelOverride.value = '';
  if (targetLang) targetLang.value = s.targetLang;

  applyPresetToForm(s.presetId, { model: s.model, baseUrl: s.baseUrl, keepBaseUrl: s.useCustomEndpoint });
}

function applyPresetToForm(presetId, { model, baseUrl, keepBaseUrl } = {}) {
  const preset = getTranslatePreset(presetId);
  const note = document.getElementById('translatePresetNote');
  const apiKey = document.getElementById('translateApiKey');
  const modelFields = document.getElementById('translateModelFields');
  const modelSelect = document.getElementById('translateModelSelect');
  const modelCustomWrap = document.getElementById('translateModelCustomWrap');
  const modelCustom = document.getElementById('translateModelCustom');
  const baseUrlEl = document.getElementById('translateBaseUrl');
  const advanced = document.getElementById('translateAdvanced');

  if (note) {
    const bits = [];
    if (preset.note) bits.push(preset.note);
    if (preset.docsUrl) bits.push(`申请 Key：${preset.docsUrl}`);
    note.textContent = bits.join(' · ');
  }

  if (apiKey && preset.keyHint) {
    apiKey.placeholder = `例如 ${preset.keyHint}`;
  }

  const isDeepl = preset.kind === 'deepl';
  if (modelFields) modelFields.hidden = isDeepl;

  if (!isDeepl && modelSelect) {
    modelSelect.innerHTML = '';
    const models = preset.models?.length
      ? preset.models
      : [{ id: getPresetDefaultModel(preset), label: getPresetDefaultModel(preset), default: true }];

    let matched = false;
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label || m.id;
      modelSelect.appendChild(opt);
      if (model && m.id === model) matched = true;
    }

    // Freeform model not in list
    const customOpt = document.createElement('option');
    customOpt.value = '__custom__';
    customOpt.textContent = '其他（手动输入模型名）';
    modelSelect.appendChild(customOpt);

    if (model && matched) {
      modelSelect.value = model;
      if (modelCustomWrap) modelCustomWrap.hidden = true;
    } else if (model && !matched) {
      modelSelect.value = '__custom__';
      if (modelCustomWrap) modelCustomWrap.hidden = false;
      if (modelCustom) modelCustom.value = model;
    } else {
      modelSelect.value = getPresetDefaultModel(preset) || models[0]?.id || '';
      if (modelCustomWrap) modelCustomWrap.hidden = true;
    }
  }

  if (baseUrlEl) {
    if (keepBaseUrl && baseUrl) {
      baseUrlEl.value = baseUrl;
    } else {
      baseUrlEl.value = preset.baseUrl || '';
    }
  }

  // Open advanced by default for custom / oneapi
  if (advanced) {
    advanced.open = preset.id === 'custom' || preset.id === 'oneapi' || preset.id === 'doubao';
  }
}

function readModelFromForm() {
  const override = document.getElementById('translateModel')?.value?.trim();
  if (override) return override;

  const modelSelect = document.getElementById('translateModelSelect');
  if (!modelSelect || modelSelect.closest('#translateModelFields')?.hidden) {
    return '';
  }
  if (modelSelect.value === '__custom__') {
    return document.getElementById('translateModelCustom')?.value?.trim() || '';
  }
  return modelSelect.value || '';
}

async function saveTranslateSettingsFromForm() {
  const presetId = document.getElementById('translatePreset')?.value || 'deepseek';
  const preset = getTranslatePreset(presetId);
  const baseUrlInput = document.getElementById('translateBaseUrl')?.value?.trim() || '';
  const presetBase = (preset.baseUrl || '').replace(/\/+$/, '');
  const useCustomEndpoint =
    presetId === 'custom' ||
    presetId === 'oneapi' ||
    (baseUrlInput && baseUrlInput.replace(/\/+$/, '') !== presetBase);

  const next = normalizeTranslateSettings({
    presetId,
    apiKey: document.getElementById('translateApiKey')?.value || '',
    baseUrl: baseUrlInput || presetBase,
    model: readModelFromForm(),
    targetLang: document.getElementById('translateTargetLang')?.value || 'zh-CN',
    useCustomEndpoint,
    provider: preset.kind === 'deepl' ? 'deepl' : 'openai',
    deeplEndpoint: preset.deeplEndpoint || 'free',
  });

  if (!next.apiKey) {
    showToast('API Key 不能为空', 'error');
    return;
  }

  translateSettingsCache = await saveTranslateSettings(next);
  closeTranslateSettingsModal();
  showToast(`已保存 · ${preset.label}`, 'success');

  if (translateEnabled) {
    await doUpdatePreview();
  }
}

function initTranslateSettingsModal() {
  const modal = document.getElementById('translateSettingsModal');
  if (!modal) return;

  ensureTranslatePresetOptions();

  document.getElementById('translatePreset')?.addEventListener('change', (e) => {
    applyPresetToForm(e.target.value, {});
  });

  document.getElementById('translateModelSelect')?.addEventListener('change', (e) => {
    const wrap = document.getElementById('translateModelCustomWrap');
    if (wrap) wrap.hidden = e.target.value !== '__custom__';
    if (e.target.value === '__custom__') {
      document.getElementById('translateModelCustom')?.focus();
    }
  });

  document.getElementById('translateSettingsCancel')?.addEventListener('click', closeTranslateSettingsModal);
  document.getElementById('translateSettingsSave')?.addEventListener('click', () => {
    saveTranslateSettingsFromForm();
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeTranslateSettingsModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) {
      closeTranslateSettingsModal();
    }
  });
}

function cleanupPreviewObjectUrls() {
  for (const url of previewObjectUrls) {
    URL.revokeObjectURL(url);
  }
  previewObjectUrls = [];
}

function hasDirectImageUrl(src) {
  return /^(https?:|data:|blob:|chrome-extension:|file:\/\/)/i.test(src);
}

function looksLikeLocalImageSource(src) {
  const normalized = String(src || '').trim();
  if (!normalized) return false;
  if (hasDirectImageUrl(normalized)) return true;
  if (/^[a-zA-Z]:[\\/]/.test(normalized)) return true;
  if (normalized.startsWith('/')) return true;
  return !/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(normalized);
}

async function resolvePreviewImages(previewContainer) {
  const images = previewContainer.querySelectorAll('img');

  await Promise.all(
    Array.from(images, async (img) => {
      const originalSrc = img.getAttribute('src') || '';
      const resolvedSrc = resolvePreviewImageSource(originalSrc, {
        currentFileUrl,
        currentDirectoryPath,
      });

      if (!resolvedSrc) {
        if (looksLikeLocalImageSource(originalSrc)) {
          img.title = '无法解析本地图片路径。请使用“打开文件夹”或拖拽 file:// 文件打开 Markdown。';
        }
        return;
      }

      try {
        const finalSrc = await materializePreviewImageSource(resolvedSrc);
        img.setAttribute('data-md-original-src', originalSrc);
        img.setAttribute('src', finalSrc);
      } catch (err) {
        console.warn('本地图片加载失败:', originalSrc, err);
        img.title = '本地图片加载失败: ' + err.message;
      }
    })
  );
}

async function materializePreviewImageSource(resolvedSrc) {
  if (hasDirectImageUrl(resolvedSrc)) {
    return resolvedSrc;
  }

  if (!directoryHandle) {
    return resolvedSrc;
  }

  const file = await getFileFromDirectoryPath(resolvedSrc);
  const objectUrl = URL.createObjectURL(file);
  previewObjectUrls.push(objectUrl);
  return objectUrl;
}

async function getFileFromDirectoryPath(relativePath) {
  const segments = splitRelativePath(relativePath);
  if (segments.length === 0) {
    throw new Error('图片路径为空');
  }

  let handle = directoryHandle;
  for (const segment of segments.slice(0, -1)) {
    handle = await handle.getDirectoryHandle(segment);
  }

  const fileHandle = await handle.getFileHandle(segments[segments.length - 1]);
  return fileHandle.getFile();
}

function setCurrentDocumentContext({ fileUrl = null, directoryPath = null } = {}) {
  currentFileUrl = fileUrl;
  currentDirectoryPath = directoryPath;
}

function clearCurrentDocumentContext() {
  setCurrentDocumentContext({ fileUrl: null, directoryPath: null });
}

// ==========================================
// 预览区选区（只读预览 + 高亮）
// ==========================================
// 预览区选区缓存：点工具栏/右键菜单时预览选区会丢，需先保住 Range
let savedPreviewRange = null;

function rememberPreviewSelection() {
  const previewContainer = document.getElementById('previewContainer');
  const sel = window.getSelection();
  if (!selectionInsideRoot(sel, previewContainer)) {
    return null;
  }
  try {
    savedPreviewRange = sel.getRangeAt(0).cloneRange();
    return savedPreviewRange;
  } catch {
    savedPreviewRange = null;
    return null;
  }
}

/**
 * 高亮：仅作用于左侧编辑区选中的文字（直接在源码侧包 <mark>，不经过预览往返）。
 * 预览区按「只读展示」原则，不允许从这里高亮，避免整篇 HTML→Markdown 往返破坏源码
 * （mermaid 丢失、表格链接 URL 丢失、嵌套列表缩进丢失等）。
 * 工具栏 / 右键菜单共用。
 */
// 预览区选区 → 源码行号定位所需的选择器与工具
// 受保护容器：代码块 / mermaid / svg —— 选中其内部文字不做高亮，统一提示去编辑模式
const PREVIEW_PROTECTED_SELECTOR = 'pre, code, .mermaid-diagram, .mermaid-error, svg';
// 行内格式容器：加粗 / 斜体 / 删除线 / 链接 等。
// 选区「完全落在同一个这样的容器内部」时允许高亮 —— 这类容器的源码标记（`**`、`*`、`[ ]( )`）
// 只在两端，内部文字在源码中连续存在，配合 locateSelectionInBlock 的 T2 最近偏移定位是可靠的。
// 注意：不含 mark —— 选区落在已有高亮里时要放行，否则「取消高亮」走不到 unwrap 分支。
const PREVIEW_INLINE_ALLOWED_SELECTOR = 'strong, em, del, ins, sub, sup, a';
// 必须拒绝的行内元素：图片 / 换行。它们是空元素，渲染文本与源码无法逐字符对齐。
// 用「选区内容里是否包含」来判定，而不是祖先链（空元素不可能成为文本节点的祖先）。
// 行内代码 <code> 不在此列 —— 它已经被 G1 的 PREVIEW_PROTECTED_SELECTOR 拦下
// （代码内加 <mark> 会被渲染成字面文本，而不是高亮）。
const PREVIEW_INLINE_BLOCKING_SELECTOR = 'img, br';
// 已有高亮单独判定：只允许「整段选中同一个 mark」时才取消，避免产生嵌套 mark 垃圾
const PREVIEW_MARK_SELECTOR = 'mark';

function previewElementOf(node) {
  return node && node.nodeType === 3 ? node.parentElement : node;
}
function previewInsideProtected(node) {
  const el = previewElementOf(node);
  return !!(el && el.closest(PREVIEW_PROTECTED_SELECTOR));
}
/** 端点最内层的「允许高亮」的行内格式容器；不在任何此类容器内则返回 null */
function previewInlineContainer(node) {
  const el = previewElementOf(node);
  return el && el.closest ? el.closest(PREVIEW_INLINE_ALLOWED_SELECTOR) : null;
}
/** 选区内容里是否含指定选择器的元素（img / br 这类空元素只能这样判） */
function previewRangeContains(range, selector) {
  try {
    const frag = range.cloneContents();
    return !!(frag && frag.querySelector && frag.querySelector(selector));
  } catch {
    return false;
  }
}
function previewMarkAncestor(node) {
  const el = previewElementOf(node);
  return el ? el.closest(PREVIEW_MARK_SELECTOR) : null;
}
/** 选区内容里是否含 <mark>（用于拦截「跨进/跨出已有高亮」的选区，避免嵌套 mark） */
function previewRangeTouchesMark(range) {
  const frag = range.cloneContents();
  return !!(frag && frag.querySelector && frag.querySelector(PREVIEW_MARK_SELECTOR));
}
/**
 * 返回选区端点所在「块」的源码行范围 [start, end)。
 * 一个块（段落 / 列表项 / 引用等）可能跨多行源码，但渲染后只有一个带
 * data-source-line 的元素，其 text 未必落在起始行，因此高亮定位必须搜整块范围。
 * 找不到块锚点时返回 null。
 */
function previewBlockLines(node) {
  const el = previewElementOf(node);
  const anchor = el && el.closest('[data-source-line]');
  if (!anchor) return null;
  const start = parseInt(anchor.getAttribute('data-source-line'), 10);
  if (Number.isNaN(start)) return null;
  const endRaw = parseInt(anchor.getAttribute('data-source-line-end'), 10);
  const end = Number.isNaN(endRaw) ? start + 1 : endRaw;
  return { el: anchor, start, end };
}

/**
 * 测量选区端点在「块渲染文本」中的字符偏移。
 * 用 Range 从块开头量到端点，取 toString().length —— <br> 等空元素不计入，
 * 正好与 textContent 口径一致，从而可与源码逐字符对齐。
 */
function previewSelectionOffsets(blockEl, range) {
  if (!blockEl || typeof document.createRange !== 'function') return null;
  const measure = (node, offset) => {
    const r = document.createRange();
    r.selectNodeContents(blockEl);
    try {
      r.setEnd(node, offset);
    } catch {
      return -1;
    }
    return r.toString().length;
  };
  const start = measure(range.startContainer, range.startOffset);
  const end = measure(range.endContainer, range.endOffset);
  if (start < 0 || end < 0 || end <= start) return null;
  return { start, end };
}

const PREVIEW_HIGHLIGHT_FAIL_MSG = '高亮设置失败，请在编辑模式中重新设置';

/**
 * 在源码 [from, to] 处包 / 取消包 <mark>。
 * 复用同一套 CodeMirror dispatch，保证只改这几个字符、不重写整篇（无损）。
 * 返回 'wrapped' | 'unwrapped' | 'noop'。
 */
// opts.collapseSelection：为 true 时不给编辑器留下选区（仅折叠成光标）。
// 预览侧触发的高亮要传 true —— 否则左侧对应文字会被「选中」却无处可见选区。
function applyMarkWrap(from, to, before, after, opts = {}) {
  const docLen = editor.state.doc.length;
  const selectedText = editor.state.sliceDoc(from, to);
  const textBefore = editor.state.sliceDoc(Math.max(0, from - before.length), from);
  const textAfter = editor.state.sliceDoc(to, Math.min(docLen, to + after.length));
  if (textBefore === before && textAfter === after) {
    const changes = [
      { from: from - before.length, to: from, insert: '' },
      { from: to, to: to + after.length, insert: '' },
    ];
    const anchorPos = from - before.length;
    editor.dispatch({
      changes,
      selection: opts.collapseSelection
        ? { anchor: anchorPos }
        : { anchor: anchorPos, head: to - before.length },
    });
    return 'unwrapped';
  } else if (selectedText) {
    const changes = { from, to, insert: before + selectedText + after };
    const endPos = to + before.length;
    editor.dispatch({
      changes,
      selection: opts.collapseSelection
        ? { anchor: endPos }
        : { anchor: from + before.length, head: endPos },
    });
    return 'wrapped';
  }
  return 'noop';
}

// 高亮诊断开关：定位「总是失败」用，控制台按 [md-editor][highlight] 过滤。稳定后改为 false。
const HIGHLIGHT_DEBUG = true;

function highlightLog(...args) {
  if (!HIGHLIGHT_DEBUG) return;
  console.warn('[md-editor][highlight]', ...args);
}

/** 描述一个选区端点，便于在日志里看清它落在哪个元素、有没有块锚点 */
function describePreviewNode(node) {
  if (!node) return String(node);
  const el = node.nodeType === 3 ? node.parentElement : node;
  const anchor = el && el.closest ? el.closest('[data-source-line]') : null;
  return {
    nodeType: node.nodeType,
    tag: el ? el.tagName : null,
    sourceLine: anchor ? anchor.getAttribute('data-source-line') : null,
    sourceLineEnd: anchor ? anchor.getAttribute('data-source-line-end') : null,
    text: node.nodeType === 3 ? node.nodeValue : el ? el.textContent : '',
  };
}

function highlightFail(guard, reason, detail) {
  highlightLog('FAIL', guard, reason, detail);
  // 两行：主提示 + 诊断码。showToast 检测到 \n 会加 .toast-multiline 居中排版
  showToast(`${PREVIEW_HIGHLIGHT_FAIL_MSG}\n${guard}--${reason}`, 'error');
  return false;
}

/**
 * 预览区选中文字 → 在源码对应位置包 <mark>。
 * 严格限制为「单块内、纯文本、唯一匹配」，其余情况一律失败提示，绝不走整篇 HTML→Markdown 回写。
 */
function highlightFromPreviewSelection(sel) {
  highlightLog('ENTRY', {
    hasSel: !!sel,
    rangeCount: sel ? sel.rangeCount : null,
    isCollapsed: sel ? sel.isCollapsed : null,
    anchorsInDom: document.querySelectorAll('#previewContainer [data-source-line]').length,
  });

  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    return highlightFail('G0', '选区无效', {
      hasSel: !!sel,
      rangeCount: sel ? sel.rangeCount : null,
      isCollapsed: sel ? sel.isCollapsed : null,
    });
  }
  const range = sel.getRangeAt(0);

  highlightLog('RANGE', {
    selectedText: range.toString(),
    start: describePreviewNode(range.startContainer),
    end: describePreviewNode(range.endContainer),
    common: describePreviewNode(range.commonAncestorContainer),
  });

  // 1. 受保护容器（代码块 / mermaid / svg）
  if (
    previewInsideProtected(range.startContainer) ||
    previewInsideProtected(range.endContainer) ||
    previewInsideProtected(range.commonAncestorContainer)
  ) {
    return highlightFail('G1', '受保护容器', {
      start: describePreviewNode(range.startContainer),
      end: describePreviewNode(range.endContainer),
      common: describePreviewNode(range.commonAncestorContainer),
    });
  }

  // 2b. 已有高亮：只有「完整选中同一个 mark」才放行（走 applyMarkWrap 的 unwrap 分支 = 取消高亮）。
  //     其余一切与已有高亮重叠的选区（部分选中 / 跨进跨出）一律拒绝，
  //     否则会在源码里生成 <mark>...<mark>...</mark>...</mark> 这类嵌套垃圾。
  const startMark = previewMarkAncestor(range.startContainer);
  const endMark = previewMarkAncestor(range.endContainer);
  const isWholeMark =
    !!startMark && startMark === endMark && range.toString() === startMark.textContent;

  // 2. 行内格式边界检查。
  //    旧逻辑：端点父链上出现任何行内格式就一律拒绝 —— 过严，
  //    导致 **加粗** / *斜体* 里的文字永远加不上高亮（哪怕一个 `*` 都没选中）。
  //    新逻辑：只要选区「完全落在同一个行内格式容器内部」就放行；
  //           只有一端有格式、或两端容器不同 → 说明跨过了格式边界（部分选中），
  //           插进去会把 `*斜<mark>体</mark>*` 这类结构撕裂，拒绝。
  const startInline = previewInlineContainer(range.startContainer);
  const endInline = previewInlineContainer(range.endContainer);
  if (startInline !== endInline) {
    return highlightFail('G2', '选区跨越行内格式边界', {
      selectedText: range.toString(),
      startInline: startInline ? startInline.tagName : null,
      endInline: endInline ? endInline.tagName : null,
      start: describePreviewNode(range.startContainer),
      end: describePreviewNode(range.endContainer),
    });
  }

  // 2a. 选区含图片 / 换行 → 渲染文本与源码无法逐字符对齐，拒绝
  if (previewRangeContains(range, PREVIEW_INLINE_BLOCKING_SELECTOR)) {
    return highlightFail('G2b', '选区含图片或换行', {
      selectedText: range.toString(),
      start: describePreviewNode(range.startContainer),
      end: describePreviewNode(range.endContainer),
    });
  }

  // 2d. 两端都在纯文本里、但选区内部夹着行内格式（如 `x **bold** y` 整段选中）
  //     → 选中文字在源码里并不连续（中间隔着 `**`），必然定位失败，提前给出明确原因
  if (!startInline && previewRangeContains(range, PREVIEW_INLINE_ALLOWED_SELECTOR)) {
    return highlightFail('G2x', '选区跨越行内格式（起止在格式之外）', {
      selectedText: range.toString(),
      start: describePreviewNode(range.startContainer),
      end: describePreviewNode(range.endContainer),
    });
  }

  // 2c. 自动链接（裸 URL）里插 <mark> 会破坏链接语法，拒绝
  if (/:\/\/|www\./i.test(range.toString())) {
    return highlightFail('G2u', '选区含裸链接', { selectedText: range.toString() });
  }

  if (!isWholeMark && (startMark || endMark || previewRangeTouchesMark(range))) {
    return highlightFail('G2m', '选区与已有高亮重叠', {
      selectedText: range.toString(),
      startMark: startMark ? startMark.textContent : null,
      endMark: endMark ? endMark.textContent : null,
      start: describePreviewNode(range.startContainer),
      end: describePreviewNode(range.endContainer),
    });
  }

  // 3. 跨块：起止所在块不同（如从一段选到另一段）一律失败
  const startBlock = previewBlockLines(range.startContainer);
  const endBlock = previewBlockLines(range.endContainer);
  if (!startBlock || !endBlock || startBlock.start !== endBlock.start) {
    return highlightFail('G3', '块锚点缺失或跨块', {
      startBlock,
      endBlock,
      start: describePreviewNode(range.startContainer),
      end: describePreviewNode(range.endContainer),
    });
  }

  // 4. 精确定位：以「选区在渲染文本中的字符偏移」为主信号，不再依赖「全文唯一匹配」。
  //    T1 渲染文本与源码逐字符相等 → 偏移恒等映射（零歧义）；
  //    T2/T3 无法恒等时（块内含行内格式 / 列表 / 标题标记）按行或整块取最近一匹配。
  //    只有两处候选距离完全相同时才失败。
  const doc = editor.state.doc;
  const selectedText = range.toString();
  if (!selectedText) {
    return highlightFail('G4a', '选中文本为空', { selectedText });
  }
  const blockStart = Math.max(0, startBlock.start);
  const blockEnd = Math.min(doc.lines, startBlock.end); // doc.lines 为行数，exclusive 上限
  if (blockEnd <= blockStart) {
    return highlightFail('G4b', '块行范围无效', {
      blockStart,
      blockEnd,
      docLines: doc.lines,
    });
  }

  const lineEntries = [];
  for (let lineIndex = blockStart; lineIndex < blockEnd; lineIndex++) {
    const lineObj = doc.line(lineIndex + 1); // token.map 为 0-based，CodeMirror 行号 1-based
    lineEntries.push({ text: lineObj.text, from: lineObj.from });
  }
  const offsets = previewSelectionOffsets(startBlock.el, range);
  if (!offsets) {
    return highlightFail('G4d', '无法计算选区偏移', {
      selectedText,
      start: describePreviewNode(range.startContainer),
      end: describePreviewNode(range.endContainer),
    });
  }

  const match = locateSelectionInBlock({
    renderedText: startBlock.el.textContent || '',
    lineEntries,
    selectedText,
    selStart: offsets.start,
    selEnd: offsets.end,
  });
  if (!match) {
    return highlightFail('G4c', '无法定位到源码位置', {
      selectedText,
      blockStart,
      blockEnd,
      selStart: offsets.start,
      selEnd: offsets.end,
      renderedText: startBlock.el.textContent,
      lineEntries,
    });
  }
  highlightLog('LOCATED', match.mode, { match, selectedText, selStart: offsets.start });

  const result = applyMarkWrap(match.from, match.to, '<mark>', '</mark>', {
    collapseSelection: true,
  });
  if (result === 'noop') {
    return highlightFail('G5', '写入源码失败', { match, selectedText, result });
  }
  highlightLog('OK', result, { match, selectedText });
  showToast(result === 'wrapped' ? '已高亮' : '已取消高亮', 'success');
  return true;
}

/**
 * 高亮入口：工具栏 / 右键菜单共用。
 * - 预览区有选区 → 在源码对应位置精准插入 <mark>（单块纯文本、唯一匹配才成功）
 * - 编辑区有选区 → 直接在源码侧包 <mark>
 * 全程不经过整篇 HTML→Markdown 回写，避免 mermaid / 表格 / 嵌套列表等结构丢失。
 */
function applyPreviewHighlight() {
  const previewContainer = document.getElementById('previewContainer');
  const sel = window.getSelection();

  if (selectionInsideRoot(sel, previewContainer)) {
    return highlightFromPreviewSelection(sel);
  }

  // 左侧编辑区有选区 → 直接在源码侧包 <mark>
  const edSel = editor.state.selection.main;
  if (edSel.from !== edSel.to) {
    wrapSelection('<mark>', '</mark>');
    showToast('已在源码中高亮选中文字', 'success');
    return true;
  }
  showToast('请先在预览区或编辑区选中文字，再点高亮', 'error');
  return false;
}

function hidePreviewContextMenu() {
  const menu = document.getElementById('previewContextMenu');
  if (menu) menu.remove();
}

function showPreviewContextMenu(clientX, clientY) {
  hidePreviewContextMenu();

  const menu = document.createElement('div');
  menu.id = 'previewContextMenu';
  menu.className = 'preview-context-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <button type="button" class="preview-context-item" data-action="highlight" role="menuitem">
      高亮 / 取消高亮
    </button>
  `;

  document.body.appendChild(menu);

  const pad = 8;
  const rect = menu.getBoundingClientRect();
  let left = clientX;
  let top = clientY;
  if (left + rect.width > window.innerWidth - pad) {
    left = window.innerWidth - rect.width - pad;
  }
  if (top + rect.height > window.innerHeight - pad) {
    top = window.innerHeight - rect.height - pad;
  }
  menu.style.left = `${Math.max(pad, left)}px`;
  menu.style.top = `${Math.max(pad, top)}px`;

  menu.querySelector('[data-action="highlight"]').addEventListener('mousedown', (e) => {
    e.preventDefault(); // 保住选区
  });
  menu.querySelector('[data-action="highlight"]').addEventListener('click', (e) => {
    e.preventDefault();
    hidePreviewContextMenu();
    applyPreviewHighlight();
  });
}

function initPreviewSelection() {
  const previewContainer = document.getElementById('previewContainer');

  // 预览区是纯只读展示，不开 contenteditable。
  // 以前开启 WYSIWYG 后，只要点一下预览区就会拿到焦点，失焦时整篇 innerHTML
  // 被回写成 Markdown；mermaid 图表、表格、脚注等结构在这种往返里会被抹掉，
  // 表现为「点一下预览区再点回编辑区，代码块就消失了」。
  // 现在源码只由左侧编辑器改动，预览不再参与回写。
  previewContainer.setAttribute('contenteditable', 'false');

  // 记录预览选区（供「高亮」使用）
  previewContainer.addEventListener('mouseup', () => {
    rememberPreviewSelection();
  });

  // 右键：有选区时出「高亮」菜单
  previewContainer.addEventListener('contextmenu', (event) => {
    rememberPreviewSelection();
    const sel = window.getSelection();
    if (!selectionInsideRoot(sel, previewContainer) && !savedPreviewRange) {
      return; // 无选区：保留浏览器默认菜单
    }
    event.preventDefault();
    showPreviewContextMenu(event.clientX, event.clientY);
  });

  document.addEventListener('mousedown', (event) => {
    const menu = document.getElementById('previewContextMenu');
    if (menu && !menu.contains(event.target)) {
      hidePreviewContextMenu();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hidePreviewContextMenu();
  });
}

/**
 * 编辑区获焦或产生选区时，作废预览选区。
 *
 * savedPreviewRange 只在「预览区 mouseup / 右键」时写入，标记「用户上一次文字交互发生在预览区」。
 * 一旦用户回到编辑区操作（聚焦或框选），就把它作废，避免点高亮时把旧的预览选区当成当前选区，
 * 从而误走进「预览区高亮」分支。现在预览区已禁止高亮，这里只是确保选区来源判断始终准确。
 */
function initEditorSelectionGuard() {
  editor.contentDOM.addEventListener('focus', () => {
    savedPreviewRange = null;
  });
  editor.contentDOM.addEventListener('mouseup', () => {
    savedPreviewRange = null;
  });
}

function initPreviewLinkNavigation() {
  const previewContainer = document.getElementById('previewContainer');

  previewContainer.addEventListener('click', async (event) => {
    const targetUrl = resolvePreviewLinkClickTarget(event.target, previewContainer, {
      currentFileUrl,
    });
    if (!targetUrl) return;

    event.preventDefault();
    event.stopPropagation();

    try {
      await openPreviewLink(targetUrl);
    } catch (err) {
      showToast('打开链接失败: ' + err.message, 'error');
    }
  });
}

async function openPreviewLink(targetUrl) {
  if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
    await chrome.tabs.create({ url: targetUrl });
    return;
  }

  const opened = window.open(targetUrl, '_blank', 'noopener,noreferrer');
  if (!opened) {
    throw new Error('浏览器阻止了新标签页');
  }
}

// ==========================================
// 状态栏更新
// ==========================================
function updateStatus() {
  const content = editor.state.doc.toString();
  const lines = editor.state.doc.lines;

  // 字数（中文+英文）
  const chineseChars = (content.match(/[\u4e00-\u9fff]/g) || []).length;
  const englishWords = (content.match(/[a-zA-Z]+/g) || []).length;
  const wordCount = chineseChars + englishWords;

  document.getElementById('statusWords').textContent = `字数: ${wordCount}`;
  document.getElementById('statusChars').textContent = `字符: ${content.length}`;
  document.getElementById('statusLines').textContent = `行: ${lines}`;
}

function updateCursorStatus() {
  const sel = editor.state.selection.main;
  const line = editor.state.doc.lineAt(sel.head);
  const col = sel.head - line.from + 1;

  document.getElementById('statusCursor').textContent = `列: ${col}`;

  // 选中文本信息
  const selStatus = document.getElementById('statusSelection');
  if (sel.from !== sel.to) {
    const selectedText = editor.state.sliceDoc(sel.from, sel.to);
    selStatus.textContent = `已选: ${selectedText.length} 字符`;
  } else {
    selStatus.textContent = '';
  }
}

// ==========================================
// 会话恢复：记住当前文档内容（无法持久化 FileHandle）
// ==========================================
async function rememberCurrentDocument(extra = {}) {
  if (!editor) return;
  const filenameEl = document.getElementById('filename');
  const filename =
    extra.filename ||
    (filenameEl && filenameEl.textContent && filenameEl.textContent !== '未打开文件'
      ? filenameEl.textContent
      : 'untitled.md');
  await rememberLastFile({
    content: editor.state.doc.toString(),
    filename,
    sourceUrl: extra.sourceUrl ?? currentFileUrl ?? null,
  });
}

async function tryRestoreLastDocument() {
  const last = await loadLastFile();
  if (!last) return false;
  // 仅在仍是空白会话时恢复，避免覆盖刚打开的 pending 文件
  const content = editor?.state?.doc?.toString?.() ?? '';
  if (content.trim().length > 0) return false;

  clearCurrentDocumentContext();
  if (last.sourceUrl) {
    setCurrentDocumentContext({ fileUrl: last.sourceUrl, directoryPath: null });
  }
  setEditorContent(last.content);
  updateFilename(last.filename);
  currentFileHandle = null;
  markSaved();
  hideOnboarding();
  showToast(`已恢复: ${last.filename}（保存时可能需另选位置）`, 'success');
  return true;
}

// ==========================================
// 文件操作
// ==========================================
async function handleOpen() {
  try {
    const [fileHandle] = await window.showOpenFilePicker({
      types: [{
        description: 'Markdown 文件',
        accept: { 'text/markdown': OPENABLE_EXTENSIONS.map((ext) => `.${ext}`) },
      }],
      multiple: false,
    });

    const file = await fileHandle.getFile();
    const content = await file.text();

    currentFileHandle = fileHandle;
    clearCurrentDocumentContext();
    setEditorContent(content);
    updateFilename(file.name);
    markSaved();
    await rememberCurrentDocument({ filename: file.name });
    showToast(`已打开: ${file.name}`, 'success');
    hideOnboarding();
  } catch (err) {
    if (err.name !== 'AbortError') {
      showToast('打开文件失败: ' + err.message, 'error');
    }
  }
  return true;
}

async function handleSave() {
  try {
    if (currentFileHandle) {
      // 保存到已有文件
      const writable = await currentFileHandle.createWritable();
      await writable.write(editor.state.doc.toString());
      await writable.close();
      markSaved();
      await rememberCurrentDocument();
      showToast('文件已保存', 'success');
    } else {
      // 另存为
      await handleSaveAs();
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      showToast('保存失败: ' + err.message, 'error');
    }
  }
  return true;
}

async function handleSaveAs() {
  try {
    const fileHandle = await window.showSaveFilePicker({
      suggestedName: currentBaseName || 'untitled.md',
      types: [{
        description: 'Markdown 文件',
        accept: { 'text/markdown': ['.md'] },
      }],
    });

    const writable = await fileHandle.createWritable();
    await writable.write(editor.state.doc.toString());
    await writable.close();

    currentFileHandle = fileHandle;
    clearCurrentDocumentContext();
    const savedName = (await fileHandle.getFile()).name;
    updateFilename(savedName);
    markSaved();
    await rememberCurrentDocument({ filename: savedName });
    showToast('文件已保存', 'success');
  } catch (err) {
    if (err.name !== 'AbortError') {
      showToast('保存失败: ' + err.message, 'error');
    }
  }
}

function handleNew() {
  if (isModified) {
    if (!confirm('当前文件有未保存的更改，确定要新建文件吗？')) {
      return;
    }
  }
  currentFileHandle = null;
  clearCurrentDocumentContext();
  setEditorContent('');
  updateFilename('未打开文件');
  markSaved();
}

function setEditorContent(content) {
  editor.dispatch({
    changes: {
      from: 0,
      to: editor.state.doc.length,
      insert: content,
    },
  });
  // 整篇替换（打开文件 / 拖拽 / 会话恢复）-> 滚动回到顶部，下次预览刷新不保持位置
  previewScrollResetRequested = true;
  // 并立刻标记并重刷大纲（若正在看大纲）
  outlineDirty = true;
  refreshOutlineIfDirty();
}

function updateFilename(name) {
  document.getElementById('filename').textContent = name;
  // 记录原始文件名，供「保存为」默认建议名使用。
  // 特殊占位（'未打开文件'）与空值不污染，让保存为回落到 untitled.md。
  currentBaseName = name && name !== '未打开文件' ? name : '';
}

function markModified() {
  if (!isModified) {
    isModified = true;
    document.getElementById('modifiedIndicator').style.display = 'inline';
  }
}

function markSaved() {
  isModified = false;
  document.getElementById('modifiedIndicator').style.display = 'none';
}

// ==========================================
// 格式化工具
// ==========================================
function wrapSelection(before, after) {
  const sel = editor.state.selection.main;
  if (sel.from !== sel.to) {
    // 有选区 → 复用源码侧包 / 取消包逻辑（highlightFromPreviewSelection 同款，保证无损）
    applyMarkWrap(sel.from, sel.to, before, after);
    editor.focus();
    return true;
  }
  // 无选中 → 插入占位模板（加粗 / 斜体 / 删除线 / 代码等）
  const placeholder =
    before === '**' ? '加粗文本' :
    before === '*' ? '斜体文本' :
    before === '~~' ? '删除线文本' :
    before === '`' ? 'code' : '文本';
  editor.dispatch({
    changes: { from: sel.from, insert: before + placeholder + after },
    selection: { anchor: sel.from + before.length, head: sel.from + before.length + placeholder.length },
  });
  editor.focus();
  return true;
}

function insertAtLineStart(prefix) {
  const sel = editor.state.selection.main;
  const line = editor.state.doc.lineAt(sel.head);
  const currentContent = line.text;

  if (currentContent.startsWith(prefix)) {
    // 已有前缀 → 移除
    editor.dispatch({
      changes: { from: line.from, to: line.from + prefix.length, insert: '' },
    });
  } else {
    // 插入前缀
    editor.dispatch({
      changes: { from: line.from, insert: prefix },
    });
  }
  editor.focus();
  return true;
}

function insertBlock(text) {
  const sel = editor.state.selection.main;
  const line = editor.state.doc.lineAt(sel.head);

  // 确保在行尾插入，加上换行
  const insertPos = line.to;
  const prefix = line.text.length > 0 ? '\n\n' : '';

  editor.dispatch({
    changes: { from: insertPos, insert: prefix + text },
  });
  editor.focus();
  return true;
}

// ==========================================
// 主题切换
// ==========================================
function toggleTheme() {
  currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('md-editor-theme', currentTheme);

  document.documentElement.setAttribute('data-theme', currentTheme === 'light' ? 'light' : '');

  editor.dispatch({
    effects: themeCompartment.reconfigure(
      currentTheme === 'dark' ? oneDark : lightTheme
    ),
  });

  // 更新 Mermaid 主题
  mermaid.initialize({
    startOnLoad: false,
    theme: currentTheme === 'dark' ? 'dark' : 'default',
    securityLevel: 'strict',
    fontFamily: 'sans-serif',
  });
  // 重新渲染预览中的 Mermaid
  doUpdatePreview();

  // 更新主题图标
  updateThemeIcon();
}

function updateThemeIcon() {
  const icon = document.getElementById('themeIcon');
  if (currentTheme === 'dark') {
    icon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
  } else {
    icon.innerHTML = '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
  }
}

// ==========================================
// 视图模式切换
// ==========================================
function setViewMode(mode) {
  currentViewMode = mode;

  document.getElementById('editorMain').setAttribute('data-mode', mode);

  // 切换视图时清掉拖拽分隔线写入的 inline flex：
  // 1) 切到全编辑/全预览 -> inline 优先级高于 CSS 的 flex:1，不清除会卡在拖拽后的
  //    比例（如 60%/40%），导致面板只占了部分宽度、其余空白、看起来「变窄」；
  // 2) 切回左编辑右预览 -> 回到 CSS 默认的 flex:1 平分（初始中线位置），
  //    即「拖拽只在这次 split 会话内有效，切走再切回回到初始值」。
  const editorPanel = document.getElementById('editorPanel');
  const previewPanel = document.getElementById('previewPanel');
  if (editorPanel) editorPanel.style.flex = '';
  if (previewPanel) previewPanel.style.flex = '';

  // 更新按钮状态
  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  // 切换后刷新编辑器布局
  if (editor) {
    requestAnimationFrame(() => editor.requestMeasure());
  }
}

// ==========================================
// 侧边栏：大纲 / 文件 视图切换 + 大纲导航
// ==========================================

/**
 * Switch the left sidebar between the outline view and the file view.
 * The `data-panel` attribute on the aside drives the CSS that shows/hides
 * each panel and the "open folder" button.
 */
function setSidebarPanel(panel) {
  currentSidebarPanel = panel;
  const aside = document.getElementById('fileSidebar');
  if (aside) aside.setAttribute('data-panel', panel);

  document.querySelectorAll('#sidebarSegmented .seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.sidebar === panel);
  });

  // 鼠标已在侧栏内时切到大纲页，mouseenter 不会二次触发，这里补刷一次
  if (panel === 'outline') refreshOutlineIfDirty();
}

/**
 * Rebuild the outline list only when it is actually needed and has changed.
 * - Not dirty -> do nothing.
 * - Dirty but not on the outline panel -> keep dirty, refresh when shown.
 * - Signature unchanged -> don't touch the DOM (prevents flicker).
 */
function refreshOutlineIfDirty() {
  if (!outlineDirty) return;
  if (currentSidebarPanel !== 'outline') return;
  refreshOutline();
}

function refreshOutline() {
  const tree = document.getElementById('outlineTree');
  if (!tree || !editor) return;

  const items = parseOutline(editor.state.doc.toString());
  const sig = outlineSignature(items);
  if (sig === lastOutlineSignature) {
    outlineDirty = false;
    return; // 大纲没变，完全不碰 DOM
  }
  lastOutlineSignature = sig;

  const keepScroll = tree.scrollTop;
  const frag = buildOutlineList(items, {
    onSelect: (item) => scrollToOutlineItem(item.line),
  });
  tree.replaceChildren(frag); // 用 textContent 构建，避免 innerHTML 注入
  tree.scrollTop = keepScroll;
  outlineDirty = false;
}

/**
 * Jump to a heading by its 0-based source line.
 * - preview: scroll the matching [data-source-line] element into view
 * - editor: move the cursor to that line and scroll it into view
 * Both run when in split mode; only the visible panel(s) react otherwise.
 */
function scrollToOutlineItem(line) {
  const sourceLine = Math.max(0, line | 0);

  // ---- Preview side ----
  const previewContainer = document.getElementById('previewContainer');
  if (previewContainer && previewContainer.offsetParent !== null) {
    const el = previewContainer.querySelector(`[data-source-line="${sourceLine}"]`);
    if (el) {
      const top =
        el.getBoundingClientRect().top -
        previewContainer.getBoundingClientRect().top +
        previewContainer.scrollTop;
      previewContainer.scrollTop = Math.max(0, top - 8);
    } else {
      // 预览可能还没渲染完（mermaid 异步 / 防抖），等一拍再试一次
      updatePreview();
      setTimeout(() => {
        const retry = previewContainer.querySelector(`[data-source-line="${sourceLine}"]`);
        if (retry) {
          const t =
            retry.getBoundingClientRect().top -
            previewContainer.getBoundingClientRect().top +
            previewContainer.scrollTop;
          previewContainer.scrollTop = Math.max(0, t - 8);
        }
      }, 140);
    }
  }

  // ---- Editor side ----
  if (editor && document.getElementById('editorPanel').offsetParent !== null) {
    const lineObj = editor.state.doc.line(Math.min(sourceLine + 1, editor.state.doc.lines));
    editor.dispatch({
      selection: { anchor: lineObj.from },
      effects: EditorView.scrollIntoView(lineObj.from, { y: 'start' }),
    });
  }
}

// ==========================================
// 拖拽分屏调整
// ==========================================
function initResizer() {
  const resizer = document.getElementById('resizer');
  const editorPanel = document.getElementById('editorPanel');
  const previewPanel = document.getElementById('previewPanel');
  const editorMain = document.getElementById('editorMain');

  let isResizing = false;

  resizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const startX = e.clientX;
    const totalWidth = editorMain.offsetWidth;
    const startEditorWidth = editorPanel.offsetWidth;

    function onMouseMove(e) {
      if (!isResizing) return;
      const dx = e.clientX - startX;
      const newEditorWidth = startEditorWidth + dx;
      const editorPercent = (newEditorWidth / totalWidth) * 100;

      if (editorPercent > 20 && editorPercent < 80) {
        editorPanel.style.flex = `0 0 ${editorPercent}%`;
        previewPanel.style.flex = `0 0 ${100 - editorPercent}%`;
      }
    }

    function onMouseUp() {
      isResizing = false;
      resizer.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      if (editor) editor.requestMeasure();
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

// ==========================================
// Toast 通知
// ==========================================
let toastTimeout = null;

function showToast(message, type = '') {
  // 移除已有 toast
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  // 含换行的消息（如高亮失败的主提示 + 诊断码）走多行居中排版；
  // 其余调用点不受影响，仍是原来的单行。
  if (typeof message === 'string' && message.includes('\n')) {
    toast.classList.add('toast-multiline');
    for (const line of message.split('\n')) {
      const lineEl = document.createElement('div');
      lineEl.className = 'toast-line';
      lineEl.textContent = line;
      toast.appendChild(lineEl);
    }
  } else {
    toast.textContent = message;
  }
  document.body.appendChild(toast);

  clearTimeout(toastTimeout);
  requestAnimationFrame(() => {
    toast.classList.add('show');
  });

  toastTimeout = setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// ==========================================
// 事件绑定
// ==========================================
function bindEvents() {
  // 文件操作
  document.getElementById('btnOpen').addEventListener('click', handleOpen);
  document.getElementById('btnSave').addEventListener('click', handleSave);
  document.getElementById('btnNew').addEventListener('click', handleNew);

  // 格式化按钮
  document.getElementById('btnBold').addEventListener('click', () => wrapSelection('**', '**'));
  document.getElementById('btnItalic').addEventListener('click', () => wrapSelection('*', '*'));
  document.getElementById('btnStrike').addEventListener('click', () => wrapSelection('~~', '~~'));
  document.getElementById('btnCode').addEventListener('click', () => wrapSelection('`', '`'));

  // 高亮：优先作用在右侧预览选区；无选区时退回源码选区包 <mark>
  const btnHighlight = document.getElementById('btnHighlight');
  if (btnHighlight) {
    btnHighlight.addEventListener('mousedown', (e) => {
      // 避免按钮抢走焦点导致预览选区丢失
      e.preventDefault();
      rememberPreviewSelection();
    });
    btnHighlight.addEventListener('click', () => {
      applyPreviewHighlight();
    });
  }

  // 使用说明（重新打开引导说明书）
  const btnHelp = document.getElementById('btnHelp');
  if (btnHelp) {
    btnHelp.addEventListener('click', () => {
      showOnboarding({ force: true, mode: 'guide' });
    });
  }

  // 标题
  document.getElementById('btnH1').addEventListener('click', () => insertAtLineStart('# '));
  document.getElementById('btnH2').addEventListener('click', () => insertAtLineStart('## '));
  document.getElementById('btnH3').addEventListener('click', () => insertAtLineStart('### '));
  document.getElementById('btnH4').addEventListener('click', () => insertAtLineStart('#### '));
  document.getElementById('btnH5').addEventListener('click', () => insertAtLineStart('##### '));

  // 列表和引用
  document.getElementById('btnUL').addEventListener('click', () => insertAtLineStart('- '));
  document.getElementById('btnOL').addEventListener('click', () => insertAtLineStart('1. '));
  document.getElementById('btnQuote').addEventListener('click', () => insertAtLineStart('> '));

  // 代码块
  document.getElementById('btnCodeBlock').addEventListener('click', () => insertBlock('```\n\n```'));

  // 链接
  document.getElementById('btnLink').addEventListener('click', () => {
    const sel = editor.state.selection.main;
    const selectedText = editor.state.sliceDoc(sel.from, sel.to);
    if (selectedText) {
      editor.dispatch({
        changes: { from: sel.from, to: sel.to, insert: `[${selectedText}](url)` },
        selection: { anchor: sel.from + selectedText.length + 3, head: sel.from + selectedText.length + 6 },
      });
    } else {
      editor.dispatch({
        changes: { from: sel.from, insert: '[链接文本](url)' },
        selection: { anchor: sel.from + 1, head: sel.from + 5 },
      });
    }
    editor.focus();
  });

  // 表格
  document.getElementById('btnTable').addEventListener('click', () => {
    insertBlock('| 列1 | 列2 | 列3 |\n|------|------|------|\n| 内容 | 内容 | 内容 |');
  });

  // 水平线
  document.getElementById('btnHR').addEventListener('click', () => insertBlock('---'));

  // 视图模式
  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', () => setViewMode(btn.dataset.mode));
  });

  // 主题切换
  document.getElementById('btnTheme').addEventListener('click', toggleTheme);

  // 阅读翻译（预览双语对照）
  const btnTranslate = document.getElementById('btnTranslate');
  if (btnTranslate) {
    btnTranslate.addEventListener('click', () => {
      toggleTranslateMode();
    });
    btnTranslate.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openTranslateSettingsModal();
    });
  }
  document.getElementById('btnTranslateSettings')?.addEventListener('click', () => {
    openTranslateSettingsModal();
  });
  initTranslateSettingsModal();

  // 拦截浏览器默认 Ctrl+S
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 's') {
        e.preventDefault();
        handleSave();
      } else if (e.key === 'o') {
        e.preventDefault();
        handleOpen();
      }
    }
  });

  // 离开提示
  window.addEventListener('beforeunload', (e) => {
    if (isModified) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // 拖拽文件打开
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      if (isOpenableFile(file.name)) {
        const content = await file.text();
        setEditorContent(content);
        updateFilename(file.name);
        currentFileHandle = null; // 拖拽打开无 handle
        clearCurrentDocumentContext();
        markSaved();
        await rememberCurrentDocument({ filename: file.name });
        hideOnboarding();
        showToast(`已打开: ${file.name}`, 'success');
      } else {
        showToast('请拖入 .md 或 .markdown 文件', 'error');
      }
    }
  });
}

function initPasteImageSupport() {
  editor.contentDOM.addEventListener('paste', async (event) => {
    const items = Array.from(event.clipboardData?.items || []);
    const imageItem = items.find((item) => item.type.startsWith('image/'));

    if (!imageItem) return;

    const file = imageItem.getAsFile();
    if (!file) return;

    event.preventDefault();

    try {
      const { imagePath, storageMode } = await persistPastedImage(file);
      const markdown = buildPastedImageMarkdown({
        alt: 'pasted-image',
        imagePath,
      });

      insertMarkdownSnippet(markdown);

      if (storageMode === 'file') {
        showToast(`图片已保存并插入: ${imagePath}`, 'success');
      } else {
        showToast('图片已以内嵌 data URL 插入 Markdown', 'success');
      }
    } catch (err) {
      showToast('粘贴图片失败: ' + err.message, 'error');
    }
  });
}

function insertMarkdownSnippet(snippet) {
  const sel = editor.state.selection.main;
  const beforeChar = sel.from > 0 ? editor.state.sliceDoc(sel.from - 1, sel.from) : '';
  const afterChar = sel.to < editor.state.doc.length ? editor.state.sliceDoc(sel.to, sel.to + 1) : '';

  let insert = snippet;
  if (beforeChar && beforeChar !== '\n') {
    insert = '\n' + insert;
  }
  if (afterChar && afterChar !== '\n') {
    insert = insert + '\n';
  }

  const anchor = sel.from + insert.length;
  editor.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor, head: anchor },
  });
  editor.focus();
}

async function persistPastedImage(file) {
  if (directoryHandle && currentDirectoryPath !== null) {
    try {
      const imagePath = await savePastedImageToDirectory(file);
      return { imagePath, storageMode: 'file' };
    } catch (err) {
      console.warn('写入 images/ 目录失败，回退到 data URL:', err);
    }
  }

  const imagePath = await blobToDataUrl(file);
  return { imagePath, storageMode: 'data-url' };
}

async function savePastedImageToDirectory(file) {
  const hasPermission = await ensureDirectoryPermission(directoryHandle, 'readwrite');
  if (!hasPermission) {
    throw new Error('没有写入当前文件夹的权限');
  }

  const currentDirHandle = await getCurrentMarkdownDirectoryHandle();
  const imagesHandle = await currentDirHandle.getDirectoryHandle('images', { create: true });
  const filename = createPastedImageFilename({
    timestamp: new Date(),
    extension: mimeTypeToExtension(file.type),
  });
  const imageFileHandle = await imagesHandle.getFileHandle(filename, { create: true });
  const writable = await imageFileHandle.createWritable();
  await writable.write(file);
  await writable.close();

  return buildImagesRelativePath(filename);
}

async function getCurrentMarkdownDirectoryHandle() {
  if (!directoryHandle || currentDirectoryPath === null) {
    throw new Error('当前文件没有可写目录上下文');
  }

  let handle = directoryHandle;
  for (const segment of splitRelativePath(currentDirectoryPath)) {
    handle = await handle.getDirectoryHandle(segment);
  }

  return handle;
}

async function ensureDirectoryPermission(handle, mode = 'read') {
  if (!handle?.queryPermission || !handle?.requestPermission) {
    return true;
  }

  const options = { mode };
  if ((await handle.queryPermission(options)) === 'granted') {
    return true;
  }

  return (await handle.requestPermission(options)) === 'granted';
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('读取剪贴板图片失败'));
    reader.readAsDataURL(blob);
  });
}

// ==========================================
// 文件浏览器侧边栏
// ==========================================
let directoryHandle = null;
let isSidebarCollapsed = localStorage.getItem('md-sidebar-collapsed') === 'true';

// 文件树过滤：睁眼(true) = 显示全部；带斜线(false) = 只看可打开的文件。持久化。
let showUnopenable = localStorage.getItem('md-file-tree-show-unopenable') !== 'false';
// 最近一次扫描结果。点眼镜只重渲染、不重新遍历目录（大文件夹下避免卡顿）。
let fileTreeEntries = null;
// 按 path 记住展开过的目录，重渲染后还原。
// 睁眼态与过滤态各存一份：过滤态只自动展开第一层，若共用一份，
// 睁眼态手动展开的深层目录会在切到过滤态后仍保持展开，看起来就像「嵌套被自动打开了」。
const expandedDirs = new Set();
const expandedDirsFiltered = new Set();

/** 眼镜按钮只在「已打开文件夹」时才有意义（只打开单个文件时没有文件树可过滤） */
function updateEyeButtonVisibility() {
  const btn = document.getElementById('btnToggleUnopenable');
  if (!btn) return;
  btn.classList.toggle('hidden', !directoryHandle);
  btn.classList.toggle('filtering', !showUnopenable);
  btn.title = showUnopenable ? '只看可打开的文件' : '显示全部文件';
}

async function handleOpenFolder() {
  try {
    directoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    fileTreeEntries = null;
    expandedDirs.clear();
    expandedDirsFiltered.clear();
    updateEyeButtonVisibility();
    await renderFileTree({ rescan: true });
    showToast(`已打开文件夹: ${directoryHandle.name}`, 'success');
  } catch (err) {
    if (err.name !== 'AbortError') {
      showToast('打开文件夹失败: ' + err.message, 'error');
    }
  }
}

async function readDirectoryRecursive(dirHandle, depth = 0, parentPath = '') {
  const entries = [];
  for await (const entry of dirHandle.values()) {
    // 跳过隐藏文件和 node_modules / dist 等
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;

    const entryPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;

    if (entry.kind === 'directory') {
      const children = depth < 5 ? await readDirectoryRecursive(entry, depth + 1, entryPath) : [];
      entries.push({ name: entry.name, kind: 'directory', handle: entry, path: entryPath, children });
    } else {
      entries.push({ name: entry.name, kind: 'file', handle: entry, path: entryPath });
    }
  }

  // 排序：文件夹在前，再按名称排序
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh');
  });

  return entries;
}

async function renderFileTree({ rescan = false } = {}) {
  const container = document.getElementById('fileTree');
  if (!directoryHandle) return;

  container.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:12px;text-align:center;">加载中...</div>';

  try {
    // 只有「打开文件夹 / 刷新」才真正遍历目录；切过滤态复用缓存
    if (rescan || !fileTreeEntries) {
      fileTreeEntries = await readDirectoryRecursive(directoryHandle);
    }
    const entries = showUnopenable
      ? fileTreeEntries
      : pruneNonOpenable(fileTreeEntries);
    container.innerHTML = '';

    // 根目录标题
    const rootDiv = document.createElement('div');
    rootDiv.className = 'tree-item';
    rootDiv.style.fontWeight = '600';
    rootDiv.style.paddingLeft = '8px';

    const rootIcon = document.createElement('span');
    rootIcon.className = 'tree-item-icon';
    rootIcon.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
    `;
    const rootName = document.createElement('span');
    rootName.className = 'tree-item-name';
    rootName.textContent = directoryHandle.name;
    rootDiv.append(rootIcon, rootName);
    container.appendChild(rootDiv);

    renderTreeEntries(container, entries, 1);

    // 过滤态下整棵树可能被剪空，给个明确提示而不是留一个孤零零的根目录
    if (entries.length === 0) {
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'sidebar-empty';
      emptyDiv.style.height = 'auto';
      emptyDiv.style.padding = '16px 20px';
      const p = document.createElement('p');
      p.textContent = showUnopenable
        ? '此文件夹为空'
        : '此文件夹没有可打开的文件';
      emptyDiv.appendChild(p);
      container.appendChild(emptyDiv);
    }
  } catch (err) {
    container.replaceChildren();
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = 'padding:12px;color:var(--danger);font-size:12px;';
    errorDiv.textContent = err.message || String(err);
    container.appendChild(errorDiv);
  }
}

function renderTreeEntries(parent, entries, depth) {
  for (const entry of entries) {
    if (entry.kind === 'directory') {
      renderDirectoryNode(parent, entry, depth);
    } else {
      renderFileNode(parent, entry, depth);
    }
  }
}

function renderDirectoryNode(parent, entry, depth) {
  const itemDiv = document.createElement('div');
  itemDiv.className = 'tree-item';
  itemDiv.style.paddingLeft = `${depth * 16 + 8}px`;

  const chevronEl = document.createElement('span');
  chevronEl.className = 'tree-item-chevron';
  chevronEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9,6 15,12 9,18"/></svg>`;

  const iconEl = document.createElement('span');
  iconEl.className = 'tree-item-icon';
  iconEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="var(--warning)" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;

  const nameEl = document.createElement('span');
  nameEl.className = 'tree-item-name';
  nameEl.textContent = entry.name;

  itemDiv.append(chevronEl, iconEl, nameEl);

  // 子节点容器
  const childrenDiv = document.createElement('div');
  childrenDiv.className = 'tree-children';

  if (entry.children && entry.children.length > 0) {
    renderTreeEntries(childrenDiv, entry.children, depth + 1);
  }

  // 展开状态：
  // - 过滤态（带斜线）只自动展开第一层（depth === 1），嵌套文件夹保持折叠，用户点开才算数；
  // - 睁眼态按各自记录还原，避免切一下过滤就把手动展开的目录全折叠回去。
  const expanded =
    (!showUnopenable && depth === 1) ||
    (showUnopenable ? expandedDirs : expandedDirsFiltered).has(entry.path);
  if (expanded) {
    chevronEl.classList.add('expanded');
    childrenDiv.classList.add('expanded');
  }

  // 点击展开/折叠
  itemDiv.addEventListener('click', (e) => {
    e.stopPropagation();
    const nowExpanded = childrenDiv.classList.toggle('expanded');
    chevronEl.classList.toggle('expanded', nowExpanded);
    const memory = showUnopenable ? expandedDirs : expandedDirsFiltered;
    if (nowExpanded) memory.add(entry.path);
    else memory.delete(entry.path);
  });

  parent.appendChild(itemDiv);
  parent.appendChild(childrenDiv);
}

function renderFileNode(parent, entry, depth) {
  const itemDiv = document.createElement('div');
  itemDiv.className = 'tree-item';
  itemDiv.style.paddingLeft = `${depth * 16 + 24}px`; // 多缩进一点，对齐文件夹下的文件

  const isMarkdown = isOpenableFile(entry.name);
  const iconColor = isMarkdown ? 'var(--accent)' : 'var(--text-muted)';
  const iconEl = document.createElement('span');
  iconEl.className = 'tree-item-icon';
  iconEl.innerHTML = isMarkdown
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="${iconColor}" stroke-width="2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14,2 14,8 20,8"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="${iconColor}" stroke-width="2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/></svg>`;

  const nameEl = document.createElement('span');
  nameEl.className = 'tree-item-name';
  nameEl.textContent = entry.name;

  itemDiv.append(iconEl, nameEl);

  if (isMarkdown) {
    itemDiv.addEventListener('click', async (e) => {
      e.stopPropagation();
      await openFileFromTree(entry.handle, entry.name, entry.path);
      // 高亮当前文件
      document.querySelectorAll('.tree-item.active').forEach(el => el.classList.remove('active'));
      itemDiv.classList.add('active');
    });
  } else {
    itemDiv.style.opacity = '0.5';
    itemDiv.style.cursor = 'default';
  }

  parent.appendChild(itemDiv);
}

async function openFileFromTree(fileHandle, filename, relativePath) {
  try {
    if (isModified) {
      if (!confirm('当前文件有未保存的更改，确定要打开新文件吗？')) return;
    }

    const file = await fileHandle.getFile();
    const content = await file.text();

    currentFileHandle = fileHandle;
    setCurrentDocumentContext({
      fileUrl: null,
      directoryPath: dirnameFromRelativePath(relativePath),
    });
    setEditorContent(content);
    updateFilename(filename);
    markSaved();
    await rememberCurrentDocument({ filename });
    showToast(`已打开: ${filename}`, 'success');
    hideOnboarding();
  } catch (err) {
    showToast('打开文件失败: ' + err.message, 'error');
  }
}

function toggleSidebar(forceState) {
  const sidebar = document.getElementById('fileSidebar');
  const toggleBtn = document.getElementById('sidebarToggle');

  if (forceState !== undefined) {
    isSidebarCollapsed = forceState;
  } else {
    isSidebarCollapsed = !isSidebarCollapsed;
  }

  localStorage.setItem('md-sidebar-collapsed', isSidebarCollapsed);
  sidebar.classList.toggle('collapsed', isSidebarCollapsed);

  if (toggleBtn) {
    toggleBtn.classList.toggle('visible', isSidebarCollapsed);
  }

  // 刷新编辑器布局
  if (editor) {
    requestAnimationFrame(() => editor.requestMeasure());
  }
}

function initFileSidebar() {
  // 打开文件夹
  document.getElementById('btnOpenFolder').addEventListener('click', handleOpenFolder);

  // 刷新：大纲视图 -> 刷新大纲；文件视图 -> 刷新文件树
  document.getElementById('btnRefreshTree').addEventListener('click', async () => {
    if (currentSidebarPanel === 'outline') {
      lastOutlineSignature = ''; // 强制重算
      refreshOutline();
      showToast('大纲已刷新', 'success');
      return;
    }
    if (directoryHandle) {
      fileTreeEntries = null;
      await renderFileTree({ rescan: true });
      showToast('文件树已刷新', 'success');
    } else {
      showToast('请先打开一个文件夹', 'error');
    }
  });

  // 眼镜：睁眼(显示全部) <-> 带斜线(只看可打开的文件)。
  // 只重渲染，不重新遍历目录 —— 大文件夹下避免每次切换都卡一下。
  const eyeBtn = document.getElementById('btnToggleUnopenable');
  if (eyeBtn) {
    eyeBtn.addEventListener('click', async () => {
      showUnopenable = !showUnopenable;
      localStorage.setItem('md-file-tree-show-unopenable', String(showUnopenable));
      updateEyeButtonVisibility();
      await renderFileTree();
    });
    updateEyeButtonVisibility(); // 初始态：没打开文件夹时隐藏
  }

  // 收起侧边栏
  document.getElementById('btnCollapseSidebar').addEventListener('click', () => toggleSidebar(true));

  // 大纲 / 文件 SegmentedControl
  document.querySelectorAll('#sidebarSegmented .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => setSidebarPanel(btn.dataset.sidebar));
  });

  // 鼠标进入左侧栏 / 键盘聚焦 -> 若有改动则刷新大纲（用户的意图驱动刷新策略）
  const sidebar = document.getElementById('fileSidebar');
  sidebar.addEventListener('mouseenter', refreshOutlineIfDirty);
  sidebar.addEventListener('focusin', refreshOutlineIfDirty);

  // 添加侧边栏展开的 toggle bar
  const editorMain = document.getElementById('editorMain');
  const toggleBtn = document.createElement('div');
  toggleBtn.className = 'sidebar-toggle';
  toggleBtn.id = 'sidebarToggle';
  toggleBtn.title = '展开文件浏览器';
  toggleBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9,6 15,12 9,18"/></svg>`;
  toggleBtn.addEventListener('click', () => toggleSidebar(false));
  editorMain.insertBefore(toggleBtn, editorMain.querySelector('.editor-panel'));

  // 恢复侧边栏状态
  if (isSidebarCollapsed) {
    toggleSidebar(true);
  }

  // 初始构建大纲（默认显示大纲视图）
  setSidebarPanel('outline');
  refreshOutlineIfDirty();
}
function init() {
  // Stamp version so we can confirm Chrome loaded the new package
  document.documentElement.dataset.appVersion = APP_VERSION;
  document.title = `Markdown Editor v${APP_VERSION}`;
  const verEl = document.getElementById('appVersion');
  if (verEl) verEl.textContent = `v${APP_VERSION}`;
  console.info(`[MD Editor] build v${APP_VERSION}`);

  // 恢复主题
  if (currentTheme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    mermaid.initialize({
      startOnLoad: false,
      theme: 'default',
      securityLevel: 'strict',
      fontFamily: 'sans-serif',
    });
  }
  updateThemeIcon();

  // 创建编辑器
  createEditor();

  // 绑定事件
  bindEvents();

  // 初始化分屏拖拽
  initResizer();

  // 初始化预览区交互（只读）
  initPreviewSelection();
  initEditorSelectionGuard();
  initPreviewLinkNavigation();

  // 初始化编辑区图片粘贴
  initPasteImageSupport();

  // 初始化文件浏览器侧边栏
  initFileSidebar();

  // 初始化反馈按钮
  initFeedbackButton();

  // 监听 onboarding 自定义事件
  document.addEventListener('onboarding:load-example', (e) => {
    setEditorContent(e.detail.content);
    updateFilename('示例文件.md');
    markSaved();
  });

  document.addEventListener('onboarding:open-folder', () => {
    handleOpenFolder();
  });

  // 显示新用户引导（无文件打开时）
  showOnboarding();

  // 恢复视图模式
  setViewMode(currentViewMode);

  // 检查是否有从 content script 传入的 pending file
  loadPendingFile();
}

// ==========================================
// 从 Chrome Storage 加载 pending file
// （用户拖拽 .md 文件到 Chrome 时触发）
// ==========================================
async function loadPendingFile() {
  // 在非扩展环境（dev server）中跳过 storage 读取，但仍尝试本地恢复不可用
  if (typeof chrome === 'undefined' || !chrome.storage) return;

  // 每个编辑器实例通过 URL 上的 ?i=<instanceId> 标识自己，
  // 以此读取「专属」的 pendingFile_<instanceId>，避免多个实例争用同一个键。
  const params = new URLSearchParams(window.location.search);
  const instanceId = params.get('i');
  const storageKey = pendingFileStorageKey(instanceId);

  try {
    const result = await chrome.storage.local.get(storageKey);
    const pendingFile = result[storageKey];

    if (!pendingFile) {
      // 没有刚拖入的文件时，恢复上次编辑内容（Issue #2）
      await tryRestoreLastDocument();
      return;
    }

    // 检查时间戳，超过 30 秒的视为过期
    if (Date.now() - pendingFile.timestamp > 30000) {
      await chrome.storage.local.remove(storageKey);
      await tryRestoreLastDocument();
      return;
    }

    setCurrentDocumentContext({
      fileUrl: pendingFile.sourceUrl || null,
      directoryPath: null,
    });
    // 加载文件内容到编辑器
    setEditorContent(pendingFile.content);
    updateFilename(pendingFile.filename);
    currentFileHandle = null; // file:// 打开无法获得 FileHandle
    markSaved();
    await rememberCurrentDocument({
      filename: pendingFile.filename,
      sourceUrl: pendingFile.sourceUrl || null,
    });
    showToast(`已打开: ${pendingFile.filename}`, 'success');
    hideOnboarding();

    // 清除 pending file
    await chrome.storage.local.remove(storageKey);
  } catch (err) {
    console.warn('加载 pending file 失败:', err);
    await tryRestoreLastDocument();
  }
}

// DOM Ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
