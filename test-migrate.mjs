/**
 * Independent migration tests. Run with:
 *   node test-migrate.mjs
 *
 * Each scenario gets its own fixture copied from _migtest/data-a so nothing
 * touches the live storage or the shared test copy.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dbSignature, readJournal, recoverMigration, runMigration } from './migrate-core.mjs';

const requireNode = createRequire(import.meta.url);
const ROOT = 'D:/Deepseek_work/dsh-memory/_migtest';
const SOURCE = join(ROOT, 'data-a');
const results = [];

function fixture(name) {
  const base = join(ROOT, 'runs', name);
  rmSync(base, { recursive: true, force: true });
  mkdirSync(base, { recursive: true });
  const from = join(base, 'from');
  cpSync(SOURCE, from, { recursive: true });
  return {
    base,
    from,
    to: join(base, 'to'),
    journal: join(base, 'migration.json'),
    pointer: join(base, 'storage.json'),
  };
}

function pointerOf(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8')).dir;
  } catch {
    return null;
  }
}

function writePointer(path, dir) {
  writeFileSync(path, `${JSON.stringify({ dir }, null, 2)}\n`, 'utf8');
}

function allDatabases(from) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of requireNode('node:fs').readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else if (entry.name.endsWith('.db')) out.push(`${prefix}${entry.name}`);
    }
  };
  walk(from, '');
  return out.sort();
}

function scenario(name, fn) {
  const started = Date.now();
  try {
    const detail = fn();
    results.push({ name, ok: true, detail, ms: Date.now() - started });
    console.log(`PASS  ${name}  (${Date.now() - started}ms)  ${detail ?? ''}`);
  } catch (error) {
    results.push({ name, ok: false, detail: error.message, ms: Date.now() - started });
    console.log(`FAIL  ${name}: ${error.message}`);
  }
}

// 1. normal migration: consistent copies, explicit switch, writable target
scenario('1 正常迁移', () => {
  const f = fixture('t1');
  writePointer(f.pointer, f.from);
  const before = allDatabases(f.from).map((rel) => ({ rel, sig: dbSignature(join(f.from, rel)) }));

  const result = runMigration({ from: f.from, to: f.to, journalPath: f.journal, pointerPath: f.pointer });
  assert.equal(result.phase, 'done');
  assert.equal(pointerOf(f.pointer), f.to, 'pointer should point at the target');
  assert.equal(readJournal(f.journal).phase, 'done');

  for (const { rel, sig } of before) {
    const target = join(f.to, rel);
    assert.ok(existsSync(target), `missing copy: ${rel}`);
    const after = dbSignature(target);
    assert.equal(after.integrity, 'ok', `integrity failed: ${rel}`);
    assert.deepEqual(after.counts, sig.counts, `row counts differ: ${rel}`);
  }

  // target accepts writes
  const { DatabaseSync } = requireNode('node:sqlite');
  const db = new DatabaseSync(join(f.to, 'index.db'));
  db.exec("INSERT INTO settings (k, v) VALUES ('migration-probe', '1')");
  const row = db.prepare("SELECT v FROM settings WHERE k = 'migration-probe'").all();
  db.close();
  assert.equal(row[0].v, '1', 'target not writable');
  return `${before.length} 个库一致，目标可写`;
});

// 2. abort before the switch: target already occupied, source untouched
scenario('2 切换前失败（目标非空）', () => {
  const f = fixture('t2');
  writePointer(f.pointer, f.from);
  mkdirSync(f.to, { recursive: true });
  writeFileSync(join(f.to, 'occupied.db'), 'x');

  const before = dbSignature(join(f.from, 'index.db'));
  let threw = null;
  try {
    runMigration({ from: f.from, to: f.to, journalPath: f.journal, pointerPath: f.pointer });
  } catch (error) {
    threw = error.message;
  }
  assert.ok(threw, 'migration should refuse a non-empty target');
  assert.equal(pointerOf(f.pointer), f.from, 'pointer must stay on the source');
  assert.deepEqual(dbSignature(join(f.from, 'index.db')), before, 'source changed');
  assert.equal(readJournal(f.journal), null, 'no journal should be left behind');
  return threw;
});

// 3. crash while copying/prepared -> recovery rolls back to the source
scenario('3 复制后、切换前中断', () => {
  const f = fixture('t3');
  writePointer(f.pointer, f.from);
  const result = runMigration({
    from: f.from, to: f.to, journalPath: f.journal, pointerPath: f.pointer, stopAfterPhase: 'prepared',
  });
  assert.equal(result.phase, 'prepared');
  assert.equal(pointerOf(f.pointer), f.from, 'pointer should not move before commit');

  const recovered = recoverMigration({ journalPath: f.journal, pointerPath: f.pointer });
  assert.equal(recovered.action, 'rollback-target');
  assert.equal(recovered.dir, f.from);
  return `phase=prepared → ${recovered.action}`;
});

// 4. contradiction: pointer moved but journal never reached committed
scenario('4 指针已切、日志未提交', () => {
  const f = fixture('t4');
  writePointer(f.pointer, f.from);
  runMigration({
    from: f.from, to: f.to, journalPath: f.journal, pointerPath: f.pointer, stopAfterPhase: 'prepared',
  });
  writePointer(f.pointer, f.to); // simulate an external/aborted switch

  const recovered = recoverMigration({ journalPath: f.journal, pointerPath: f.pointer });
  assert.equal(recovered.action, 'rollback-pointer');
  assert.equal(recovered.dir, f.from);
  return `phase=prepared + pointer=target → ${recovered.action}`;
});

// 5. crash after the switch -> never roll back to a stale source
scenario('5 切换后、清理前中断', () => {
  const f = fixture('t5');
  writePointer(f.pointer, f.from);
  const sigBefore = dbSignature(join(f.from, 'index.db'));
  const result = runMigration({
    from: f.from, to: f.to, journalPath: f.journal, pointerPath: f.pointer, stopAfterPhase: 'committed',
  });
  assert.equal(result.phase, 'committed');
  assert.equal(pointerOf(f.pointer), f.to);

  const recovered = recoverMigration({ journalPath: f.journal, pointerPath: f.pointer });
  assert.equal(recovered.action, 'finish');
  assert.equal(recovered.dir, f.to);
  assert.deepEqual(dbSignature(join(f.to, 'index.db')).counts, sigBefore.counts);
  return `phase=committed → ${recovered.action}`;
});

const failed = results.filter((item) => !item.ok);
console.log('');
console.log(`${results.length - failed.length}/${results.length} 通过`);
writeFileSync(join(ROOT, 'test-report.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
if (failed.length) process.exitCode = 1;
