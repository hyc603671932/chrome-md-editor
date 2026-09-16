// Preview selection formatting (WYSIWYG).
// Apply styles on the rendered pane, then host syncs HTML → Markdown.

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/**
 * @param {Node} node
 * @param {Element} root
 * @returns {HTMLElement | null}
 */
export function findMarkAncestor(node, root) {
  let n = node && node.nodeType === TEXT_NODE ? node.parentElement : node;
  while (n && n !== root) {
    if (n.nodeType === ELEMENT_NODE && n.tagName.toLowerCase() === 'mark') {
      return n;
    }
    n = n.parentElement;
  }
  return null;
}

/**
 * If the whole selection lives in one <mark>, return that mark (for toggle-off).
 * @param {Range} range
 * @param {Element} root
 */
export function rangeFullyInsideMark(range, root) {
  if (!range || range.collapsed) return null;
  const startMark = findMarkAncestor(range.startContainer, root);
  const endMark = findMarkAncestor(range.endContainer, root);
  if (startMark && startMark === endMark) return startMark;
  return null;
}

/**
 * Whether selection is non-empty and entirely inside root.
 * @param {Selection | null} selection
 * @param {Element} root
 */
export function selectionInsideRoot(selection, root) {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return false;
  return true;
}

/**
 * Wrap range contents in <mark>, or unwrap if already fully inside one mark.
 * Mutates the DOM. Returns 'wrapped' | 'unwrapped' | 'noop'.
 * @param {Range} range
 * @param {Element} root
 * @param {{ createElement?: (tag: string) => HTMLElement }} [dom]
 */
export function toggleMarkOnRange(range, root, dom = {}) {
  if (!range || range.collapsed) return 'noop';
  if (!root.contains(range.commonAncestorContainer)) return 'noop';

  const existing = rangeFullyInsideMark(range, root);
  if (existing) {
    unwrapElement(existing);
    return 'unwrapped';
  }

  const createElement =
    dom.createElement || ((tag) => document.createElement(tag));
  const mark = createElement('mark');

  try {
    range.surroundContents(mark);
  } catch {
    // Selection crosses element boundaries — extract and re-insert.
    const frag = range.extractContents();
    mark.appendChild(frag);
    range.insertNode(mark);
  }

  // Collapse caret after the mark for less sticky selection noise
  try {
    range.setStartAfter(mark);
    range.collapse(true);
  } catch {
    /* ignore */
  }

  return 'wrapped';
}

/**
 * Replace element with its children.
 * @param {HTMLElement} el
 */
export function unwrapElement(el) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) {
    parent.insertBefore(el.firstChild, el);
  }
  parent.removeChild(el);
  parent.normalize?.();
}

/**
 * 把渲染文本按行拆分，并裁掉列表类容器（<ul>/<ol>）因标签换行产生的前后空行。
 * 例：<ul><li>a</li><li>b</li></ul> 的 textContent 为 "\na\nb\n"，
 * 裁掉首尾空行后得到 ["a", "b"]，恰好与源码两行一一对应。
 *
 * @param {string} renderedText
 * @returns {{ lines: string[], offset: number }} offset 为被裁掉的前导空行消耗的字符数
 */
export function splitRenderedLines(renderedText) {
  const raw = renderedText.split('\n');
  let lead = 0;
  while (lead < raw.length && raw[lead] === '') lead++;
  let tail = raw.length;
  while (tail > lead && raw[tail - 1] === '') tail--;
  return { lines: raw.slice(lead, tail), offset: lead };
}

