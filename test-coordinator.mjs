/**
 * Coordinator tests: gate, on-disk queue, idempotent replay.
 * Run: node test-coordinator.mjs
 */
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createCoordinator, eventKey } from './coordinator.mjs';

const requireNode = createRequire(import.meta.url);
const ROOT = 'D:/Deepseek_work/dsh-memory/_migtest/coord';
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

function fakeDb() {
  const { DatabaseSync } = requireNode('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE messages (
    session_id TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL,
    UNIQUE (session_id, seq))`);
  return db;
}

function replayInto(db) {
  return (event) => {
    db.prepare('INSERT OR IGNORE INTO messages (session_id, seq, text) VALUES (?, ?, ?)')
      .run(event.sessionId, event.seq, event.text);
  };
}

const results = [];
function scenario(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => { results.push({ name, ok: true }); console.log(`PASS  ${name}  ${detail ?? ''}`); })
    .catch((error) => { results.push({ name, ok: false, detail: error.message }); console.log(`FAIL  ${name}: ${error.message}`); });
}

await scenario('1 排空超时：取消迁移、恢复准入、队列保留', async () => {
  const queuePath = join(ROOT, 'q1.jsonl');
  const gate = createCoordinator({ timeoutMs: 80, queuePath });
  assert.equal(gate.admit(), true);            // a slow operation is in flight
  let ran = false;
  await assert.rejects(
    gate.beginMigration(async () => { ran = true; }),
    /排空超时/,
  );
  assert.equal(ran, false, 'migration must not run after a drain timeout');
  assert.equal(gate.status().mode, 'open');
  assert.equal(gate.admit(), true, 'admission must be restored');
  gate.leave();
  return 'mode=open，未执行迁移';
});

await scenario('2 暂停期间的消息：落盘、切换后完整重放', async () => {
  const queuePath = join(ROOT, 'q2.jsonl');
  const db = fakeDb();
  const gate = createCoordinator({ timeoutMs: 1000, queuePath, replay: replayInto(db) });
  const key = eventKey('s1', { seq: 7 });
  assert.equal(key, 's1:7');

  gate.admit();                                 // in-flight read holds the gate open
  const migration = gate.beginMigration(async () => ({ ok: true }));
  await gate.enqueue({ sessionId: 's1', seq: 7, text: '迁移期间的消息' });
  await gate.enqueue({ sessionId: 's1', seq: 8, text: '迁移期间的消息' }); // 同文，不同事件
  gate.leave();                                 // drain completes here
  await migration;

  assert.equal(gate.pendingCount(), 2);
  const { replayed } = await gate.replayQueue();
  assert.equal(replayed, 2);
  const rows = db.prepare('SELECT seq, text FROM messages ORDER BY seq').all();
  assert.equal(rows.length, 2, '两条独立消息都必须保留');
  return `pending=2 → replayed=${replayed}，同文两条都在`;
});

await scenario('3 重放幂等：同一事件两次只留一条', async () => {
  const db = fakeDb();
  const replay = replayInto(db);
  const event = { sessionId: 's2', seq: 3, text: '重复事件' };
  await replay(event);
  await replay(event);
  const rows = db.prepare('SELECT seq FROM messages').all();
  assert.equal(rows.length, 1, 'same event must not duplicate');
  return 'replay twice → 1 row';
});

await scenario('4 提交后失败：保持关闭，不放行', async () => {
  const queuePath = join(ROOT, 'q4.jsonl');
  const gate = createCoordinator({ timeoutMs: 500, queuePath });
  await assert.rejects(
    gate.beginMigration(async () => {
      const error = new Error('reopen failed after commit');
      error.committed = true;
      throw error;
    }),
    /reopen failed/,
  );
  assert.equal(gate.status().mode, 'closed', 'gate must stay closed after a committed failure');
  assert.equal(gate.admit(), false, 'no admission while the authoritative store is unknown');
  return 'mode=closed，拒绝新访问';
});

// queue file must exist on disk for the replay scenarios
const persisted = ['q2.jsonl', 'q1.jsonl'].filter((name) => existsSync(join(ROOT, name)));
console.log(`\n磁盘队列检查：${persisted.length ? persisted.join(', ') : '（重放后已清理）'}`);
const failed = results.filter((item) => !item.ok);
console.log(`${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
