// 文件树：可打开文件的判定与过滤。
// 抽成独立模块的收益：
// 1) 纯函数，可在 node 下单测（editor.js 顶层就有 DOM 副作用，import 不进来）
// 2) 把散落在 editor.js 三处的「哪些文件能打开」判定收敛到一处，避免口径漂移

/** 本编辑器能直接打开的扩展名。含 .txt —— 与文件树的历史行为一致 */
export const OPENABLE_EXTENSIONS = ['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'txt'];

const OPENABLE_RE = new RegExp(`\\.(${OPENABLE_EXTENSIONS.join('|')})$`, 'i');

/** 文件名是否是可直接打开的 Markdown / 文本文件 */
export function isOpenableFile(name) {
  return typeof name === 'string' && OPENABLE_RE.test(name);
}

/**
 * 自底向上剪枝：只保留「可打开的文件」，以及「后代里含可打开文件」的目录。
 * 剪完为空的目录整个丢弃 —— 不会留下点开什么都没有的空壳文件夹。
 *
 * @param {Array<{name:string, kind:string, children?:Array}>} entries
 * @returns {Array} 新树；不修改入参
 */
export function pruneNonOpenable(entries) {
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const entry of entries) {
    if (entry.kind === 'directory') {
      const children = pruneNonOpenable(entry.children);
      if (children.length > 0) out.push({ ...entry, children });
    } else if (isOpenableFile(entry.name)) {
      out.push(entry);
    }
  }
  return out;
}
