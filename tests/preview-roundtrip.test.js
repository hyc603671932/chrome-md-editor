import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { parseHTML } from 'linkedom';
import { htmlToMarkdown } from '../src/html-to-markdown.js';

const require = createRequire(import.meta.url);
const MarkdownIt = require('markdown-it');

// 预览区改成只读后，「整篇 previewContainer.innerHTML → Markdown」这条回写路径
// 只剩下「高亮」一个入口（editor.js applyPreviewHighlight → syncPreviewToEditor）。
// 这条链路仍然会全量往返，所以这里用真实 markdown-it 渲染出的 HTML 做集成校验，
// 锁定「点一次高亮不能把正文写坏」这条契约。
//
// markdown-it 配置必须与 editor.js:113-118 保持一致：
//   new MarkdownIt({ html: true, linkify: true, typographer: true, breaks: true })

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: true,
});

const MERMAID_SRC = [
  'sequenceDiagram',
  'autonumber',
  'actor You as You / Caller',
  'participant SS as StateSender',
  'participant Mdr as Mdr',
  'SS->>Mdr: sendCommandToDevice()',
].join('\n');

const SOURCE_DOC = [
  '# 流程说明',
  '',
  '这是一段**普通正文**，里面有 `行内代码` 和一个[链接](https://example.com)。',
  '',
  '## 交互时序',
  '',
  '```mermaid',
  MERMAID_SRC,
  '```',
  '',
  '## 参数表',
  '',
  '| 项目 | 值 | 说明 |',
  '|------|-----|------|',
  '| waitTimeMsec | 750 | 等 ACK |',
  '| sendFrameCountMax | 10 | 重发上限 |',
  '',
  '## 普通代码块',
  '',
  '```swift',
  'func send() {',
  '    ble.write(frame)',
  '}',
  '```',
  '',
  '## 列表',
  '',
  '- 第一项',
  '- 第二项',
  '- [x] 已完成的待办',
  '',
  '> 引用一句话。',
  '',
  '---',
  '',
  '结尾段落。',
  '',
].join('\n');

/**
 * 完整复刻「渲染 → mermaid 替换 → 高亮 → 回写」这条链路。
 * @param {string} markdown 源码
 * @param {{ highlight?: boolean }} [options] 是否模拟在正文插入 <mark>
 */
function roundTripPreview(markdown, { highlight = false } = {}) {
  const { document } = parseHTML(
    `<div id="previewContainer">${md.render(markdown)}</div>`
  );
  const root = document.getElementById('previewContainer');

  // 对应 editor.js doUpdatePreview()：把 ```mermaid 的 <pre> 换成图表 div
  for (const block of Array.from(root.querySelectorAll('code.language-mermaid'))) {
    const source = block.textContent;
    const div = document.createElement('div');
    div.className = 'mermaid-diagram';
    div.setAttribute('data-mermaid-source', source);
    div.innerHTML = '<svg><text>You</text></svg>';
    block.parentElement.replaceWith(div);
  }

  // 对应 editor.js applyPreviewHighlight()：把 <strong> 换成 <mark>
  if (highlight) {
    const strong = root.querySelector('p strong');
    if (strong) {
      const mark = document.createElement('mark');
      mark.textContent = strong.textContent;
      strong.replaceWith(mark);
    }
  }

  return htmlToMarkdown(root.innerHTML, { parseHTML });
}

test('整篇往返：核心结构全部保真', () => {
  const result = roundTripPreview(SOURCE_DOC);

  const expectations = [
    ['一级标题', '# 流程说明'],
    ['二级标题', '## 交互时序'],
    ['mermaid 围栏块', '```mermaid'],
    ['mermaid 源码行', 'SS->>Mdr: sendCommandToDevice()'],
    ['表格表头', '| 项目 | 值 | 说明 |'],
    ['表格分隔行', '| ------ | ------ | ------ |'],
    ['表格数据行', '| waitTimeMsec | 750 | 等 ACK |'],
    ['swift 代码围栏', '```swift'],
    ['swift 代码内容', 'func send() {'],
    ['swift 代码缩进', '    ble.write(frame)'],
    ['无序列表项', '- 第一项'],
    ['任务列表已完成项', '- [x] 已完成的待办'],
    ['引用', '> 引用一句话。'],
    ['分隔线', '---'],
    ['链接', '[链接](https://example.com)'],
    ['行内代码', '`行内代码`'],
    ['结尾段落', '结尾段落。'],
  ];

  for (const [name, needle] of expectations) {
    assert.ok(result.includes(needle), `往返后应保留「${name}」：${needle}`);
  }
});

test('整篇往返：mermaid 图表渲染产物不泄漏进源码', () => {
  const result = roundTripPreview(SOURCE_DOC);
  assert.ok(!result.includes('<svg'), 'SVG 标签不应写回源码');
  assert.ok(!result.includes('<text'), 'SVG 子元素不应写回源码');
});

test('高亮往返：插入 <mark> 后正文结构不被破坏', () => {
  const result = roundTripPreview(SOURCE_DOC, { highlight: true });

  assert.ok(result.includes('<mark>普通正文</mark>'), '高亮标记应写回源码');
  // 高亮只是局部改动，其余结构必须原样保留
  assert.ok(result.includes('```mermaid'), '高亮后不能弄丢 mermaid 块');
  assert.ok(
    result.includes('SS->>Mdr: sendCommandToDevice()'),
    '高亮后 mermaid 源码不能变'
  );
  assert.ok(result.includes('| waitTimeMsec | 750 | 等 ACK |'), '表格应保留');
  assert.ok(result.includes('```swift'), '代码围栏应保留');
  assert.ok(result.includes('func send() {'), '代码内容应保留');
  assert.ok(result.includes('> 引用一句话。'), '引用应保留');
  assert.ok(!result.includes('<svg'), '高亮回写不应把 SVG 带进源码');
});

test('高亮往返：源码里本来没有的内容不会被凭空造出来', () => {
  const result = roundTripPreview(SOURCE_DOC, { highlight: true });

  // markdown-it 渲染产物里的辅助属性不该出现在回写结果里
  assert.ok(!result.includes('data-mermaid-source'), '内部属性不应写回');
  assert.ok(!result.includes('language-mermaid'), '内部 class 不应写回');
  // typographer 会把引号/省略号做美化，这里确认没有引入 HTML 实体污染
  assert.ok(!/&[a-z]+;/i.test(result), '不应残留 HTML 实体');
});

// 已知缺陷（未修复，此处登记以便后续跟踪）：
// html-to-markdown.js 的 case 'ul' 只遍历直接子 LI，不处理嵌套 <ul>，
// 导致「- 第二项\n  - 子项 A」往返后被拍平成两级同级项。
// 只读化之后这条路径只有「高亮」会走，影响面已从「点一下预览区」收窄到「显式点高亮按钮」。
// 若后续改为「在源码侧定位文本直接加 <mark>」，此缺陷将连同整条往返一起消失。
test('已知缺陷登记：嵌套列表往返会丢失缩进层级', () => {
  const nested = '- 第一项\n- 第二项\n  - 子项 A\n';
  const result = roundTripPreview(nested);

  // 当前行为：子项被拍平到顶层（这里是缺陷的现象记录，不是期望值）
  assert.ok(result.includes('- 子项 A'), '子项文本仍在');
  assert.ok(
    !/^[ \t]+- 子项 A/m.test(result),
    '当前实现丢失了子项缩进——修复此用例时应同步改为断言缩进保留'
  );
});
