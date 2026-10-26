/**
 * strength 强化语义验收。在 .tmp 下复制一份插件与数据，不碰真实存储。
 *
 *   1. 新记忆初始强度 = 0.6
 *   2. 一个半衰期后被取用：1 × 0.5 + 0.2 = 0.7（而不是回到 1）
 *   3. 自动注入不增加强度，也不计取用次数
 *   4. 旧库（facts 表没有 strength 列）中新保存仍为 0.6
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const requireNode = createRequire(import.meta.url);
const SRC = process.cwd();
const ROOT = join(SRC, '.tmp', 'strength');
const FILES = ['index.js', 'client.js', 'coordinator.mjs', 'migrate-core.mjs', 'cordis.patch.yml'];

rmSync(ROOT, { recursive: true, force: true });

function makePlugin(name, dataDir) {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  for (const file of FILES) copyFileSync(join(SRC, file), join(dir, file));
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dir, 'storage.json'), `${JSON.stringify({ dir: dataDir }, null, 2)}\n`, 'utf8');
  return dir;
}

function stubCtx() {
  const tools = [];
  const sections = [];
  const disposer = () => {};
  const ctx = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'effect') return (fn) => { const d = fn(); return () => (typeof d === 'function' ? d() : undefined); };
      if (prop === 'tools') return { register: (tool) => { tools.push(tool); return disposer; } };
      if (prop === 'systemPrompt') return { section: (opts) => { sections.push(opts); return disposer; } };
      if (prop === 'webServer') return { register: () => disposer };
      if (prop === 'get') return () => undefined;
      if (prop === 'on') return () => disposer;
      if (prop === 'agents') return { currentInitiator: () => null, list: () => [] };
      return undefined;
    },
  });
  return { ctx, tools, sections };
}

async function load(dir, tag) {
  const stub = stubCtx();
  const mod = await import(`file:///${dir}/index.js?${tag}`);
  mod.apply(stub.ctx);
  await new Promise((r) => setTimeout(r, 400));
  return { mod, tool: stub.tools[0], section: stub.sections[0] };
}

function readFact(dataDir, key) {
  const { DatabaseSync } = requireNode('node:sqlite');
  const db = new DatabaseSync(join(dataDir, 'index.db'));
  try {
    return db.prepare('SELECT id, strength, use_count, last_used_at FROM facts WHERE key = ?').all(key)[0];
  } finally {
    db.close();
  }
}

const results = [];
async function scenario(name, fn) {
  try { const detail = await fn(); results.push({ name, ok: true }); console.log(`PASS  ${name}  ${detail ?? ''}`); }
  catch (error) { results.push({ name, ok: false, detail: error.message }); console.log(`FAIL  ${name}: ${error.message}`); }
}

// 旧库：facts 表没有 strength 列（老版本建的）
function makeLegacyData(dir) {
  mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = requireNode('node:sqlite');
  const db = new DatabaseSync(join(dir, 'index.db'));
  db.exec(`CREATE TABLE facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, key TEXT, content TEXT NOT NULL,
    importance INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
    use_count INTEGER NOT NULL DEFAULT 0, last_used_at TEXT, superseded_by INTEGER,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.exec("INSERT INTO facts (kind, key, content, created_at, updated_at) VALUES ('fact', 'legacy', '旧库里的记忆', '2026-01-01 00:00:00', '2026-01-01 00:00:00')");
  db.close();
}

const dataA = join(ROOT, 'data-a');
const pluginA = makePlugin('plugin-a', dataA);
const a = await load(pluginA, 'a');
assert.ok(a.tool, 'memory tool was not registered');

await scenario('1 新记忆初始强度 = 0.6', async () => {
  const res = await a.tool.execute({ action: 'save', kind: 'fact', key: 'k1', content: '强度测试记忆一号', scope: 'global' });
  assert.equal(res.ok, true, res.detail);
  const row = readFact(dataA, 'k1');
  assert.equal(Number(row.strength), 0.6, `strength=${row.strength}`);
  return `#${row.id} strength=0.6`;
});

await scenario('2 半衰期后取用 = 0.7（不是回到 1）', async () => {
  // 构造"强度 1、整整一个半衰期没用"的状态
  const halfLifeAgo = new Date(Date.now() - 60 * 86_400_000);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${halfLifeAgo.getFullYear()}-${pad(halfLifeAgo.getMonth() + 1)}-${pad(halfLifeAgo.getDate())} `
    + `${pad(halfLifeAgo.getHours())}:${pad(halfLifeAgo.getMinutes())}:${pad(halfLifeAgo.getSeconds())}`;
  const { DatabaseSync } = requireNode('node:sqlite');
  const db = new DatabaseSync(join(dataA, 'index.db'));
  db.prepare("UPDATE facts SET strength = 1, last_used_at = ?, use_count = 0 WHERE key = 'k1'").run(stamp);
  db.close();

  const res = await a.tool.execute({ action: 'recall', query: '强度测试记忆', scope: 'global' });
  assert.match(String(res.detail), /强度测试记忆/, 'recall missed the fact');
  const row = readFact(dataA, 'k1');
  const strength = Number(row.strength);
  assert.ok(Math.abs(strength - 0.7) < 0.02, `strength=${strength}（期望 0.7）`);
  assert.equal(Number(row.use_count), 1, `use_count=${row.use_count}`);
  return `strength=${strength.toFixed(3)} use_count=1`;
});

await scenario('3 自动注入不增加强度、不计取用', async () => {
  const before = readFact(dataA, 'k1');
  assert.ok(a.section, 'prompt section was not registered');
  const text = String(a.section.text());
  assert.ok(text.length > 0, 'prompt section rendered empty');
  const after = readFact(dataA, 'k1');
  assert.equal(Number(after.strength), Number(before.strength), 'injection changed strength');
  assert.equal(Number(after.use_count), Number(before.use_count), 'injection counted as a use');
  assert.equal(after.last_used_at, before.last_used_at, 'injection touched last_used_at');
  return `注入后 strength=${Number(after.strength).toFixed(3)} 未变`;
});

await scenario('4 旧库中新保存仍为 0.6', async () => {
  const dataB = join(ROOT, 'data-b');
  makeLegacyData(dataB);
  const pluginB = makePlugin('plugin-b', dataB);
  const b = await load(pluginB, 'b');
  const res = await b.tool.execute({ action: 'save', kind: 'fact', key: 'k2', content: '旧库新记忆', scope: 'global' });
  assert.equal(res.ok, true, res.detail);
  const row = readFact(dataB, 'k2');
  assert.equal(Number(row.strength), 0.6, `strength=${row.strength}`);
  const legacy = readFact(dataB, 'legacy');
  assert.equal(Number(legacy.strength), 1, '旧记忆不应被统一重置');
  return `新行 0.6，旧行仍为 ${Number(legacy.strength)}`;
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过（strength 验收）`);
if (failed.length) process.exitCode = 1;
