import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

import {
  findMarkAncestor,
  rangeFullyInsideMark,
  selectionInsideRoot,
  unwrapElement,
  locateSelectionInBlock,
  splitRenderedLines,
} from '../src/preview-format.js';

// linkedom Range is incomplete (no setStart) — test pure helpers + unwrap only.
// toggleMarkOnRange is exercised in the browser.

function setup(html) {
  const { document } = parseHTML(
    `<!DOCTYPE html><html><body><div id="root">${html}</div></body></html>`
  );
  return { document, root: document.getElementById('root') };
}

test('findMarkAncestor walks up to mark inside root', () => {
  const { root } = setup('<p>hello <mark id="m">world</mark></p>');
  const text = root.querySelector('#m').firstChild;
  assert.equal(findMarkAncestor(text, root)?.id, 'm');
  assert.equal(findMarkAncestor(root.querySelector('p'), root), null);
});

test('unwrapElement keeps text content', () => {
  const { root } = setup('<p><mark>x</mark></p>');
  unwrapElement(root.querySelector('mark'));
  assert.equal(root.querySelector('mark'), null);
  assert.equal(root.textContent, 'x');
});

test('rangeFullyInsideMark when start and end share one mark', () => {
  const { root } = setup('<p><mark id="m">ab</mark>cd</p>');
  const mark = root.querySelector('#m');
  const text = mark.firstChild;
  const range = {
    collapsed: false,
    startContainer: text,
    endContainer: text,
    commonAncestorContainer: mark,
  };
  assert.equal(rangeFullyInsideMark(range, root), mark);
});

test('rangeFullyInsideMark is null when selection leaves the mark', () => {
  const { root } = setup('<p><mark id="m">ab</mark>cd</p>');
  const mark = root.querySelector('#m');
  const p = root.querySelector('p');
  const range = {
    collapsed: false,
    startContainer: mark.firstChild,
    endContainer: p.lastChild,
    commonAncestorContainer: p,
  };
  assert.equal(rangeFullyInsideMark(range, root), null);
});

test('selectionInsideRoot rejects null / empty selection objects', () => {
  const { root } = setup('<p>ab</p>');
  assert.equal(selectionInsideRoot(null, root), false);
  assert.equal(
    selectionInsideRoot({ rangeCount: 0, isCollapsed: true }, root),
    false
  );
  assert.equal(
    selectionInsideRoot(
      {
        rangeCount: 1,
        isCollapsed: false,
        getRangeAt: () => ({
          commonAncestorContainer: root.querySelector('p'),
        }),
      },
      root
    ),
    true
  );
});

// ============================================================
// locateSelectionInBlock：预览区高亮精确定位
// ============================================================

// 构造整块源码行（from 为每行在文档中的起始偏移，模拟 CodeMirror line.from）
// 换行按 1 个字符计，与下面 join('\n') 的拼接方式一致，便于用整篇文档切片校验。
function blockEntries(lines) {
  let from = 0;
  return lines.map((text) => {
    const entry = { text, from };
    from += text.length + 1; // +1 模拟换行符
    return entry;
  });
}

// ============================================================
// locateSelectionInBlock：预览区高亮精确定位
// 关键场景：同一块内出现多次相同文字（旧逻辑要求全文唯一 → 必然失败）
// ============================================================

/** 在 renderedText 中直接给出选中文字的出现序号（occurrence），算出 selStart/selEnd */
function selectOccurrence(renderedText, sel, occurrence = 0) {
  let idx = -1;
  for (let i = 0; i <= occurrence; i++) {
    idx = renderedText.indexOf(sel, idx + 1);
    if (idx === -1) throw new Error(`not found: ${sel} #${i}`);
  }
  return { selStart: idx, selEnd: idx + sel.length };
}

