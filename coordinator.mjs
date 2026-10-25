/**
 * Access coordinator for storage migration.
 *
 * Failure rules (each from a reproduced counter-example):
 *  - A queued write that cannot be persisted rejects; never reports success.
 *  - Replay rotates the active file to a batch, so appends racing with a replay
 *    land in a fresh file. Leftover batches from a crash are replayed on start.
 *  - `close()` is a sticky state: recovery failures must not be bypassed by any
 *    lazy open, tool call or prompt render.
 */
import {
  closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync, appendFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function createCoordinator(options) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 10_000;
  const queuePath = options.queuePath;
  const replay = options.replay ?? (() => {});

  let mode = 'open';
  let inflight = 0;
  let migration = null;
  let drainResolvers = [];
  let queueChain = Promise.resolve();
  let queueError = '';

  function admit() {
    if (mode !== 'open') return false;
    inflight += 1;
    return true;
  }

  function leave() {
    if (inflight > 0) inflight -= 1;
    if (inflight === 0 && drainResolvers.length) {
      const waiting = drainResolvers;
      drainResolvers = [];
      for (const resolve of waiting) resolve(true);
    }
  }

  function waitForDrain() {
    if (inflight === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      drainResolvers.push((ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
    });
  }

  /** Leftover batches from an interrupted replay, oldest first. */
  function batchFiles() {
    try {
      const dir = dirname(queuePath);
      const base = basename(queuePath);
      return readdirSync(dir)
        .filter((name) => name.startsWith(base) && name.endsWith('.batch'))
        .sort()
        .map((name) => join(dir, name));
    } catch {
      return [];
    }
  }

  function countLines(file) {
    try {
      return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).length;
    } catch {
      return 0;
    }
  }

  function pendingCount() {
    let total = existsSync(queuePath) ? countLines(queuePath) : 0;
    for (const file of batchFiles()) total += countLines(file);
    return total;
  }

  function enqueue(event) {
    const line = `${JSON.stringify(event)}\n`;
    const run = queueChain.then(() => {
      const fd = openSync(queuePath, 'a');
      try {
        writeSync(fd, line);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      queueError = '';
    }).catch((error) => {
      queueError = String(error?.message ?? error);
      throw error;
    });
    queueChain = run.then(() => {}, () => {});
    return run;
  }

  async function replayFile(file) {
    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
    let done = 0;
    let failed = 0;
    for (let index = 0; index < lines.length; index += 1) {
      try {
        await replay(JSON.parse(lines[index]));
        done += 1;
      } catch {
        failed = 1;
        const tail = lines.slice(index).join('\n');
        if (tail) appendFileSync(queuePath, `${tail}\n`, 'utf8');
        break;
      }
    }
    unlinkSync(file);
    return { replayed: done, failed };
  }

  /**
   * Replay order: every leftover batch first (a crash may have left several),
   * then rotate the active file. Anything appended during this run goes to a
   * fresh active file and is never swept up by this pass.
   */
  function replayQueue() {
    const run = queueChain.then(async () => {
      let replayed = 0;
      let failed = 0;
      for (const file of batchFiles()) {
        const result = await replayFile(file);
        replayed += result.replayed;
        failed = failed || result.failed;
      }
      if (existsSync(queuePath)) {
        const batch = `${queuePath}.${Date.now()}.batch`;
        renameSync(queuePath, batch);
        const result = await replayFile(batch);
        replayed += result.replayed;
        failed = failed || result.failed;
      }
      return { replayed, failed };
    });
    queueChain = run.then(() => {}, () => {});
    return run;
  }

  async function beginMigration(run) {
    if (migration) throw new Error('已有迁移在进行');
    if (mode !== 'open') throw new Error(`存储当前不可迁移（mode=${mode}）`);
    migration = { id: `mig-${Date.now()}` };
    mode = 'draining';

    try {
      const drained = await waitForDrain();
      if (!drained) {
        mode = 'open';
        migration = null;
        throw new Error(`排空超时（${timeoutMs}ms），迁移已取消`);
      }
      mode = 'switching';
      const result = await run(migration);
      mode = 'open';
      migration = null;
      return result;
    } catch (error) {
      if (error?.committed) {
        mode = 'closed';
        migration = null;
        throw error;
      }
      mode = 'open';
      migration = null;
      throw error;
    }
  }

  return {
    admit,
    leave,
    enqueue,
    beginMigration,
    replayQueue,
    pendingCount,
    /** Recovery failed: nothing may open the store until an operator fixes it. */
    close: () => { mode = 'closed'; },
    reopen: () => { if (mode === 'closed') mode = 'open'; },
    status: () => ({ mode, inflight, migrating: Boolean(migration), pending: pendingCount(), queueError }),
  };
}

/** Identity for a session event: stable across replays, distinct between messages. */
export function eventKey(sessionId, event) {
  const seq = event?.seq;
  if (seq === undefined || seq === null) return null;
  return `${sessionId}:${seq}`;
}
