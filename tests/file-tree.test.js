import test from 'node:test';
import assert from 'node:assert/strict';

import { isOpenableFile, pruneNonOpenable, OPENABLE_EXTENSIONS } from '../src/file-tree.js';

// —— 造树的辅助：用紧凑字面量描述，避免每个用例都写一坨嵌套对象 ——
function dir(name, path, children = []) {
  return { name, kind: 'directory', path, children };
}
function file(name, path) {
  return { name, kind: 'file', path };
}

/** 把树压平成 "path" 列表，便于整体断言 */
function paths(entries) {
  const out = [];
  const walk = (list) => {
    for (const e of list) {
      out.push(e.path);
      if (e.kind === 'directory') walk(e.children || []);
    }
  };
  walk(entries);
  return out;
}

test('isOpenableFile: 认 md / markdown / mdown / mkd / mkdn / txt', () => {
  for (const ext of OPENABLE_EXTENSIONS) {
    assert.ok(isOpenableFile(`note.${ext}`), `${ext} should be openable`);
  }
});

test('isOpenableFile: 大小写不敏感', () => {
  assert.ok(isOpenableFile('README.MD'));
  assert.ok(isOpenableFile('README.Markdown'));
});

test('isOpenableFile: 拒绝图片 / 代码 / 无扩展名', () => {
  assert.equal(isOpenableFile('logo.png'), false);
  assert.equal(isOpenableFile('style.css'), false);
  assert.equal(isOpenableFile('main.js'), false);
  assert.equal(isOpenableFile('Makefile'), false);
});

test('isOpenableFile: 不会把「扩展名只是子串」的文件误判为可打开', () => {
  // 'md' 出现在名字里但不是扩展名
  assert.equal(isOpenableFile('md'), false);
  assert.equal(isOpenableFile('cmd'), false);
  assert.equal(isOpenableFile('archive.tar.gz'), false);
});

test('pruneNonOpenable: 丢掉不可打开的文件', () => {
  const tree = [file('a.md', 'a.md'), file('logo.png', 'logo.png')];
  assert.deepEqual(paths(pruneNonOpenable(tree)), ['a.md']);
});

test('pruneNonOpenable: 保留「后代含可打开文件」的目录', () => {
  const tree = [
    dir('docs', 'docs', [file('readme.md', 'docs/readme.md'), file('a.png', 'docs/a.png')]),
  ];
  const out = pruneNonOpenable(tree);
  assert.deepEqual(paths(out), ['docs', 'docs/readme.md']);
  // 目录里的不可打开文件也一并剪掉
  assert.deepEqual(out[0].children.map((c) => c.name), ['readme.md']);
});

test('pruneNonOpenable: 一个可打开文件都没有的目录整个消失（不留空壳）', () => {
  const tree = [
    dir('assets', 'assets', [file('logo.png', 'assets/logo.png')]),
    file('readme.md', 'readme.md'),
  ];
  assert.deepEqual(paths(pruneNonOpenable(tree)), ['readme.md']);
});

test('pruneNonOpenable: 递归剪枝 —— 深层全不可打开时，整条祖先链一起消失', () => {
  // a/b/c 三层，只有最深处是图片 → a、b、c 全都不该留下
  const tree = [
    dir('a', 'a', [dir('b', 'a/b', [dir('c', 'a/b/c', [file('x.png', 'a/b/c/x.png')])])]),
  ];
  assert.deepEqual(pruneNonOpenable(tree), []);
});

test('pruneNonOpenable: 深层有一个 md → 整条祖先链保留', () => {
  const tree = [
    dir('a', 'a', [dir('b', 'a/b', [dir('c', 'a/b/c', [file('x.md', 'a/b/c/x.md')])])]),
  ];
  assert.deepEqual(paths(pruneNonOpenable(tree)), ['a', 'a/b', 'a/b/c', 'a/b/c/x.md']);
});

test('pruneNonOpenable: 混合场景 —— 只保留有 md 的分支', () => {
  const tree = [
    dir('docs', 'docs', [
      dir('guide', 'docs/guide', [file('intro.md', 'docs/guide/intro.md')]),
      dir('img', 'docs/img', [file('a.png', 'docs/img/a.png')]),
    ]),
    dir('build', 'build', [file('out.js', 'build/out.js')]),
    file('readme.md', 'readme.md'),
    file('logo.png', 'logo.png'),
  ];
  assert.deepEqual(paths(pruneNonOpenable(tree)), [
    'docs',
    'docs/guide',
    'docs/guide/intro.md',
    'readme.md',
  ]);
});

test('pruneNonOpenable: 不修改入参', () => {
  const tree = [dir('x', 'x', [file('a.png', 'x/a.png')])];
  const snapshot = JSON.parse(JSON.stringify(tree));
  pruneNonOpenable(tree);
  assert.deepEqual(tree, snapshot);
});

test('pruneNonOpenable: 空输入 / 非法输入不炸', () => {
  assert.deepEqual(pruneNonOpenable([]), []);
  assert.deepEqual(pruneNonOpenable(undefined), []);
});