/** 命中后校验：恒等映射下 from 必等于渲染偏移，且切出来的文本正好是选中文字 */
function assertHitAt(lines, sel, occurrence, label) {
  const entries = blockEntries(lines);
  const sourceText = lines.join('\n');
  const { selStart, selEnd } = selectOccurrence(sourceText, sel, occurrence);
  const m = locateSelectionInBlock({
    renderedText: sourceText,
    lineEntries: entries,
    selectedText: sel,
    selStart,
    selEnd,
  });
  assert.ok(m, `${label}: should locate`);
  assert.equal(m.mode, 'exact', `${label}: should use exact mapping`);
  assert.equal(m.from, selStart, `${label}: 恒等映射 → from === 渲染偏移`);
  assert.equal(sourceText.slice(m.from, m.to), sel, `${label}: hit text`);
  return m;
}

test('locateSelectionInBlock: 用户场景 —— 同块内 "123" 出现两次，分别精确命中', () => {
  // 源码（软换行，同属一个段落）：
  //   123445
  //   111
  //   123
  // "123" 在第 0 行开头和第 2 行各出现一次；旧的「全文唯一匹配」必然失败。
  const lines = ['123445', '111', '123'];

  // 选第 0 行 "123445" 里内嵌的前三位
  assertHitAt(lines, '123', 0, 'first-123');
  // 选第 2 行整行的 "123"（第二次出现）
  assertHitAt(lines, '123', 1, 'second-123');
  // 顺带确认第 2 行的落点确实是最后一行开头，而非第 0 行
  const second = selectOccurrence(lines.join('\n'), '123', 1);
  assert.equal(second.selStart, 11);
});

test('locateSelectionInBlock: 选中文字在段落第 2 行（非起始行）', () => {
  const lines = ['这是第一段，内容比较长，', '换了一行继续写。'];
  const m = assertHitAt(lines, '继续写', 0, 'second-line');
  // 第 0 行 12 字 + 换行 → 第 1 行起始偏移 13，'继续写' 在第 1 行内偏移 4
  assert.equal(m.from, 13 + 4);
});

test('locateSelectionInBlock: 跨软换行的选区也能精确命中', () => {
  const lines = ['123445', '111'];
  assertHitAt(lines, '445\n111', 0, 'span-softbreak');
});

test('locateSelectionInBlock: 渲染文本与源码不一致时按行就近匹配', () => {
  // 标题：渲染文本 "标题 123" vs 源码 "# 标题 123"，无法恒等映射 → 退化到按行就近
  const entries = blockEntries(['# 标题 123']);
  const m = locateSelectionInBlock({
    renderedText: '标题 123',
    lineEntries: entries,
    selectedText: '123',
    selStart: 3,
    selEnd: 6,
  });
  assert.ok(m);
  assert.equal(m.mode, 'nearest-line');
  assert.equal(entries[0].text.slice(m.from, m.to), '123');
});

test('locateSelectionInBlock: 行内多次出现时取离渲染偏移最近的一处', () => {
  // 源码含行内格式，渲染文本略短；同行出现两次 "abc"
  const entries = blockEntries(['**x** abc 中间 abc 末尾']);
  // 渲染文本假设为 "x abc 中间 abc 末尾"，选第 2 个 abc（偏移 10）
  const m = locateSelectionInBlock({
    renderedText: 'x abc 中间 abc 末尾',
    lineEntries: entries,
    selectedText: 'abc',
    selStart: 10,
    selEnd: 13,
  });
  assert.ok(m);
  assert.equal(entries[0].text.slice(m.from, m.to), 'abc');
  // 源码 '**x** abc 中间 abc 末尾' 中第二处 'abc' 起始于 13
  assert.equal(m.from, entries[0].text.indexOf('abc', 7), '应选第 2 处（离渲染偏移最近）');
});

test('locateSelectionInBlock: 完全找不到时返回 null', () => {
  const entries = blockEntries(['hello world']);
  assert.equal(
    locateSelectionInBlock({
      renderedText: 'hello world',
      lineEntries: entries,
      selectedText: 'xyz',
      selStart: 0,
      selEnd: 3,
    }),
    null
  );
});

