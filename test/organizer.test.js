const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { CATEGORIES, classify, moveExclusive, Organizer } = require('../organizer');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sort-tidy-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test('extensions are unique, case insensitive, and mapped to their category', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'sample'); await fs.writeFile(file, 'test');
  const stats = await fs.lstat(file); const seen = new Set();
  for (const [category, extensions] of Object.entries(CATEGORIES)) for (const ext of extensions) {
    assert.ok(!seen.has(ext), `Duplicate extension ${ext}`); seen.add(ext);
    assert.equal(classify(`sample.${ext.toUpperCase()}`, stats), category);
  }
  for (const [name, expected] of Object.entries({
    'report.XLSM': 'Documents', 'photo.CR3': 'Images', 'voice.OPUS': 'Audio',
    'clip.MTS': 'Video', 'archive.ZST': 'Compressed', 'setup.MSIX': 'Apps',
    'comic.CBZ': 'Ebooks', 'script.PY': 'Code', 'records.PARQUET': 'Data',
    'drawing.SKETCH': 'Design', 'scene.GLB': '3D & CAD', 'font.WOFF2': 'Fonts',
    'captions.SRT': 'Subtitles', 'disk.ISO': 'Disk Images',
  })) assert.equal(classify(name, stats), expected);
  assert.equal(classify('video.ts', stats), 'Code');
  assert.equal(classify('model.obj', stats), '3D & CAD');
  assert.equal(classify('unknown.xyz', stats), 'Others');
  assert.equal(classify('README', stats), 'Others');
  assert.equal(classify('file.part', stats), null);
  assert.equal(classify('.hidden.pdf', stats), null);
});
test('package directories are recognized and ordinary directories and symlinks skipped', async t => {
  const root = await fixture(t); const stats = await fs.lstat(root);
  for (const ext of ['pages', 'numbers', 'key']) assert.equal(classify(`Doc.${ext}`, stats), 'Documents');
  assert.equal(classify('App.app', stats), 'Apps'); assert.equal(classify('folder', stats), null);
  await fs.symlink(root, path.join(root, 'link.pdf'));
  assert.equal(classify('link.pdf', await fs.lstat(path.join(root, 'link.pdf'))), null);
});
test('concurrent same-name moves never overwrite destinations', async t => {
  const root = await fixture(t); const a = path.join(root, 'a.txt'), b = path.join(root, 'b.txt');
  await fs.writeFile(a, 'a'); await fs.writeFile(b, 'b');
  const dst = path.join(root, 'result.txt'); await fs.writeFile(dst, 'original');
  await Promise.all([moveExclusive(a, dst, await fs.lstat(a)), moveExclusive(b, dst, await fs.lstat(b))]);
  assert.equal(await fs.readFile(dst, 'utf8'), 'original');
  const copies = await Promise.all([1, 2].map(n => fs.readFile(path.join(root, `result (${n}).txt`), 'utf8')));
  assert.deepEqual(copies.sort(), ['a', 'b']);
});
test('stop cancels scan between moves and preserves remaining sources', async t => {
  const root = await fixture(t);
  for (const name of ['a.txt', 'b.txt', 'c.txt']) await fs.writeFile(path.join(root, name), name);
  let stopped; const worker = new Organizer(root, message => { if (message.startsWith('Moved')) stopped = worker.stop(); });
  await worker.scan(); await stopped;
  assert.equal((await fs.readdir(path.join(root, 'Documents'))).length, 1);
  assert.equal((await fs.readdir(root)).filter(name => name.endsWith('.txt')).length, 2);
});
test('Others cleanup is opt-in, preserves unknowns, and moves packages', async t => {
  const root = await fixture(t); const others = path.join(root, 'Others'); await fs.mkdir(others);
  await fs.writeFile(path.join(others, 'note.md'), 'note'); await fs.writeFile(path.join(others, 'unknown.xyz'), '?');
  await fs.mkdir(path.join(root, 'Book.pages')); await fs.writeFile(path.join(root, 'Book.pages', 'content'), 'book');
  await new Organizer(root).scan(); assert.equal(await fs.readFile(path.join(others, 'note.md'), 'utf8'), 'note');
  await new Organizer(root).scan(true);
  assert.equal(await fs.readFile(path.join(root, 'Documents', 'note.md'), 'utf8'), 'note');
  assert.equal(await fs.readFile(path.join(root, 'Documents', 'Book.pages', 'content'), 'utf8'), 'book');
  assert.deepEqual(await fs.readdir(others), ['unknown.xyz']);
});
test('category symlink cannot redirect sorting outside root', async t => {
  const root = await fixture(t); const outside = await fixture(t);
  await fs.symlink(outside, path.join(root, 'Documents')); await fs.writeFile(path.join(root, 'note.txt'), 'note');
  await new Organizer(root).scan(); assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(await fs.readFile(path.join(root, 'note.txt'), 'utf8'), 'note');
});
test('copy fallback preserves collisions and cancellation preserves source', async t => {
  const root = await fixture(t); const source = path.join(root, 'source.txt'), dst = path.join(root, 'copy.txt');
  await fs.writeFile(source, 'source'); await fs.writeFile(dst, 'existing');
  const original = fs.link; fs.link = async () => { const error = new Error('cross device'); error.code = 'EXDEV'; throw error; };
  try {
    await moveExclusive(source, dst, await fs.lstat(source));
    assert.equal(await fs.readFile(dst, 'utf8'), 'existing');
    assert.equal(await fs.readFile(path.join(root, 'copy (1).txt'), 'utf8'), 'source');
    await fs.writeFile(source, 'still here');
    let checks = 0;
    assert.equal(await moveExclusive(source, path.join(root, 'cancel.txt'), await fs.lstat(source), () => ++checks > 1), null);
    assert.equal(await fs.readFile(source, 'utf8'), 'still here');
    await assert.rejects(fs.stat(path.join(root, 'cancel.txt')), { code: 'ENOENT' });
  } finally { fs.link = original; }
});
test('locked moves retry and retain source if every attempt fails', async t => {
  const root = await fixture(t); const source = path.join(root, 'locked.txt'); await fs.writeFile(source, 'important');
  const original = fs.link; let attempts = 0;
  fs.link = async () => { attempts++; const error = new Error('locked'); error.code = 'EBUSY'; throw error; };
  const logs = [];
  try {
    await new Organizer(root, message => logs.push(message)).scan();
    assert.equal(attempts, 5);
    assert.equal(await fs.readFile(source, 'utf8'), 'important');
    assert.ok(logs.some(message => message.includes('locked')));
  } finally { fs.link = original; }
});
test('failed package copy cleans only reserved destination and retains source', async t => {
  const root = await fixture(t); const source = path.join(root, 'Doc.pages'); await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'content'), 'important');
  const original = fs.cp; const rename = fs.rename;
  fs.rename = async () => { const error = new Error('cross device'); error.code = 'EXDEV'; throw error; };
  fs.cp = async () => { throw new Error('copy failed'); };
  try {
    await new Organizer(root).scan();
    assert.equal(await fs.readFile(path.join(source, 'content'), 'utf8'), 'important');
    assert.deepEqual(await fs.readdir(path.join(root, 'Documents')), []);
  } finally { fs.cp = original; fs.rename = rename; }
});
test('watcher backlog defers overflow without sorting pre-existing files', async t => {
  const root = await fixture(t); const worker = new Organizer(root);
  for (let i = 0; i < 520; i++) await fs.writeFile(path.join(root, `${i}.txt`), String(i));
  await fs.writeFile(path.join(root, 'untouched.md'), 'existing');
  for (let i = 0; i < 520; i++) worker.enqueue(path.join(root, `${i}.txt`));
  assert.ok(worker.pending.size <= 512);
  // Only paths received from the watcher should be processed.
  for (let i = 0; i < 200; i++) {
    if ((await fs.readdir(path.join(root, 'Documents')).catch(() => [])).length === 520) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await worker.stop();
  assert.equal((await fs.readdir(path.join(root, 'Documents'))).length, 520);
  assert.equal(await fs.readFile(path.join(root, 'untouched.md'), 'utf8'), 'existing');
});

test('a package changed during copying is retained at its source', async t => {
  const root = await fixture(t); const source = path.join(root, 'Doc.pages'); await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'content'), 'initial');
  const original = fs.cp; const rename = fs.rename;
  fs.rename = async () => { const error = new Error('cross device'); error.code = 'EXDEV'; throw error; };
  fs.cp = async (...args) => {
    await original(...args);
    await fs.writeFile(path.join(source, 'new-content'), 'arrived during copy');
  };
  const logs = [];
  try {
    await new Organizer(root, message => logs.push(message)).scan();
    assert.equal(await fs.readFile(path.join(source, 'new-content'), 'utf8'), 'arrived during copy');
    assert.deepEqual(await fs.readdir(path.join(root, 'Documents')), []);
    assert.ok(logs.some(message => message.includes('Source changed')));
  } finally { fs.cp = original; fs.rename = rename; }
});
test('failed source deletion retains both files without retrying extra copies', async t => {
  const root = await fixture(t); const source = path.join(root, 'locked.txt'); await fs.writeFile(source, 'important');
  const original = fs.rm;
  fs.rm = async (entry, ...args) => {
    if (entry === source) { const error = new Error('locked source'); error.code = 'EBUSY'; throw error; }
    return original(entry, ...args);
  };
  try {
    await new Organizer(root).scan();
    assert.deepEqual(await fs.readdir(path.join(root, 'Documents')), ['locked.txt']);
    assert.equal(await fs.readFile(source, 'utf8'), 'important');
  } finally { fs.rm = original; }
});

test('cross-volume file modified during copying is not deleted', async t => {
  const root = await fixture(t); const source = path.join(root, 'note.txt'); await fs.writeFile(source, 'initial');
  const link = fs.link, copyFile = fs.copyFile;
  fs.link = async () => { const error = new Error('cross device'); error.code = 'EXDEV'; throw error; };
  fs.copyFile = async (...args) => {
    await copyFile(...args);
    await fs.appendFile(source, ' newer content');
  };
  try {
    await new Organizer(root).scan();
    assert.equal(await fs.readFile(source, 'utf8'), 'initial newer content');
    assert.deepEqual(await fs.readdir(path.join(root, 'Documents')), []);
  } finally { fs.link = link; fs.copyFile = copyFile; }
});
