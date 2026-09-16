import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

import { htmlToMarkdown } from '../src/html-to-markdown.js';

// 预览区 WYSIWYG 回写（editor.js syncPreviewToEditor）会把整个 previewContainer.innerHTML
// 转成 Markdown 再整篇写回编辑器。doUpdatePreview 已把 ```mermaid 的 <pre> 替换成
// 图表 div（editor.js: pre.replaceWith），源码只存在于 data-mermaid-source 上。
// 这里锁定「点一下预览区，mermaid 源码不能没」这条契约。

const MERMAID_SRC = [
  'sequenceDiagram',
  'autonumber',
  'actor You as You / Caller',
  'participant SS as StateSender',
  'participant Mdr as Mdr',
].join('\n');

function roundTrip(html) {
  return htmlToMarkdown(html, { parseHTML });
}

test('mermaid 渲染成功：div.mermaid-diagram 还原为围栏代码块', () => {
  const html = `<h1>标题</h1>
<div class="mermaid-diagram" data-mermaid-source="${MERMAID_SRC}"><svg><text>You</text></svg></div>
<p>正文一段</p>`;

  const result = roundTrip(html);

  assert.ok(result.includes('```mermaid'), '应还原 mermaid 围栏块');
  for (const line of MERMAID_SRC.split('\n')) {
    assert.ok(result.includes(line), `源码行应保留: ${line}`);
  }
  // SVG 里的渲染产物不能被当成正文写回
  assert.ok(!result.includes('<svg'), '不应把 svg 标签写回源码');
});

test('mermaid 渲染失败：div.mermaid-error 同样保住源码', () => {
  const html = `<div class="mermaid-error" data-mermaid-source="${MERMAID_SRC}">Mermaid 渲染错误: xxx</div>`;

  const result = roundTrip(html);

  assert.ok(result.includes('```mermaid'), '渲染失败时也要还原围栏块');
  assert.ok(result.includes('sequenceDiagram'));
  assert.ok(
    !result.includes('Mermaid 渲染错误'),
    '错误提示文案不应进源码'
  );
});

test('普通 div 未挂属性时仍走原逻辑（取子文本）', () => {
  const result = roundTrip('<div><p>普通内容</p></div>');
  assert.equal(result, '普通内容\n');
});

test('无 mermaid 的文档回写结果不受改动影响', () => {
  const html = '<h1>标题</h1><p>第一段</p><p>第二段</p>';
  assert.equal(roundTrip(html), '# 标题\n\n第一段\n\n第二段\n');
});

test('预览里删掉图表后，源码块也一并移除（用户主动删除）', () => {
  const html = '<h1>标题</h1><p>正文</p>';
  const result = roundTrip(html);
  assert.ok(!result.includes('mermaid'), '图表被删除后不应残留 mermaid 块');
});

test('一篇文章里多个 mermaid 块都能各自还原', () => {
  const a = 'graph LR\n  A[开始] --> B[结束]';
  const b = 'graph TD\n  X --> Y';
  const html =
    `<p>开头</p>` +
    `<div class="mermaid-diagram" data-mermaid-source="${a}"><svg></svg></div>` +
    `<p>中间</p>` +
    `<div class="mermaid-diagram" data-mermaid-source="${b}"><svg></svg></div>` +
    `<p>结尾</p>`;

  const result = roundTrip(html);

  assert.equal(result.match(/```mermaid/g).length, 2, '应有 2 个围栏块');
  assert.ok(result.includes('A[开始] --> B[结束]'));
  assert.ok(result.includes('X --> Y'));
});
