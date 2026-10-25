/**
 * Migration core — consistent copy, persistent journal, pointer switch.
 *
 * Design constraints learned the hard way:
 *  - Never copy a live SQLite file byte-by-byte: WAL and in-flight transactions
 *    make that an inconsistent snapshot. `VACUUM INTO` produces a single
 *    consistent database file while the source stays open.
 *  - The switch must be explicit and ordered: copying -> prepared -> pointer ->
 *    committed -> done. A crash between any two steps is recoverable because
 *    both the journal and the pointer are on disk.
 *  - The journal is the source of truth for recovery; in-memory phase is not.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const requireNode = createRequire(import.meta.url);

/** Written inside the target: proof that this directory belongs to a migration. */
const MARKER = '.dsh-migration-owner.json';

function openDb(file) {
  const { DatabaseSync } = requireNode('node:sqlite');
  return new DatabaseSync(file);
}

/** Tables and row counts: a cheap but real equality check between two copies. */
export function dbSignature(file) {
  const db = openDb(file);
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all().map((row) => Object.values(row)[0]);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
      .map((row) => row.name)
      .sort();
    const counts = {};
    for (const table of tables) {
      counts[table] = Number(db.prepare(`SELECT count(*) AS n FROM "${table}"`).all()[0].n);
    }
    return { integrity: integrity.join(','), tables, counts };
  } finally {
    db.close();
  }
}

function sameSignature(a, b) {
  if (a.integrity !== 'ok' || b.integrity !== 'ok') return false;
  if (a.tables.join('|') !== b.tables.join('|')) return false;
  return a.tables.every((table) => a.counts[table] === b.counts[table]);
}

export function readJournal(journalPath) {
  try {
    return JSON.parse(readFileSync(journalPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function writeJournal(journalPath, data) {
  const tmp = `${journalPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(tmp, journalPath);
}

function readPointerFile(pointerPath) {
  try {
    const raw = JSON.parse(readFileSync(pointerPath, 'utf8').replace(/^\uFEFF/, ''));
    return typeof raw?.dir === 'string' ? raw.dir : null;
  } catch {
    return null;
  }
}

function writePointerFile(pointerPath, dir) {
  const tmp = `${pointerPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ dir }, null, 2)}\n`, 'utf8');
  renameSync(tmp, pointerPath);
}

/** index.db first, then conversations, then the archive subfolder. */
export function listDatabases(from) {
  const files = readdirSync(from).filter((entry) => entry.endsWith('.db')).sort((a, b) => {
    if (a === 'index.db') return -1;
    if (b === 'index.db') return 1;
    return a.localeCompare(b);
  });
  const archiveDir = join(from, 'archive');
  const archived = existsSync(archiveDir)
    ? readdirSync(archiveDir).filter((entry) => entry.endsWith('.db')).map((entry) => `archive/${entry}`)
    : [];
  return [...files, ...archived];
}

/**
 * @param {object} options
 * @param {string} options.from       current storage directory
 * @param {string} options.to         target storage directory
 * @param {string} options.journalPath persistent migration journal
 * @param {string} options.pointerPath storage pointer file
 * @param {(phase: string, detail?: object) => void} [options.onPhase]
 * @param {string} [options.stopAfterPhase] test-only injection point
 */
export function runMigration(options) {
  const from = resolve(options.from);
  const to = resolve(options.to);
  const journalPath = options.journalPath;
  const pointerPath = options.pointerPath;
  const onPhase = options.onPhase ?? (() => {});
  const stopAfter = options.stopAfterPhase ?? null;

  if (from === to) throw new Error('source and target are the same directory');
  if (!existsSync(from)) throw new Error(`source directory missing: ${from}`);
  if (existsSync(to) && readdirSync(to).length > 0) throw new Error(`target is not empty: ${to}`);

  const files = listDatabases(from);
  if (!files.length) throw new Error(`no databases found in ${from}`);

  mkdirSync(to, { recursive: true });
  const journal = {
    id: `mig-${Date.now()}`,
    from,
    to,
    phase: 'copying',
    startedAt: new Date().toISOString(),
    files,
  };
  // Ownership marker: cleanup may only delete a directory this migration made.
  writeFileSync(join(to, MARKER), `${JSON.stringify({ id: journal.id, from, to })}\n`, 'utf8');
  writeJournal(journalPath, journal);
  onPhase('copying', { files });

  // 1. consistent copies
  const signatures = {};
  for (const relative of files) {
    const source = join(from, relative);
    const target = join(to, relative);
    mkdirSync(join(target, '..'), { recursive: true });
    if (existsSync(target)) rmSync(target, { force: true });
    const db = openDb(source);
    try {
      db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
    const before = dbSignature(source);
    const after = dbSignature(target);
    if (!sameSignature(before, after)) {
      throw new Error(`copy verification failed for ${relative}`);
    }
    signatures[relative] = { bytes: statSync(target).size, tables: after.tables.length };
  }

  // 2. prepared: copies verified, pointer still points at the source
  journal.phase = 'prepared';
  journal.signatures = signatures;
  journal.preparedAt = new Date().toISOString();
  writeJournal(journalPath, journal);
  onPhase('prepared');
  if (stopAfter === 'prepared') return { phase: 'prepared', journal };

  // 3. explicit switch
  writePointerFile(pointerPath, to);
  journal.phase = 'committed';
  journal.committedAt = new Date().toISOString();
  writeJournal(journalPath, journal);
  onPhase('committed');
  if (stopAfter === 'committed') return { phase: 'committed', journal };

  // 4. done (source files are left in place; cleanup is a separate decision)
  journal.phase = 'done';
  journal.finishedAt = new Date().toISOString();
  writeJournal(journalPath, journal);
  onPhase('done');
  return { phase: 'done', journal };
}

/**
 * Startup recovery. Decides the authoritative directory from the pointer plus
 * the journal, never from an in-memory phase.
 */
export function recoverMigration({ journalPath, pointerPath }) {
  const journal = readJournal(journalPath);
  if (!journal) return { action: 'none', dir: readPointerFile(pointerPath) };

  const pointer = readPointerFile(pointerPath);
  const pointerIsTarget = pointer === journal.to;

  if (journal.phase === 'copying' || journal.phase === 'prepared') {
    // Target may be partial or complete, but nobody writes there yet.
    if (pointerIsTarget) {
      // Contradiction: pointer already switched but the copy was not committed.
      return { action: 'rollback-pointer', dir: journal.from, journal };
    }
    return { action: 'rollback-target', dir: journal.from, journal };
  }

  if (journal.phase === 'committed' || journal.phase === 'done') {
    // Writes may already have landed in the target: never roll back to the
    // source, it is behind.
    return { action: pointerIsTarget ? 'finish' : 'repoint', dir: journal.to, journal };
  }

  return { action: 'unknown', dir: pointer, journal };
}

/** Remove a target only when this migration owns it (marker must match). */
export function discardTarget(target, expectedId) {
  if (!existsSync(target)) return false;
  try {
    const owner = JSON.parse(readFileSync(join(target, MARKER), 'utf8'));
    if (!owner?.id) return false;
    if (expectedId && owner.id !== expectedId) return false;
  } catch {
    return false; // no marker: not ours to delete
  }
  rmSync(target, { recursive: true, force: true });
  return true;
}

/** Journal is consumed once the authoritative directory is settled. */
export function finalizeJournal(journalPath) {
  try {
    if (existsSync(journalPath)) rmSync(journalPath, { force: true });
    return true;
  } catch {
    return false;
  }
}