test('locateSelectionInBlock: 空选区返回 null', () => {
  const entries = blockEntries(['hello world']);
  assert.equal(
    locateSelectionInBlock({
      renderedText: 'hello world',
      lineEntries: entries,
      selectedText: '',
      selStart: 0,
      selEnd: 0,
    }),
    null
  );
});

// ============================================================
// 行内格式内部的选区（加粗 / 斜体）
// 渲染文本 != 源码（源码多出 `**` / `*`），T1 恒等失效，走 T2 最近偏移。
// ============================================================

/** 发生在行内格式里的真实流程：renderedText 与源码不等，选区偏移按渲染文本算 */
function locateInFormatted(sourceLine, renderedText, sel, occurrence = 0) {
  const entries = blockEntries([sourceLine]);
  const { selStart, selEnd } = selectOccurrence(renderedText, sel, occurrence);
  const m = locateSelectionInBlock({
    renderedText,
    lineEntries: entries,
    selectedText: sel,
    selStart,
    selEnd,
  });
  return { m, selStart, selEnd, sourceText: sourceLine };
}

function countBefore(text, sel, pos) {
  let n = 0;
  let idx = text.indexOf(sel);
  while (idx !== -1 && idx < pos) {
    n++;
    idx = text.indexOf(sel, idx + 1);
  }
  return n;
}

test('locateSelectionInBlock: **加粗** 内部选段可定位（用户场景：上次编辑的正文和文件名）', () => {
  const src = '**上次编辑的正文和文件名**';
  const rendered = '上次编辑的正文和文件名';
  const { m, sourceText } = locateInFormatted(src, rendered, '正文');
  assert.ok(m, 'should locate inside <strong>');
  assert.equal(sourceText.slice(m.from, m.to), '正文');
  // 必须落在 ** 之内，而不是把标记字符一起吃掉
  assert.ok(m.from > 1, 'should be after the opening **');
  assert.ok(m.to < sourceText.length - 2, 'should be before the closing **');
});

test('locateSelectionInBlock: *斜体* 内部选段可定位（用户场景：这份示例本身就是 Markdown）', () => {
  const src = '*这份示例本身就是 Markdown，你可以随意改。*';
  const rendered = '这份示例本身就是 Markdown，你可以随意改。';
  const { m, sourceText } = locateInFormatted(src, rendered, '示例本身就是');
  assert.ok(m, 'should locate inside <em>');
  assert.equal(sourceText.slice(m.from, m.to), '示例本身就是');
});

test('locateSelectionInBlock: **abc abc** 选第二个 abc —— 渲染偏移过滤消歧', () => {
  const src = '**abc abc**';
  const rendered = 'abc abc';
  const { m, sourceText } = locateInFormatted(src, rendered, 'abc', 1);
  assert.ok(m, 'should locate despite both candidates being equally distant');
  assert.equal(sourceText.slice(m.from, m.to), 'abc');
  // 渲染偏移为 4，源码里 idx=2 的那处 < 4 应被过滤掉，只留下第二处
  assert.equal(countBefore(sourceText, 'abc', m.from), 1, 'should be the 2nd occurrence');
});

test('locateSelectionInBlock: 链接文字内部选段不会错位到 url 上', () => {
  const src = '见 [doc](http://doc.com) 说明';
  const rendered = '见 doc 说明';
  const { m, sourceText } = locateInFormatted(src, rendered, 'doc');
  assert.ok(m, 'should locate');
  assert.equal(sourceText.slice(m.from, m.to), 'doc');
  // 命中必须落在 [...] 的文字里，而不是后面 (http://doc.com) 的 url 里
  assert.ok(m.from < sourceText.indexOf(']('), 'should hit link text, not the url');
});

test('splitRenderedLines: 裁掉列表容器首尾空行', () => {
  assert.deepEqual(splitRenderedLines('\na\nb\n'), { lines: ['a', 'b'], offset: 1 });
  assert.deepEqual(splitRenderedLines('a\nb'), { lines: ['a', 'b'], offset: 0 });
  assert.deepEqual(splitRenderedLines('\n\nx\n'), { lines: ['x'], offset: 2 });
});