/**
 * 精确定位「预览区选区」在源码中的位置。
 *
 * 背景：旧实现是在整块源码里搜「选中文字的唯一出现」，一旦同块出现多次就失败。
 * 典型反例：源码 `123445 / 111 / 123`（软换行，同属一个段落）里选 `123`
 * 会命中两处 → 报「块内匹配不唯一」。要求用户保证全文唯一是不现实的。
 *
 * 这里改成以「选区在渲染文本中的字符偏移」为主信号，三级定位：
 *   T1 exact        —— 渲染文本与源码逐字符相等（纯文本段落，最常见），偏移恒等映射，零歧义
 *   T2 nearest-line —— 渲染行与源码行能一一对齐时，只在对应源码行内挑离渲染偏移最近的一处
 *   T3 nearest-block—— 无法逐行对齐（表格等）时，在整块内挑最近的一处
 * 只有「最近的两处距离完全相同」才判失败（真·无法判定）。
 *
 * @param {object} input
 * @param {string} input.renderedText 块元素的 textContent
 * @param {Array<{ text: string, from: number }>} input.lineEntries 块覆盖的源码行，from 为该行在文档中的起始偏移
 * @param {string} input.selectedText 预览区选中的文字
 * @param {number} input.selStart 选区在 renderedText 中的起始偏移
 * @param {number} input.selEnd 选区在 renderedText 中的结束偏移
 * @returns {{ from: number, to: number, mode: 'exact' | 'nearest-line' | 'nearest-block' } | null}
 */
export function locateSelectionInBlock({
  renderedText,
  lineEntries,
  selectedText,
  selStart,
  selEnd,
}) {
  if (!selectedText || !lineEntries || lineEntries.length === 0) return null;

  // T1：渲染文本与源码逐字符一致 → 偏移恒等映射，无需任何唯一性假设
  const sourceText = lineEntries.map((l) => l.text).join('\n');
  if (renderedText === sourceText) {
    if (sourceText.slice(selStart, selEnd) === selectedText) {
      const base = lineEntries[0].from;
      return { from: base + selStart, to: base + selEnd, mode: 'exact' };
    }
  }

  // T2：逐行对齐 → 定位到唯一一行，行内按最近偏移挑选
  const { lines: renderedLines, offset: renderedOffset } = splitRenderedLines(renderedText);
  let targetLine = -1;
  let offsetInLine = 0;
  if (renderedLines.length === lineEntries.length && !selectedText.includes('\n')) {
    const adjustedStart = selStart - renderedOffset;
    let lineStart = 0;
    for (let i = 0; i < renderedLines.length; i++) {
      const lineEnd = lineStart + renderedLines[i].length;
      if (adjustedStart >= lineStart && selEnd - renderedOffset <= lineEnd) {
        targetLine = i;
        offsetInLine = adjustedStart - lineStart;
        break;
      }
      lineStart = lineEnd + 1; // +1 为换行符
    }
  }

  // T3（targetLine === -1 时）：整块扫描
  const scanFrom = targetLine === -1 ? 0 : targetLine;
  const scanTo = targetLine === -1 ? lineEntries.length : targetLine + 1;
  const base = lineEntries[0].from;
  const candidates = [];
  for (let i = scanFrom; i < scanTo; i++) {
    const { text, from } = lineEntries[i];
    let idx = text.indexOf(selectedText);
    while (idx !== -1) {
      const distance =
        targetLine === -1
          ? Math.abs(from - base - selStart)
          : Math.abs(idx - offsetInLine);
      // 源码比渲染文本多出的只会是标记字符（`**`、`*`、标题的 `#`、链接的 `](url)` 等），
      // 它们只会把源码位置往右推 —— 因此命中位置不可能小于渲染偏移。
      // 用它过滤掉「明显太靠前」的候选，消除块内含格式时的并列歧义：
      // 例 `**abc abc**` 选第二个 abc，渲染偏移 4，源码里候选 idx=2 与 idx=6 原本同距并列，
      // 过滤掉 idx=2（< 4）后只剩正确答案。
      const plausible =
        targetLine === -1 ? from - base >= selStart : idx >= offsetInLine;
      candidates.push({
        from: from + idx,
        to: from + idx + selectedText.length,
        distance,
        plausible,
      });
      idx = text.indexOf(selectedText, idx + 1);
    }
  }
  if (candidates.length === 0) return null;
  // 过滤后为空则退回全集，保证不会比改动前更容易失败
  const plausible = candidates.filter((c) => c.plausible);
  const pool = plausible.length > 0 ? plausible : candidates;
  pool.sort((a, b) => a.distance - b.distance);
  if (pool.length > 1 && pool[0].distance === pool[1].distance) {
    return null; // 两处同样接近，无法判定
  }
  return {
    from: pool[0].from,
    to: pool[0].to,
    mode: targetLine === -1 ? 'nearest-block' : 'nearest-line',
  };
}
