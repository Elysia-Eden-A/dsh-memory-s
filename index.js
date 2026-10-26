/**
 * dsh-memory — cross-session long-term memory, stored as SQLite.
 *
 * Layout inside the storage directory:
 *   index.db              facts, handoffs, session catalog, settings
 *   2026_10_23_14_11.db   one file per conversation, holding its messages
 *   _trash/               fallback landing place when the recycle bin is unavailable
 *
 * The storage directory is recorded in `storage.json` next to this file, so the
 * pointer survives a directory change (index.db itself travels with the data).
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync,
  rmdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCoordinator } from './coordinator.mjs';
import { recoverMigration, runMigration, discardTarget, readJournal, finalizeJournal } from './migrate-core.mjs';

export const name = 'dsh-memory';
export const inject = ['tools', 'systemPrompt', 'webServer'];

const HERE = dirname(fileURLToPath(import.meta.url));
const POINTER = join(HERE, 'storage.json');
const DEFAULT_DIR = join(HERE, 'data');
const JOURNAL = join(HERE, 'migration.json');
const QUEUE = join(HERE, 'pending-writes.jsonl');

/** All database access goes through this gate; nothing opens SQLite while closed. */
const coordinator = createCoordinator({
  timeoutMs: Number(process.env.DSH_MEMORY_DRAIN_MS) || 10_000,
  queuePath: QUEUE,
  replay: (event) => {
    persistMessage({
      sessionId: String(event.sessionId),
      seq: Number(event.seq),
      role: String(event.role),
      turn: Number(event.turn ?? 0),
      text: String(event.text),
      time: event.time ?? null,
      cwd: event.cwd ?? null,
      origin: event.origin ?? null,
    });
  },
});
const MB = 1024 * 1024;
const SECTION_CACHE_MS = 4000;

/* ------------------------------------------------------------------ */
/* SQLite access: node:sqlite when the host has it, sqlite3 CLI otherwise */
/* ------------------------------------------------------------------ */

const requireNode = createRequire(import.meta.url);
const SQLITE_CANDIDATES = [
  process.env.DSH_MEMORY_SQLITE3,
  'sqlite3.exe',
  'sqlite3',
  'C:\\msys64\\ucrt64\\bin\\sqlite3.exe',
  'C:\\msys64\\mingw64\\bin\\sqlite3.exe',
];

function quoteValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function interpolate(sql, params) {
  let index = 0;
  return sql.replace(/\?/g, () => quoteValue(params[index++]));
}

let cliPath;
function resolveCli() {
  if (cliPath !== undefined) return cliPath;
  for (const candidate of SQLITE_CANDIDATES) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (!probe.error && probe.status === 0) {
      cliPath = candidate;
      return cliPath;
    }
  }
  cliPath = null;
  return null;
}

class Db {
  constructor(file) {
    this.file = file;
    this.native = null;
    this.mode = null;
  }

  open() {
    if (this.mode) return this;
    try {
      const { DatabaseSync } = requireNode('node:sqlite');
      const native = new DatabaseSync(this.file);
      native.exec('PRAGMA journal_mode = WAL');
      native.exec('PRAGMA synchronous = NORMAL');
      this.native = native;
      this.mode = 'native';
      return this;
    } catch (error) {
      const cli = resolveCli();
      if (!cli) throw new Error(`SQLite 不可用：${error.message}`);
      this.cli = cli;
      this.mode = 'cli';
      return this;
    }
  }

  all(sql, params = []) {
    this.open();
    if (this.mode === 'native') return this.native.prepare(sql).all(...params);
    const result = spawnSync(this.cli, ['-json', this.file, interpolate(sql, params)], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 64 * MB,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`sqlite3: ${(result.stderr || '').trim()}`);
    const output = (result.stdout || '').trim();
    return output ? JSON.parse(output) : [];
  }

  run(sql, params = []) {
    this.open();
    if (this.mode === 'native') {
      this.native.prepare(sql).run(...params);
      return;
    }
    const result = spawnSync(this.cli, [this.file, interpolate(sql, params)], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 64 * MB,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`sqlite3: ${(result.stderr || '').trim()}`);
  }

  checkpoint() {
    if (this.mode !== 'native') return;
    try {
      this.native.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* the checkpoint is best-effort before a move */
    }
  }

  close() {
    if (this.native) {
      try {
        this.checkpoint();
        this.native.close();
      } catch {
        /* closing must never throw into the caller */
      }
    }
    this.native = null;
    this.mode = null;
  }
}

/* ------------------------------------------------------------------ */
/* Storage manager                                                      */
/* ------------------------------------------------------------------ */

const INDEX_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (
     k TEXT PRIMARY KEY,
     v TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     session_id TEXT PRIMARY KEY,
     title TEXT,
     started_at TEXT NOT NULL,
     file_name TEXT NOT NULL,
     message_count INTEGER NOT NULL DEFAULT 0,
     char_count INTEGER NOT NULL DEFAULT 0,
     size_bytes INTEGER NOT NULL DEFAULT 0,
     limit_override INTEGER,
     state TEXT NOT NULL DEFAULT 'recording',
     last_write_at TEXT,
     alert90_at TEXT,
     alert100_at TEXT,
     focus_session TEXT,
     kind TEXT NOT NULL DEFAULT 'user',
     folder TEXT NOT NULL DEFAULT 'main'
   )`,
  `CREATE TABLE IF NOT EXISTS facts (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL DEFAULT 'fact',
     key TEXT,
     content TEXT NOT NULL,
     importance INTEGER NOT NULL DEFAULT 0,
     pinned INTEGER NOT NULL DEFAULT 0,
     strength REAL NOT NULL DEFAULT 1,
     use_count INTEGER NOT NULL DEFAULT 0,
     last_used_at TEXT,
     superseded_by INTEGER,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS handoffs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT,
     title TEXT,
     summary TEXT NOT NULL,
     next_steps TEXT,
     created_at TEXT NOT NULL
   )`,
];

const SESSION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS messages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     role TEXT NOT NULL,
     turn INTEGER,
     text TEXT NOT NULL,
     created_at TEXT NOT NULL,
     seq INTEGER
   )`,
];

function pad(value) {
  return String(value).padStart(2, '0');
}

function timeStamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function fileStamp(date = new Date()) {
  return `${date.getFullYear()}_${pad(date.getMonth() + 1)}_${pad(date.getDate())}`
    + `_${pad(date.getHours())}_${pad(date.getMinutes())}`;
}

function readPointer() {
  try {
    // A UTF-8 BOM (common when a file is edited by hand on Windows) breaks
    // JSON.parse; without this the pointer silently reverts to the default dir.
    const text = readFileSync(POINTER, 'utf8').replace(/^\uFEFF/, '');
    const raw = JSON.parse(text);
    if (raw && typeof raw.dir === 'string' && raw.dir.trim()) return raw.dir;
    throw new Error(`存储指针缺少有效的 dir 字段：${POINTER}`);
  } catch (error) {
    // A missing file is the first run; a corrupt file is never silently
    // replaced by the default directory.
    if (error?.code === 'ENOENT') return DEFAULT_DIR;
    throw error instanceof Error && error.message.includes(POINTER)
      ? error
      : new Error(`存储指针无效（${POINTER}）：${describeError(error)}`);
  }
  return DEFAULT_DIR;
}

function writePointer(dir) {
  writeFileSync(POINTER, `${JSON.stringify({ dir }, null, 2)}\n`, 'utf8');
}

const store = {
  dir: null,
  index: null,
  settings: { defaultLimit: 10000, sizeLimitBytes: 50 * MB },
  sessions: new Map(), // sessionId -> Db
};

function setting(key, fallback) {
  const rows = store.index.all('SELECT v FROM settings WHERE k = ?', [key]);
  return rows.length ? rows[0].v : fallback;
}

function setSetting(key, value) {
  store.index.run(
    'INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
    [key, String(value)],
  );
}

/** Older databases predate a column; ADD COLUMN is the whole migration. */
function ensureColumn(table, column, ddl) {
  try {
    const info = store.index.all(`PRAGMA table_info(${table})`);
    if (info.some((row) => row.name === column)) return;
    store.index.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  } catch {
    /* a failed migration keeps the previous shape, not a broken open */
  }
}

let openFailureOnce = false;

function openStore(dir) {
  if (openFailureOnce) {
    openFailureOnce = false;
    throw new Error('注入的 openStore 失败');
  }
  mkdirSync(dir, { recursive: true });
  store.dir = dir;
  store.index = new Db(join(dir, 'index.db'));
  for (const statement of INDEX_SCHEMA) store.index.run(statement);
  ensureColumn('sessions', 'alert90_at', 'TEXT');
  ensureColumn('sessions', 'alert100_at', 'TEXT');
  ensureColumn('sessions', 'focus_session', 'TEXT');
  ensureColumn('sessions', 'kind', "TEXT NOT NULL DEFAULT 'user'");
  ensureColumn('sessions', 'folder', "TEXT NOT NULL DEFAULT 'main'");
  ensureColumn('facts', 'strength', 'REAL NOT NULL DEFAULT 1');
  ensureColumn('facts', 'use_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('facts', 'last_used_at', 'TEXT');
  ensureColumn('facts', 'superseded_by', 'INTEGER');
  ensureColumn('handoffs', 'covered_upto', 'INTEGER');
  ensureColumn('handoffs', 'auto', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('sessions', 'handoff_pending', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('sessions', 'unsummarized_from', 'INTEGER');
  ensureColumn('sessions', 'cwd', 'TEXT');
  ensureColumn('facts', 'scope', "TEXT NOT NULL DEFAULT 'unclassified'");
  ensureColumn('handoffs', 'scope', 'TEXT');
  if (!existsSync(POINTER)) writePointer(dir);
  store.settings.defaultLimit = Number(setting('default_limit', 10000)) || 10000;
  store.settings.sizeLimitBytes = (Number(setting('size_limit_mb', 50)) || 50) * MB;
  return store;
}

/** A migrated directory must still carry the tables this plugin relies on. */
function verifyStorageSchema(dir) {
  const file = join(dir, 'index.db');
  if (!existsSync(file)) return 'index.db 缺失';
  let db = null;
  try {
    db = new Db(file);
    const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name));
    const missing = ['settings', 'sessions', 'facts', 'handoffs'].filter((name) => !tables.has(name));
    return missing.length ? `缺少表：${missing.join(', ')}` : null;
  } catch (error) {
    return describeError(error);
  } finally {
    try {
      db?.close();
    } catch {
      /* nothing else to close */
    }
  }
}

/** Tables in a SQLite file, opened without creating anything. */
function tableNamesOf(file) {
  const { DatabaseSync } = requireNode('node:sqlite');
  const db = new DatabaseSync(file);
  try {
    return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name)));
  } finally {
    db.close();
  }
}

/**
 * Full check shared by recovery and migration: the index must be usable, every
 * session row must map to a real file, and that file must have its messages
 * table. Anything short of that keeps the copies and the journal intact.
 */
function verifyStorageFull(dir) {
  const indexProblem = verifyStorageSchema(dir);
  if (indexProblem) return indexProblem;
  const { DatabaseSync } = requireNode('node:sqlite');
  let index = null;
  try {
    index = new DatabaseSync(join(dir, 'index.db'));
    const rows = index.prepare('SELECT session_id, file_name, folder FROM sessions').all();
    for (const row of rows) {
      const base = row.folder === 'archive' ? join(dir, 'archive') : dir;
      const file = join(base, String(row.file_name));
      if (!existsSync(file)) return `缺少会话库：${row.file_name}（${row.session_id}）`;
      let tables = null;
      try {
        tables = tableNamesOf(file);
      } catch (error) {
        return `会话库无法打开：${row.file_name}：${describeError(error)}`;
      }
      if (!tables.has('messages')) return `会话库缺少 messages 表：${row.file_name}`;
    }
    return null;
  } catch (error) {
    return describeError(error);
  } finally {
    try {
      index?.close();
    } catch {
      /* already closed */
    }
  }
}

function closeStore() {
  for (const db of store.sessions.values()) db.close();
  store.sessions.clear();
  store.index?.close();
  store.index = null;
}

function ensureStore() {
  if (coordinator.status().mode === 'closed') {
    throw new Error(`存储不可用：${storeError || '上次迁移恢复未完成'}`);
  }
  if (!store.index) {
    try {
      openStore(readPointer() || DEFAULT_DIR);
      storeError = '';
    } catch (error) {
      storeError = describeError(error);
      throw error;
    }
  }
  return store;
}

/** Archived conversations keep their file, just outside the main folder. */
function sessionPath(row) {
  const base = row.folder === 'archive' ? join(store.dir, 'archive') : store.dir;
  return join(base, row.file_name);
}

function sessionDb(row) {
  const key = row.session_id;
  let db = store.sessions.get(key);
  if (!db) {
    db = new Db(sessionPath(row));
    for (const statement of SESSION_SCHEMA) db.run(statement);
    // Older files predate the message identity column: add it BEFORE any index
    // references it, and report a failed upgrade instead of limping along.
    const columns = db.all('PRAGMA table_info(messages)').map((column) => String(column.name));
    if (!columns.includes('seq')) {
      try {
        db.run('ALTER TABLE messages ADD COLUMN seq INTEGER');
      } catch (error) {
        syncError = `升级会话库失败（${row.session_id}）：${describeError(error)}`;
        throw error;
      }
    }
    try {
      db.run('CREATE UNIQUE INDEX IF NOT EXISTS messages_seq ON messages(seq) WHERE seq IS NOT NULL');
    } catch (error) {
      // Duplicates from an older file keep the index out, but must be visible.
      syncError = `消息索引未建立（${row.session_id}）：${describeError(error)}`;
    }
    store.sessions.set(key, db);
  }
  return db;
}

function uniqueFileName(base, folder = 'main') {
  const dir = folder === 'archive' ? join(store.dir, 'archive') : store.dir;
  mkdirSync(dir, { recursive: true });
  let candidate = `${base}.db`;
  let suffix = 2;
  while (existsSync(join(dir, candidate))) {
    candidate = `${base}_${suffix}.db`;
    suffix += 1;
  }
  return candidate;
}

function sessionRow(sessionId) {
  const rows = store.index.all('SELECT * FROM sessions WHERE session_id = ?', [sessionId]);
  return rows[0];
}

function ensureSession(sessionId, title, kind = 'user') {
  ensureStore();
  let row = sessionRow(sessionId);
  if (row) return row;
  const now = new Date();
  const folder = kind === 'subagent' ? 'archive' : 'main';
  const fileName = uniqueFileName(fileStamp(now), folder);
  store.index.run(
    `INSERT INTO sessions (session_id, title, started_at, file_name, message_count, char_count,
       size_bytes, limit_override, state, last_write_at, kind, folder)
     VALUES (?, ?, ?, ?, 0, 0, 0, NULL, 'recording', ?, ?, ?)`,
    [sessionId, title ?? null, timeStamp(now), fileName, timeStamp(now), kind, folder],
  );
  row = sessionRow(sessionId);
  sessionDb(row); // create the file eagerly so the catalog and the disk agree
  return row;
}

function limitOf(row) {
  return Number(row.limit_override) || store.settings.defaultLimit;
}

function refreshSize(row) {
  try {
    const info = statSync(sessionPath(row));
    const bytes = info.size;
    if (bytes !== row.size_bytes) {
      store.index.run('UPDATE sessions SET size_bytes = ? WHERE session_id = ?', [bytes, row.session_id]);
      row.size_bytes = bytes;
    }
  } catch {
    /* a missing file just keeps the last known size */
  }
}

function overview() {
  ensureStore();
  const rows = store.index.all('SELECT * FROM sessions ORDER BY started_at DESC');
  const sessions = rows.map((row) => {
    refreshSize(row);
    const limit = limitOf(row);
    const byCount = limit > 0 ? row.message_count / limit : 0;
    const bySize = store.settings.sizeLimitBytes > 0 ? row.size_bytes / store.settings.sizeLimitBytes : 0;
    const ratio = Math.max(byCount, bySize);
    return {
      id: row.session_id,
      title: row.title || '（未命名对话）',
      focus: row.focus_session || null,
      folder: row.folder || 'main',
      kind: row.kind || 'user',
      startedAt: row.started_at,
      fileName: row.file_name,
      path: sessionPath(row),
      messages: row.message_count,
      chars: row.char_count,
      bytes: row.size_bytes,
      limit,
      state: row.state,
      countPct: Math.round(byCount * 1000) / 10,
      sizePct: Math.round(bySize * 1000) / 10,
      pct: Math.round(ratio * 1000) / 10,
      level: ratio >= 1 ? 'full' : ratio >= 0.9 ? 'danger' : ratio >= 0.7 ? 'warn' : 'ok',
    };
  });
  return {
    dir: store.dir,
    defaultLimit: store.settings.defaultLimit,
    sizeLimitMB: Math.round(store.settings.sizeLimitBytes / MB),
    sessions,
    totals: {
      sessions: sessions.length,
      messages: sessions.reduce((sum, item) => sum + item.messages, 0),
      bytes: sessions.reduce((sum, item) => sum + item.bytes, 0),
    },
  };
}

/* ------------------------------------------------------------------ */
/* File moves                                                           */
/* ------------------------------------------------------------------ */

function recycle(file) {
  const powershell = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  const script = 'Add-Type -AssemblyName Microsoft.VisualBasic; '
    + `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${file.replace(/'/g, "''")}',`
    + "'OnlyErrorDialogs','SendToRecycleBin')";
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true,
  });
  if (result.status !== 0) throw new Error((result.stderr || '').trim() || 'recycle failed');
}

function trash(file) {
  const bin = join(store.dir, '_trash');
  mkdirSync(bin, { recursive: true });
  const target = join(bin, `${Date.now()}_${file.split(/[\\/]/).pop()}`);
  renameSync(file, target);
  return target;
}

function moveFile(from, to) {
  try {
    renameSync(from, to);
    return 'rename';
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    copyFileSync(from, to);
    if (statSync(to).size !== statSync(from).size) throw new Error(`复制校验失败：${from}`);
    try {
      recycle(from);
    } catch {
      trash(from);
    }
    return 'copy';
  }
}

function migrateRemoved(targetDir) {
  throw new Error('旧迁移流程已停用，请使用 /move 的新实现');
  ensureStore();
  const target = resolve(String(targetDir || '').trim());
  if (!target) throw new Error('目标目录为空');
  if (!isAbsolute(target)) throw new Error('需要绝对路径');
  if (target === resolve(store.dir)) return { moved: 0, dir: target };
  mkdirSync(target, { recursive: true });

  const occupied = readdirSync(target).filter((entry) => entry.endsWith('.db'));
  if (occupied.length) throw new Error(`目标目录已有数据库文件：${occupied.slice(0, 3).join(', ')}`);

  const from = store.dir;
  migrationPhase = `closing (${from})`;
  // Close first: closing SQLite removes the -wal/-shm companions, so a listing
  // taken before the close would name files that no longer exist.
  closeStore();
  migrationPhase = `moving (${from} -> ${target})`;

  // Both the main folder and the archive subfolder travel together.
  const pairs = [];
  for (const entry of readdirSync(from)) {
    if (!/\.db(-wal|-shm)?$/.test(entry)) continue;
    pairs.push({ from: join(from, entry), to: join(target, entry) });
  }
  const archiveFrom = join(from, 'archive');
  if (existsSync(archiveFrom)) {
    mkdirSync(join(target, 'archive'), { recursive: true });
    for (const entry of readdirSync(archiveFrom)) {
      pairs.push({ from: join(archiveFrom, entry), to: join(target, 'archive', entry) });
    }
  }

  const done = [];
  try {
    for (const pair of pairs) {
      try {
        moveFile(pair.from, pair.to);
      } catch (error) {
        if (error.code === 'ENOENT') continue; // a companion vanished between listing and moving
        throw error;
      }
      done.push(pair);
    }
  } catch (error) {
    // put back whatever already travelled, so the profile keeps a working set
    for (const pair of done.reverse()) {
      try {
        moveFile(pair.to, pair.from);
      } catch {
        /* the original error is the one worth reporting */
      }
    }
    writePointer(from);
    openStore(from);
    throw new Error(`搬运失败，已回滚：${error.message}`);
  }

  migrationPhase = `switching pointer -> ${target}`;
  writePointer(target);
  migrationPhase = `reopening ${target}`;
  openStore(target);
  migrationPhase = `cleanup ${from}`;
  try {
    if (existsSync(archiveFrom) && !readdirSync(archiveFrom).length) rmdirSync(archiveFrom);
    if (!readdirSync(from).length) rmdirSync(from);
  } catch {
    /* a non-empty directory is the user's business */
  }
  return { moved: done.length, dir: target };
}

/* ------------------------------------------------------------------ */
/* Threshold alerts                                                     */
/* ------------------------------------------------------------------ */

/**
 * The conversation being written right now is the one with the newest message.
 * Alerts are computed on read so a crashed or restarted host cannot lose one.
 */
function alertState(preferredId) {
  ensureStore();
  const rows = store.index.all(
    `SELECT * FROM sessions
     WHERE state = 'recording' AND last_write_at IS NOT NULL AND kind = 'user'
       AND last_write_at >= datetime('now', 'localtime', '-30 minutes')
     ORDER BY last_write_at DESC LIMIT 1`,
  );
  // The conversation the user is looking at wins, even when another one (or a
  // subagent) wrote more recently.
  let row = null;
  if (preferredId) {
    const wanted = sessionRow(String(preferredId));
    if (wanted && wanted.kind === 'user' && wanted.state === 'recording') row = wanted;
  }
  if (!row) row = rows[0];
  if (!row) return { active: false };
  refreshSize(row);
  const limit = limitOf(row);
  const byCount = limit > 0 ? row.message_count / limit : 0;
  const bySize = store.settings.sizeLimitBytes > 0 ? row.size_bytes / store.settings.sizeLimitBytes : 0;
  const ratio = Math.max(byCount, bySize);
  return {
    active: true,
    sessionId: row.session_id,
    title: row.title || '（未命名对话）',
    pct: Math.round(ratio * 1000) / 10,
    level: ratio >= 1 ? 'full' : ratio >= 0.9 ? 'danger' : ratio >= 0.7 ? 'warn' : 'ok',
    messages: row.message_count,
    limit,
    bytes: row.size_bytes,
    needs90: ratio >= 0.9 && !row.alert90_at,
    needs100: ratio >= 1 && !row.alert100_at,
    presets: [5000, 10000, 15000, 20000].filter((value) => value > limit),
  };
}

/* ------------------------------------------------------------------ */
/* Recording                                                            */
/* ------------------------------------------------------------------ */

function messageText(message) {
  const blocks = message?.content ?? message?.blocks;
  if (typeof blocks === 'string') return blocks.trim();
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

const SKIP = new Set(['system/message', 'developer/message', 'tool/result']);

/** Harness-injected blocks arrive as user messages; they are not conversation. */
const SCAFFOLD = /^(Current runtime context|<system-reminder>|Time sampled|Browser time zone|Elapsed since)/i;

/** Injected runtime-context blocks are not human titles. */
function tidyTitle(text) {
  const cleaned = String(text)
    .replace(/^Time sampled[^\n]*/gim, '')
    .replace(/^Browser time zone for this request[^\n]*/gim, '')
    .replace(/^Elapsed since[^\n]*/gim, '')
    .replace(/^Current runtime context[^\n]*/gim, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  if (/^(Time sampled|Browser time zone|Current runtime context)/i.test(cleaned)) return '';
  return cleaned.slice(0, 24);
}

function normalizeProject(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  return raw.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Which sessions a transcript read may scan. Defaults to the current project;
 * other projects (and unclassified files) need an explicit scope.
 */
function transcriptScope(explicit) {
  const raw = String(explicit ?? '').trim();
  if (raw === 'unclassified') return { kind: 'unclassified', cwd: null };
  if (raw && raw !== 'global') return { kind: 'project', cwd: normalizeProject(raw) };
  if (raw === 'global') return { kind: 'none', cwd: null };
  return { kind: 'project', cwd: currentProject() };
}

/**
 * The single write path for a message: used by the live recorder and by queue
 * replay, so counters, cwd, kind and titles stay consistent.
 */
/** Recompute derived counters from the message table itself. */
function calibrateSession(row, handle) {
  const stats = handle.all('SELECT count(*) AS n, ifnull(sum(length(text)), 0) AS chars FROM messages')[0];
  const count = Number(stats?.n ?? 0);
  const chars = Number(stats?.chars ?? 0);
  if (Number(row.message_count) !== count || Number(row.char_count) !== chars) {
    store.index.run(
      'UPDATE sessions SET message_count = ?, char_count = ?, size_bytes = ? WHERE session_id = ?',
      [count, chars, statSize(row), row.session_id],
    );
    row.message_count = count;
    row.char_count = chars;
    invalidateSection();
  }
}

function persistMessage({ sessionId, seq, role, turn, text, time, cwd, origin }) {
  ensureStore();
  const kind = origin === 'subagent' ? 'subagent' : 'user';
  const row = ensureSession(String(sessionId), null, kind);
  if (cwd && row.cwd !== String(cwd).trim()) {
    store.index.run('UPDATE sessions SET cwd = ? WHERE session_id = ?', [String(cwd).trim(), String(sessionId)]);
    row.cwd = String(cwd).trim();
  }
  if (row.state !== 'recording') return false;

  const handle = sessionDb(row);
  if (handle.all('SELECT 1 AS hit FROM messages WHERE seq = ?', [seq]).length) {
    // The insert may have committed while the index update failed; repair the
    // counters instead of skipping the whole event.
    calibrateSession(row, handle);
    return false;
  }
  let createdAt = timeStamp();
  if (time) {
    const numeric = Number(time);
    // Events carry epoch milliseconds; queued rows may carry a formatted string.
    createdAt = Number.isFinite(numeric) && numeric > 0 ? timeStamp(new Date(numeric)) : String(time);
  }
  handle.run(
    'INSERT OR IGNORE INTO messages (role, turn, text, created_at, seq) VALUES (?, ?, ?, ?, ?)',
    [role, Number(turn ?? 0), text, createdAt, seq],
  );
  store.index.run(
    `UPDATE sessions SET message_count = message_count + 1, char_count = char_count + ?,
       last_write_at = ?, size_bytes = ? WHERE session_id = ?`,
    [text.length, timeStamp(), statSize(row), String(sessionId)],
  );
  if (role === 'user' && !row.title) {
    const title = tidyTitle(text);
    if (title) store.index.run('UPDATE sessions SET title = ? WHERE session_id = ?', [title, String(sessionId)]);
  }
  maybeRefreshTitle(String(sessionId));
  invalidateSection();
  return true;
}

function recordEvent(session, event) {
  if (!event || SKIP.has(event.type)) return;
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return;
  const role = event.type === 'user/message' ? 'user' : 'assistant';
  const text = messageText(event.type === 'user/message' ? event.data : event.data?.message);
  if (!text) return;
  const clipped = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
  if (role === 'user' && SCAFFOLD.test(clipped.trim())) return;
  const sessionId = String(session?.id ?? '');
  if (!sessionId) return;

  // Stable identity: the session event's own position. Two identical messages
  // keep distinct seq values; a replayed event keeps its seq.
  const seq = Number.isInteger(event?.seq) ? event.seq : null;
  const turn = Number(event.data?.turn ?? 0);
  if (seq === null) {
    syncError = `事件缺少 seq，未写入（${sessionId} / ${role}）：${clipped.slice(0, 40)}`;
    return;
  }

  if (!coordinator.admit()) {
    // Gate closed: persist instead of dropping; replayed into the store that
    // is authoritative once the migration settles.
    void coordinator.enqueue({
      sessionId, seq, role, turn, text: clipped, time: event.time ?? null,
      cwd: session?.header?.cwd ?? null, origin: session?.header?.origin ?? null,
    }).catch((error) => {
      // Not logged as success: the event has no durable copy, so say so.
      syncError = `消息未能落盘（${sessionId} seq=${seq}）：${describeError(error)}`;
    });
    return;
  }

  try {
    persistMessage({
      sessionId, seq, role, turn, text: clipped,
      time: event.time ?? null,
      cwd: session?.header?.cwd ?? null,
      origin: session?.header?.origin ?? null,
    });
  } finally {
    coordinator.leave();
  }
}

function statSize(row) {
  try {
    return statSync(sessionPath(row)).size;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ */
/* Prompt section                                                       */
/* ------------------------------------------------------------------ */

const sectionCache = new Map();
function sectionKey() {
  let session = '-';
  try { session = String(currentSessionId() ?? '-'); } catch { /* no initiator yet */ }
  return `${session}|${visibleScopes().join(',')}`;
}
function cachedSection(key) {
  const entry = sectionCache.get(key);
  return entry && Date.now() - entry.at < SECTION_CACHE_MS ? entry.text : null;
}
function rememberSection(key, text) { sectionCache.set(key, { at: Date.now(), text }); }
function invalidateSection() { sectionCache.clear(); }
let sectionError = '';
let storeError = '';
let syncError = '';
let migrationError = '';
let migrationPhase = 'idle';

/** Keep the first line plus the stack head; never let a failure be silent. */
function describeError(error) {
  const message = String(error?.message ?? error);
  const stack = String(error?.stack ?? '').split('\n').slice(1, 4).join(' | ');
  return stack ? `${message} ⏐ ${stack}` : message;
}
let liveSessionIds = () => [];
let currentSessionId = () => undefined;
let sessionQuery = null;
const titleSyncAt = new Map();

/**
 * The harness owns the real titles; this database only mirrors them.
 * Every entry is keyed by session id, which is exactly what sessionQuery takes.
 */
async function syncTitlesInner(ids) {
  if (!sessionQuery || !ids.length) return 0;
  let changed = 0;
  try {
    const results = await sessionQuery.readTitleSnapshots(ids);
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const title = result.value?.title?.title;
      if (!title) continue;
      store.index.run('UPDATE sessions SET title = ? WHERE session_id = ?', [title, result.sessionId]);
      titleSyncAt.set(String(result.sessionId), Date.now());
      changed += 1;
    }
    if (changed) invalidateSection();
  } catch (error) {
    syncError = `syncTitles: ${describeError(error)}`;
  }
  return changed;
}

/** Move one conversation's database (and its WAL companions) out of the main folder. */
function moveToArchive(row) {
  if (row.folder === 'archive') return true;
  const destDir = join(store.dir, 'archive');
  mkdirSync(destDir, { recursive: true });
  const db = store.sessions.get(row.session_id);
  if (db) {
    db.close();
    store.sessions.delete(row.session_id);
  }
  const source = sessionPath(row);
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${source}${suffix}`;
    if (!existsSync(from)) continue;
    try {
      moveFile(from, join(destDir, `${row.file_name}${suffix}`));
    } catch {
      return false;
    }
  }
  store.index.run("UPDATE sessions SET folder = 'archive' WHERE session_id = ?", [row.session_id]);
  return true;
}

/** Subagent sessions write too; they are never the user's conversation. */
async function syncKindsInner() {
  if (!sessionQuery) return;
  try {
    const records = await sessionQuery.listSessions();
    for (const record of records) {
      const id = String(record.header?.id ?? '');
      if (!id) continue;
      const kind = record.header?.origin === 'subagent' ? 'subagent' : 'user';
      store.index.run(
        'UPDATE sessions SET kind = ? WHERE session_id = ? AND kind <> ?',
        [kind, id, kind],
      );
      const cwd = record.header?.cwd ? String(record.header.cwd).trim() : '';
      if (cwd) {
        store.index.run(
          "UPDATE sessions SET cwd = ? WHERE session_id = ? AND ifnull(cwd, '') <> ?",
          [cwd, id, cwd],
        );
      }
      if (kind === 'subagent') {
        const row = sessionRow(id);
        if (row && row.folder !== 'archive') {
          try {
            moveToArchive(row);
          } catch {
            /* retried on the next start */
          }
        }
      }
    }
  } catch (error) {
    syncError = `syncKinds: ${describeError(error)}`;
  }
}

/**
 * One-time attribution for rows written before scopes existed. A path mentioned
 * in the text wins; a bare preference is global; everything else stays
 * `unclassified` on purpose — guessing would be worse than asking.
 */
function classifyScopes() {
  const projects = store.index.all("SELECT DISTINCT cwd FROM sessions WHERE cwd IS NOT NULL AND cwd <> ''")
    .map((row) => String(row.cwd).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase());
  for (const row of store.index.all("SELECT id, kind, content FROM facts WHERE scope = 'unclassified'")) {
    const text = String(row.content).toLowerCase();
    let scope = projects.find((project) => text.includes(project) || text.includes(project.replace(/\//g, '\\'))) ?? null;
    if (!scope && row.kind === 'preference') scope = 'global';
    if (scope) store.index.run('UPDATE facts SET scope = ? WHERE id = ?', [scope, row.id]);
  }
  const orphanHandoffs = store.index.all(
    `SELECT h.id, s.cwd FROM handoffs h LEFT JOIN sessions s ON s.session_id = h.session_id
     WHERE h.scope IS NULL`,
  );
  for (const row of orphanHandoffs) {
    const scope = row.cwd
      ? String(row.cwd).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      : 'unclassified';
    store.index.run('UPDATE handoffs SET scope = ? WHERE id = ?', [scope, row.id]);
  }
}

/** One title refresh per conversation per minute, on the write path. */
function maybeRefreshTitle(sessionId) {
  if (!sessionQuery) return;
  const last = titleSyncAt.get(sessionId) ?? 0;
  if (Date.now() - last < 60_000) return;
  titleSyncAt.set(sessionId, Date.now());
  void (async () => {
    // The task may outlive the recorder call that scheduled it, so it takes its
    // own admission slot and gives it back when the write is done.
    if (!coordinator.admit()) return;
    try {
      const snapshot = await sessionQuery.readTitle(sessionId);
      const title = snapshot?.title;
      if (title) {
        store.index.run('UPDATE sessions SET title = ? WHERE session_id = ?', [title, sessionId]);
        invalidateSection();
      }
    } catch {
      /* keep the previous title */
    } finally {
      coordinator.leave();
    }
  })();
}

/** The conversation asking right now; falls back to the live set when the
 *  driver cannot attribute the call. */
function excludedSessionIds() {
  const current = currentSessionId();
  if (current) return [String(current)];
  return liveSessionIds().filter(Boolean);
}

function recentForeignMessages(limit = 6) {
  // The conversation currently being answered must not echo its own tail back.
  const live = excludedSessionIds();
  const placeholders = live.map(() => '?').join(', ');
  const filter = placeholders ? ` AND session_id NOT IN (${placeholders})` : '';
  const rows = store.index.all(
    `SELECT * FROM sessions WHERE message_count > 0${filter} ORDER BY last_write_at DESC LIMIT 3`,
    live,
  );
  const collected = [];
  for (const row of rows) {
    try {
      const messages = sessionDb(row).all(
        'SELECT role, text, created_at FROM messages ORDER BY id DESC LIMIT ?', [limit],
      );
      for (const message of messages.reverse()) {
        collected.push({ ...message, title: row.title, sessionId: row.session_id });
      }
    } catch {
      /* an unreadable file must not break the prompt */
    }
    if (collected.length >= limit) break;
  }
  return collected.slice(-limit);
}

/** Per-kind half-lives: a todo goes stale much faster than a preference. */
const HALF_LIFE_DAYS = {
  preference: 180,
  profile: 180,
  decision: 90,
  fact: 60,
  todo: 14,
};

/**
 * New memories start below the ceiling so retrieval can actually raise them.
 * The old default of 1 made every boost a no-op (`MIN(1, 1 + 0.2)`).
 */
const INITIAL_STRENGTH = 0.6;
const STRENGTH_BOOST = 0.2;

function daysSince(stamp) {
  if (!stamp) return 365;
  const then = Date.parse(String(stamp).replace(' ', 'T'));
  if (!Number.isFinite(then)) return 365;
  return Math.max(0, (Date.now() - then) / 86_400_000);
}

/**
 * Salience answers "is this worth raising right now"; it never answers
 * "is this still true". Decay only reorders, it never hides: recall still
 * finds a cold fact by keyword.
 */
function salience(row) {
  if (Number(row.pinned) === 1) return 1;
  const halfLife = HALF_LIFE_DAYS[row.kind] ?? 60;
  const strength = Number(row.strength ?? 1);
  const decayed = strength * 0.5 ** (daysSince(row.last_used_at || row.updated_at) / halfLife);
  const bonus = (Math.min(9, Number(row.importance ?? 0)) / 9) * 0.3;
  return Math.min(1, decayed + bonus);
}

/**
 * Explicit retrieval is the only thing that earns a boost. The boost applies to
 * the *decayed* value, not the stored one: after one half-life a strength of 1
 * reads 0.5, so retrieval stores 0.7 — not 1. Applying it to the stored value
 * would let a single read erase any amount of forgetting.
 */
function bumpUse(ids) {
  const now = timeStamp();
  for (const id of ids) {
    const row = store.index.all(
      'SELECT kind, strength, last_used_at, updated_at FROM facts WHERE id = ?',
      [id],
    )[0];
    if (!row) continue;
    const halfLife = HALF_LIFE_DAYS[row.kind] ?? 60;
    const decayed = Number(row.strength ?? INITIAL_STRENGTH)
      * 0.5 ** (daysSince(row.last_used_at || row.updated_at) / halfLife);
    const next = Math.min(1, decayed + STRENGTH_BOOST);
    store.index.run(
      'UPDATE facts SET use_count = use_count + 1, last_used_at = ?, strength = ? WHERE id = ?',
      [now, next, id],
    );
  }
}

/** CJK-safe shingles; two-character overlap works without a tokenizer. */
function shingles(text) {
  const clean = String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const out = new Set();
  for (const chunk of clean.split(/\s+/)) {
    if (!chunk) continue;
    if (chunk.length <= 2) out.add(chunk);
    else for (let i = 0; i < chunk.length - 1; i += 1) out.add(chunk.slice(i, i + 2));
  }
  return out;
}

function relevance(content, userShingles) {
  if (!userShingles || userShingles.size === 0) return 0;
  const fact = shingles(content);
  if (fact.size === 0) return 0;
  let hit = 0;
  for (const gram of fact) if (userShingles.has(gram)) hit += 1;
  return hit / Math.sqrt(fact.size);
}

/** The user's current message, per session, captured by `agent/pre-step`. */
const lastUserText = new Map();

/** Highest message id this session had when the prompt was last assembled. */
const seenWatermark = new Map();

/** Stable project identity: the workspace path, normalised. */
function projectOf(sessionId) {
  if (!sessionId) return null;
  const row = sessionRow(String(sessionId));
  const cwd = row?.cwd ? String(row.cwd).trim() : '';
  if (!cwd) return null;
  return cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function currentProject() {
  try {
    return projectOf(currentSessionId());
  } catch {
    return null;
  }
}

/**
 * Reads default to "this project plus global". `unclassified` is deliberately
 * NOT here: a memory of unknown origin must not leak into every project just
 * because nobody sorted it yet. It stays reachable by asking for it.
 */
function visibleScopes() {
  const project = currentProject();
  return [...new Set(['global', project].filter(Boolean))];
}

function renderSectionInner() {
  try {
    ensureStore();
  } catch (error) {
    sectionError = `存储不可用：${String(error?.message ?? error)}`;
    return '';
  }

  const lines = [];
  lines.push('## 长期记忆（本机数据库，跨会话有效）');
  lines.push('');
  lines.push('下面的事实、交接和对话片段来自数据库，不是上一轮对话的残留。');
  lines.push('新会话开始时用户不会重述历史：直接接着做，不要从头问起。');
  lines.push('用户给出长期信息时用 memory save；阶段完成或对话将结束时用 memory handoff；需要旧细节用 memory recall。');
  lines.push('');

  try {
    const readable = visibleScopes();
    const readablePh = readable.map(() => '?').join(', ');
    const facts = store.index.all(
      `SELECT id, kind, content, importance, pinned, strength, last_used_at, updated_at
       FROM facts WHERE pinned = 1 AND superseded_by IS NULL AND scope IN (${readablePh})`,
      readable,
    )
      .map((row) => ({ ...row, score: salience(row) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
    lines.push('### 常驻记忆');
    lines.push(facts.length
      ? facts.map((row) => `- [${row.kind}] ${row.content}`).join('\n')
      : '（空）');
    lines.push('');

    // Relevance-ranked candidates: one line each, full text only on demand.
    const candidateOwner = currentSessionId();
    const userText = candidateOwner ? lastUserText.get(candidateOwner) : '';
    if (userText) {
      const grams = shingles(userText);
      const candidates = store.index.all(
        `SELECT id, kind, content, importance, pinned, strength, last_used_at, updated_at
         FROM facts WHERE pinned = 0 AND superseded_by IS NULL AND scope IN (${readablePh})`,
        readable,
      )
        .map((row) => ({ row, rel: relevance(row.content, grams) }))
        .filter((item) => item.rel > 0)
        .map((item) => ({ ...item, score: item.rel * (0.5 + salience(item.row)) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 6);
      if (candidates.length) {
        lines.push('### 可能相关的记忆（命中度 × 显著性，只给摘要）');
        lines.push(candidates.map(({ row }) => {
          const one = String(row.content).replace(/\s+/g, ' ').slice(0, 70);
          return `#${row.id} [${row.kind}] ${one}`;
        }).join('\n'));
        lines.push('要看原文：memory(action="read", id=<编号>)');
        lines.push('');
      }
    }

    const recentHandoffs = store.index.all(
      `SELECT id, created_at, title, summary, next_steps FROM handoffs
       WHERE COALESCE(scope, 'unclassified') IN (${readablePh}) ORDER BY id DESC LIMIT 2`,
      readable,
    );
    // Older handoffs still earn a slot when they match what the user just asked;
    // the two newest are always kept as "what happened last".
    const relatedHandoffs = [];
    if (userText && recentHandoffs.length) {
      const grams = shingles(userText);
      const cutoff = recentHandoffs[recentHandoffs.length - 1].id;
      const older = store.index.all(
        `SELECT id, created_at, title, summary, next_steps FROM handoffs
         WHERE id < ? AND COALESCE(scope, 'unclassified') IN (${readablePh}) ORDER BY id DESC LIMIT 100`,
        [cutoff, ...readable],
      );
      for (const row of older) {
        if (relevance(`${row.summary} ${row.next_steps ?? ''}`, grams) > 0) {
          relatedHandoffs.push({ ...row, related: true });
        }
        if (relatedHandoffs.length >= 2) break;
      }
    }
    const handoffs = [...recentHandoffs, ...relatedHandoffs];
    lines.push('### 最近交接');
    lines.push(handoffs.length
      ? handoffs.map((row) => {
        const head = `- ${row.created_at}${row.title ? ` · ${row.title}` : ''}${row.related ? ' · 与当前问题相关' : ''}：${row.summary}`;
        return row.next_steps ? `${head}\n  下一步：${row.next_steps}` : head;
      }).join('\n')
      : '（空）');
    lines.push('');

    // Staleness: a handoff that predates this conversation's recent tail no
    // longer describes what is going on, and nothing else would notice.
    const owner = currentSessionId();
    if (owner) {
      // Coverage, not wall-clock: a handoff is stale when this conversation has
      // messages newer than the cursor it recorded.
      const lastMine = store.index.all(
        `SELECT id, created_at, covered_upto FROM handoffs
         WHERE (session_id = ? OR session_id IS NULL)
           AND COALESCE(scope, 'unclassified') IN (${readablePh})
         ORDER BY id DESC LIMIT 1`,
        [owner, ...readable],
      )[0];
      const row = sessionRow(owner);
      if (row) {
        let db = null;
        let total = 0;
        let since = 0;
        let covered = 0;
        let maxId = 0;
        try {
          db = sessionDb(row);
          total = Number(db.all('SELECT count(*) AS n FROM messages')[0]?.n ?? 0);
          maxId = Number(db.all('SELECT ifnull(max(id), 0) AS m FROM messages')[0]?.m ?? 0);
          covered = Number(lastMine?.covered_upto ?? 0);
          since = Number(db.all('SELECT count(*) AS n FROM messages WHERE id > ?', [covered])[0]?.n ?? 0);
        } catch {
          since = 0;
        }
        // What the model actually saw when it wrote its summary: the highest id
        // present at render time, so later arrivals stay uncovered.
        seenWatermark.set(owner, maxId);
        const pending = Number(row.handoff_pending ?? 0);
        if (pending === 2) {
          lines.push('### 交接待更新（上次写入失败）');
          lines.push('上一次交接没有落盘，旧交接仍然有效。请重新调用 memory(action="handoff")。');
          lines.push('');
        } else if (since >= 12) {
          const from = Number(row.unsummarized_from ?? 0) || (covered + 1);
          lines.push('### 交接待更新');
          lines.push(!lastMine
            ? `本对话已有 ${total} 条消息，但还没有任何交接记录。`
            : covered > 0
              ? `上次交接（${lastMine.created_at}）覆盖到第 ${covered} 条，之后又积累了 ${since} 条（共 ${total} 条），阶段结论可能已经变化。`
              : `本对话共 ${total} 条消息，还没有被任何交接覆盖过。`);
          lines.push(`其中第 ${from}..${maxId} 条尚未被任何摘要覆盖；这些原文仍在库里，可用 recall 取回。`);
          lines.push('建议现在调用 memory(action="handoff", summary=..., next_steps=...) 更新一次，再继续别的工作。');
          if (since >= 24) {
            lines.push('（已超过 24 条：系统只会记录"未总结区间"，不会替你生成摘要，也不会清除待更新状态。）');
          }
          lines.push('');
          if (!pending) {
            store.index.run('UPDATE sessions SET handoff_pending = 1 WHERE session_id = ?', [owner]);
          }
        } else if (pending === 1 && !row.unsummarized_from) {
          // A handoff landed (or the gap shrank): the reminder has served its purpose.
          store.index.run('UPDATE sessions SET handoff_pending = 0 WHERE session_id = ?', [owner]);
        }

        // Safety net for a model that keeps ignoring the reminder: remember WHICH
        // messages are unsummarized. This never advances the summary watermark and
        // never clears "pending" — a range is not a handoff.
        if (since >= 24 && pending !== 2 && !row.unsummarized_from) {
          try {
            store.index.run(
              'UPDATE sessions SET unsummarized_from = ? WHERE session_id = ?',
              [covered + 1, owner],
            );
          } catch {
            /* best effort; the nudge already says what is missing */
          }
        }
      }
    }

    const recent = recentForeignMessages(6);
    if (recent.length) {
      lines.push('### 其它对话的最近片段');
      lines.push(recent.map((message) => {
        const who = message.role === 'user' ? '用户' : '我';
        const text = message.text.replace(/\s+/g, ' ').slice(0, 200);
        return `${who}：${text}`;
      }).join('\n'));
      lines.push('');
    }

    // The conversation the user pinned in the composer is rendered last on
    // purpose: it is the freshest instruction in the prompt, and it must read
    // as an instruction, not as background data.
    const me = currentSessionId();
    if (me) {
      const mine = store.index.all('SELECT focus_session FROM sessions WHERE session_id = ?', [me]);
      const focusId = mine[0]?.focus_session;
      if (focusId) {
        const target = sessionRow(focusId);
        if (target) {
          const picked = sessionDb(target).all(
            'SELECT role, text FROM messages ORDER BY id DESC LIMIT 8',
          ).reverse();
          lines.push('### 接续这段对话（用户已选中，默认接着它继续）');
          lines.push('用户主动把下面这段对话指定为当前上下文。规则：');
          lines.push('- 不要问“我们之前聊到哪了”“你想继续什么”，也不要说自己没有上下文。');
          lines.push('- 用户只说“继续”“然后呢”这类短句时，直接接着这里未完成的动作往下做。');
          lines.push('- 只有用户明确换话题时，才放下它。');
          lines.push(`来源：${target.started_at.slice(5, 16)} · ${target.title || '未命名'}（共 ${target.message_count} 条）`);
          const first = sessionDb(target).all(
            "SELECT text FROM messages WHERE role = 'user' ORDER BY id ASC LIMIT 1",
          );
          if (first.length) {
            lines.push(`这段在做什么：${first[0].text.replace(/\s+/g, ' ').slice(0, 80)}`);
          }
          if (picked.length) {
            lines.push(picked.map((message) => {
              const who = message.role === 'user' ? '用户' : '我';
              return `${who}：${message.text.replace(/\s+/g, ' ').slice(0, 260)}`;
            }).join('\n'));
          } else {
            lines.push('（这段记忆还没有消息）');
          }
          lines.push('');
        }
      }
    }
  } catch (error) {
    sectionError = `渲染失败：${String(error?.message ?? error)}`;
    return '';
  }

  const text = lines.join('\n').trimEnd();
  return text;
}

/* ------------------------------------------------------------------ */
/* memory tool                                                          */
/* ------------------------------------------------------------------ */

function describeSessions() {
  const rows = store.index.all('SELECT * FROM sessions ORDER BY started_at DESC LIMIT 20');
  if (!rows.length) return '还没有任何对话记录。';
  return rows.map((row) => {
    const mb = (row.size_bytes / MB).toFixed(2);
    return `- ${row.started_at} · ${row.title || '未命名'} · ${row.message_count} 条 / ${mb} MB · ${row.file_name}`;
  }).join('\n');
}

function hitScore(text, terms) {
  let score = 0;
  for (const term of terms) if (text.includes(term)) score += 1;
  return score;
}

function snippetAround(text, terms, before = 28, after = 88) {
  const positions = terms.map((term) => text.indexOf(term)).filter((index) => index >= 0);
  const first = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, first - before);
  const end = Math.min(text.length, first + after);
  const body = text.slice(start, end).replace(/\s+/g, ' ');
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

const memoryTool = {
  name: 'memory',
  description: [
    '跨会话长期记忆。写进去的内容会存到本机 SQLite，并在每个新会话自动加载，所以新对话能直接接上进度。',
    '',
    '用法：',
    '- 用户提到值得长期保留的信息（身份、偏好、项目背景、约定、决定）→ save。',
    '- 一个阶段做完，或这段对话即将结束、上下文快满 → handoff，写清结论和下一步。',
    '- 需要旧对话里的具体细节 → recall 搜索，或 history 看最近消息。',
    '- 不确定记过什么 → list 或 status。',
    '',
    '约定：记忆默认按项目隔离，读取时自动带上"当前项目 + 全局"；不要写入密码、token 等敏感信息；同一个 key 在**同一作用域内**重复 save 会取代旧值。',
  ].join('\n'),
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: ['save', 'recall', 'read', 'list', 'forget', 'pin', 'handoff', 'history', 'status'],
        description: 'save 写入新版本；recall 按关键词搜索（多个词用空格分开，会同时查事实、交接和历史对话原文，默认跳过当前对话）；read 按 id 读一条记忆全文；list 按时间列出；forget 删除；pin 设为常驻（每次会话都注入）；handoff 写交接摘要；history 看上一段对话；status 看存储统计。',
      },
      content: { type: 'string', description: '记忆正文。save 必填，写成能独立理解的完整句子（新会话看不到当前上下文）。' },
      key: { type: 'string', description: '稳定标识，例如“当前项目”。相同 kind + key 再次 save 会取代旧版本：新版生效，旧版保留以便追溯。' },
      kind: { type: 'string', enum: ['fact', 'preference', 'decision', 'todo', 'profile'], description: '记忆类别，默认 fact。' },
      importance: { type: 'integer', description: '0-9，越大越靠前，默认 0。' },
      pinned: { type: 'boolean', description: '是否常驻注入，默认 false。常驻条目建议控制在 20 条以内。' },
      query: { type: 'string', description: 'recall 的搜索关键词，多个词用空格分开。' },
      scope: { type: 'string', description: '记忆作用域：global 表示全局，或项目路径。save 时默认当前项目；recall 时默认「当前项目 + global」。' },
      includeSelf: { type: 'boolean', description: 'recall 是否也搜索当前这段对话，默认 false。' },
      limit: { type: 'integer', description: '返回条数，默认 10。' },
      id: { type: 'integer', description: 'forget / pin 的目标 id。' },
      summary: { type: 'string', description: 'handoff 正文：做了什么、结论是什么。' },
      next_steps: { type: 'string', description: 'handoff 的下一步计划。' },
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        action: { type: 'string' },
        detail: { type: 'string' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.detail }],
  },
  timeoutMs: 30000,
  isConcurrencySafe: () => false,
  presentCall: (args) => ({ card: 'generic', title: `memory · ${args?.action ?? '?'}`, kind: 'execute', rawInput: args }),
  async execute(args) {
    if (!coordinator.admit()) {
      const state = coordinator.status();
      return {
        ok: false,
        action: String(args?.action ?? ''),
        detail: state.mode === 'closed'
          ? '存储不可用：上次迁移恢复未完成，请用 memory status 查看错误。'
          : '存储正在迁移，请稍后重试。',
      };
    }
    try {
      return await this._execute(args);
    } finally {
      coordinator.leave();
    }
  },
  async _execute(args) {
    ensureStore();
    const action = String(args?.action ?? '');

    if (action === 'save') {
      const content = String(args?.content ?? '').trim();
      if (!content) throw new Error('content 不能为空');
      const kind = String(args?.kind ?? 'fact');
      const key = args?.key ? String(args.key).trim() : null;
      const importance = Math.max(0, Math.min(9, Number(args?.importance ?? 0) || 0));
      const askedPinned = typeof args?.pinned === 'boolean' ? (args.pinned ? 1 : 0) : null;
      const now = timeStamp();
      // Writes land in the current project unless the caller says otherwise.
      const scope = String(args?.scope ?? '').trim() || currentProject() || 'global';

      const previous = key
        ? store.index.all(
          'SELECT id, content, pinned FROM facts WHERE kind = ? AND key = ? AND scope = ? AND superseded_by IS NULL',
          [kind, key, scope],
        )[0]
        : undefined;

      // Same key, same wording: refresh metadata only. A real change starts a
      // new revision and supersedes the old one, so the history stays readable.
      const unchanged = previous && previous.content.trim() === content;
      const pinned = askedPinned ?? (unchanged ? previous.pinned : (previous?.pinned ?? 0));

      if (unchanged) {
        store.index.run(
          'UPDATE facts SET importance = ?, pinned = ?, updated_at = ? WHERE id = ?',
          [importance, pinned, now, previous.id],
        );
        invalidateSection();
        return { ok: true, action, detail: `#${previous.id} 内容未变，只更新了元数据（${kind}/${key}）。` };
      }

      // Write the starting strength explicitly: databases created by older
      // versions have `DEFAULT 1`, and relying on the column default would keep
      // every new memory pinned at the ceiling.
      store.index.run(
        'INSERT INTO facts (kind, key, content, importance, pinned, strength, created_at, updated_at, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [kind, key, content, importance, pinned, INITIAL_STRENGTH, now, now, scope],
      );
      const id = store.index.all('SELECT last_insert_rowid() AS id')[0]?.id;
      if (previous) {
        store.index.run('UPDATE facts SET superseded_by = ? WHERE id = ?', [id, previous.id]);
      }
      invalidateSection();
      return {
        ok: true,
        action,
        detail: previous
          ? `已写入 #${id}（${kind}/${key}），旧版本 #${previous.id} 标记为被取代：${content}`
          : `已保存 #${id}（${kind}${key ? `/${key}` : ''}）：${content}`,
      };
    }

    if (action === 'recall') {
      const query = String(args?.query ?? '').trim();
      if (!query) throw new Error('query 不能为空');
      const limit = Math.max(1, Math.min(50, Number(args?.limit ?? 10) || 10));
      // Terms are matched independently: "迁移 目录" must find a record that
      // contains both words apart, not only the exact phrase.
      const terms = [...new Set(query.split(/\s+/).filter(Boolean))].slice(0, 8);

      const recallScopes = args?.scope
        ? [...new Set([String(args.scope).trim(), 'global'])]
        : visibleScopes();
      const recallPh = recallScopes.map(() => '?').join(', ');
      const facts = store.index.all(
        `SELECT id, kind, content, key, scope, pinned, importance, strength, last_used_at, updated_at
         FROM facts WHERE superseded_by IS NULL AND scope IN (${recallPh})`,
        recallScopes,
      )
        .map((row) => ({ ...row, score: hitScore(`${row.content} ${row.kind} ${row.key ?? ''}`, terms) }))
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score
          || (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1)
          || b.importance - a.importance)
        .slice(0, limit);
      if (facts.length) bumpUse(facts.map((row) => row.id));

      const handoffs = store.index.all(
        `SELECT id, created_at, summary, next_steps FROM handoffs
         WHERE COALESCE(scope, 'unclassified') IN (${recallPh})`,
        recallScopes,
      )
        .map((row) => ({ ...row, score: hitScore(`${row.summary} ${row.next_steps ?? ''}`, terms) }))
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score || b.id - a.id)
        .slice(0, limit);

      // Every conversation with messages is searched. The result count is
      // bounded later, but the search scope is not: silently skipping old
      // databases reads like forgetting, when it is really not looking.
      const includeSelf = args?.includeSelf === true;
      const skipped = includeSelf ? [] : excludedSessionIds();
      const placeholders = skipped.map(() => '?').join(', ');
      const skipFilter = placeholders ? ` AND session_id NOT IN (${placeholders})` : '';
      const hits = [];
      const scopeFilter = transcriptScope(args?.scope);
      let sessions = store.index.all(
        `SELECT * FROM sessions WHERE message_count > 0${skipFilter} ORDER BY last_write_at DESC`,
        skipped,
      );
      if (scopeFilter.kind === 'unclassified') {
        sessions = sessions.filter((row) => !normalizeProject(row.cwd));
      } else if (scopeFilter.kind === 'project' && scopeFilter.cwd) {
        sessions = sessions.filter((row) => normalizeProject(row.cwd) === scopeFilter.cwd);
      } else {
        sessions = [];
      }
      // Matching is pushed into SQL so no per-database row cap is needed.
      const safeTerms = terms.map((term) => term.replace(/[%_]/g, ''));
      const matchClause = safeTerms.map(() => 'text LIKE ?').join(' OR ');
      let scanned = 0;
      const unreadable = [];
      for (const row of sessions) {
        scanned += 1;
        let messages = [];
        try {
          messages = sessionDb(row).all(
            `SELECT role, text, created_at FROM messages WHERE ${matchClause} ORDER BY id DESC`,
            safeTerms.map((term) => `%${term}%`),
          );
        } catch (error) {
          unreadable.push(`${row.file_name}: ${String(error?.message ?? error).slice(0, 60)}`);
          continue;
        }
        for (const message of messages) {
          const score = hitScore(message.text, terms);
          if (score > 0) hits.push({ session: row, message, score });
        }
      }
      hits.sort((a, b) => b.score - a.score || (a.message.created_at < b.message.created_at ? 1 : -1));
      const scope = `（已搜索 ${scanned} 个对话库${unreadable.length ? `，${unreadable.length} 个读取失败：${unreadable[0]}` : ''}）`;

      const chunks = [];
      if (facts.length) {
        chunks.push(`【事实与偏好】\n${facts.map((row) => `#${row.id} [${row.kind}] ${row.content}`).join('\n')}`);
      }
      if (handoffs.length) {
        chunks.push(`【交接】\n${handoffs.map((row) => `${row.created_at}：${row.summary}${row.next_steps ? ` / 下一步：${row.next_steps}` : ''}`).join('\n')}`);
      }
      if (hits.length) {
        chunks.push(`【对话原文】\n${hits.slice(0, Math.max(4, Math.min(8, limit))).map(({ session, message }) => {
          const when = message.created_at.slice(11, 16);
          const who = message.role === 'user' ? '用户' : '我';
          return `· ${session.started_at.slice(5, 16)} ${session.title || '未命名'} · ${who} ${when}\n  ${snippetAround(message.text, terms)}`;
        }).join('\n')}`);
      }
      return {
        ok: true,
        action,
        detail: chunks.length
          ? `${chunks.join('\n\n')}\n\n${scope}`
          : `没有匹配「${query}」的记忆或对话原文。${scope}${includeSelf ? '' : '\n（已跳过当前对话；要连本对话一起搜，加 includeSelf: true）'}`,
      };
    }

    if (action === 'read') {
      const id = Number(args?.id);
      if (!Number.isInteger(id)) throw new Error('需要 id');
      const rows = store.index.all('SELECT * FROM facts WHERE id = ?', [id]);
      if (!rows.length) throw new Error(`没有 #${id}`);
      const row = rows[0];
      bumpUse([row.id]);
      invalidateSection();
      const fresh = store.index.all(
        'SELECT use_count, strength, last_used_at FROM facts WHERE id = ?', [id],
      )[0] ?? row;
      const head = `#${row.id} [${row.kind}${row.key ? `/${row.key}` : ''}]${Number(row.pinned) === 1 ? ' 📌' : ''}`;
      const meta = `显著性 ${Number(fresh.strength ?? 1).toFixed(2)} · 取用 ${fresh.use_count ?? 0} 次 · 最近 ${fresh.last_used_at ?? '从未'} · 更新 ${row.updated_at}`;
      const superseded = row.superseded_by ? `\n⚠ 已被 #${row.superseded_by} 取代，仅供追溯。` : '';
      return { ok: true, action, detail: `${head}\n${row.content}\n${meta}${superseded}` };
    }

    if (action === 'list') {
      const limit = Math.max(1, Math.min(100, Number(args?.limit ?? 20) || 20));
      const listed = visibleScopes();
      const listedPh = listed.map(() => '?').join(', ');
      const rows = store.index.all(
        `SELECT id, kind, key, content, pinned, scope FROM facts
         WHERE superseded_by IS NULL AND scope IN (${listedPh})
         ORDER BY updated_at DESC LIMIT ?`,
        [...listed, limit],
      );
      if (!rows.length) return { ok: true, action, detail: '记忆库还是空的。' };
      return {
        ok: true,
        action,
        detail: rows.map((row) => `#${row.id}${row.pinned ? ' 📌' : ''} [${row.kind}${row.key ? `/${row.key}` : ''}] ${row.content}`).join('\n'),
      };
    }

    if (action === 'forget') {
      const id = Number(args?.id);
      if (!Number.isInteger(id)) throw new Error('需要 id');
      store.index.run('DELETE FROM facts WHERE id = ?', [id]);
      invalidateSection();
      return { ok: true, action, detail: `已删除 #${id}。` };
    }

    if (action === 'pin') {
      const id = Number(args?.id);
      if (!Number.isInteger(id)) throw new Error('需要 id');
      const pinned = args?.pinned === false ? 0 : 1;
      store.index.run('UPDATE facts SET pinned = ?, updated_at = ? WHERE id = ?', [pinned, timeStamp(), id]);
      invalidateSection();
      return { ok: true, action, detail: pinned ? `#${id} 已设为常驻。` : `#${id} 已取消常驻。` };
    }

    if (action === 'handoff') {
      const summary = String(args?.summary ?? '').trim();
      if (!summary) throw new Error('summary 不能为空');
      const nextSteps = args?.next_steps ? String(args.next_steps).trim() : null;
      const me = currentSessionId();
      let covered = 0;
      if (me) {
        const row = sessionRow(me);
        if (row) {
          try {
            const currentMax = Number(sessionDb(row).all('SELECT ifnull(max(id), 0) AS m FROM messages')[0]?.m ?? 0);
            // Never claim coverage beyond what the prompt actually carried: a
            // message that arrived after the last assembly stays uncovered.
            const seen = seenWatermark.get(me);
            covered = seen == null ? currentMax : Math.min(Number(seen), currentMax);
          } catch {
            covered = 0;
          }
        }
      }
      try {
        store.index.run(
          `INSERT INTO handoffs (session_id, title, summary, next_steps, created_at, covered_upto, scope)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [me ?? null, null, summary, nextSteps, timeStamp(), covered, currentProject() || 'global'],
        );
        if (me) {
          store.index.run(
            'UPDATE sessions SET handoff_pending = 0, unsummarized_from = NULL WHERE session_id = ?',
            [me],
          );
        }
      } catch (error) {
        // The old handoff stays authoritative; the pending flag keeps shouting.
        if (me) {
          try {
            store.index.run('UPDATE sessions SET handoff_pending = 2 WHERE session_id = ?', [me]);
          } catch {
            /* nothing more we can do */
          }
        }
        throw new Error(`交接写入失败，旧交接仍然有效：${error?.message ?? error}`);
      }
      invalidateSection();
      return {
        ok: true,
        action,
        detail: `已记录交接，覆盖到本对话第 ${covered} 条消息：${summary}${nextSteps ? `\n下一步：${nextSteps}` : ''}`,
      };
    }

    if (action === 'history') {
      const limit = Math.max(1, Math.min(50, Number(args?.limit ?? 20) || 20));
      const live = excludedSessionIds();
      const placeholders = live.map(() => '?').join(', ');
      const filter = placeholders ? ` AND session_id NOT IN (${placeholders})` : '';
      const historyProject = currentProject();
      const sessions = store.index.all(
        `SELECT * FROM sessions WHERE message_count > 0${filter} ORDER BY last_write_at DESC`,
        live,
      ).filter((row) => historyProject && normalizeProject(row.cwd) === historyProject).slice(0, 1);
      if (!sessions.length) {
        return { ok: true, action, detail: '本项目里除了当前这段对话，还没有其它对话记录。' };
      }
      const row = sessions[0];
      const messages = sessionDb(row).all(
        'SELECT role, text, created_at FROM messages ORDER BY id DESC LIMIT ?', [limit],
      ).reverse();
      return {
        ok: true,
        action,
        detail: `上一段对话「${row.title || '未命名'}」（${row.message_count} 条，始于 ${row.started_at}）：\n`
          + messages.map((message) => `${message.role === 'user' ? '用户' : '我'}：${message.text.slice(0, 300)}`).join('\n'),
      };
    }

    if (action === 'status') {
      const data = overview();
      const unclassifiedFacts = Number(
        store.index.all("SELECT count(*) AS n FROM facts WHERE scope = 'unclassified'")[0]?.n ?? 0,
      );
      const unclassifiedHandoffs = Number(
        store.index.all("SELECT count(*) AS n FROM handoffs WHERE scope = 'unclassified' OR scope IS NULL")[0]?.n ?? 0,
      );
      const lines = [
        `存储目录：${data.dir}`,
        `默认上限：${data.defaultLimit} 条 / 单库 ${data.sizeLimitMB} MB`,
        `当前项目：${currentProject() || '（未知，只读全局）'}`,
        `共 ${data.totals.sessions} 个对话，${data.totals.messages} 条文本，${(data.totals.bytes / MB).toFixed(2)} MB`,
        `未分类：事实 ${unclassifiedFacts} 条、交接 ${unclassifiedHandoffs} 条（默认不注入，recall 时加 scope="unclassified" 可查）`,
        `提示注入：${sectionError || '正常'}`,
        storeError ? `存储错误：${storeError}` : '',
        syncError ? `同步错误：${syncError}` : '',
        migrationError ? `迁移错误：${migrationError}` : '',
        `迁移阶段：${migrationPhase}`,
        '',
        describeSessions(),
      ].filter((line) => line !== '');
      return { ok: true, action, detail: lines.join('\n') };
    }

    throw new Error(`unknown action: ${action}`);
  },
};

/* ------------------------------------------------------------------ */
/* HTTP API for the settings page                                       */
/* ------------------------------------------------------------------ */

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1 * MB) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      if (!raw.trim()) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/^\/api\/dsh-memory/, '') || '/';
  try {
    if (req.method === 'GET' && path === '/overview') {
      return sendJson(res, 200, overview());
    }
    if (req.method === 'POST' && path === '/settings') {
      const body = await readBody(req);
      if (Number.isFinite(Number(body.defaultLimit)) && Number(body.defaultLimit) > 0) {
        store.settings.defaultLimit = Math.floor(Number(body.defaultLimit));
        setSetting('default_limit', store.settings.defaultLimit);
      }
      if (Number.isFinite(Number(body.sizeLimitMB)) && Number(body.sizeLimitMB) > 0) {
        store.settings.sizeLimitBytes = Math.floor(Number(body.sizeLimitMB) * MB);
        setSetting('size_limit_mb', Math.round(store.settings.sizeLimitBytes / MB));
      }
      invalidateSection();
      return sendJson(res, 200, { ok: true, overview: overview() });
    }
    if (req.method === 'POST' && path === '/move') {
      const body = await readBody(req);
      const target = resolve(String(body?.dir ?? '').trim());
      const from = store.dir;
      if (!target) return sendJson(res, 400, { ok: false, committed: false, error: '目标目录为空' });
      if (target === resolve(from)) return sendJson(res, 400, { ok: false, committed: false, error: '目标与当前目录相同' });
      if (existsSync(target) && readdirSync(target).length) {
        return sendJson(res, 400, {
          ok: false, committed: false, error: `目标目录已有文件，拒绝迁移：${target}`,
        });
      }
      const journalBefore = readJournal(JOURNAL)?.id ?? null;
      try {
        migrationPhase = 'starting';
        const migrated = await coordinator.beginMigration(async () => {
          migrationPhase = `copying ${from} -> ${target}`;
          closeStore();
          try {
            const result = runMigration({ from, to: target, journalPath: JOURNAL, pointerPath: POINTER });
            migrationPhase = `reopening ${target}`;
            openStore(target);
            return result;
          } catch (error) {
            // committed means the pointer may already point at the target; never
            // reopen the stale source in that case.
            const journalNow = readJournal(JOURNAL);
            const fresh = Boolean(journalNow) && journalNow.id !== journalBefore;
            let pointerNow = null;
            try {
              pointerNow = JSON.parse(readFileSync(POINTER, 'utf8')).dir;
            } catch {
              /* pointer unreadable: rely on the journal */
            }
            error.committed = fresh
              && (journalNow.phase === 'committed' || journalNow.phase === 'done' || pointerNow === target);
            if (!error.committed) {
              migrationPhase = `rollback ${from}`;
              try {
                openStore(from);
              } catch {
                /* the error below is what the caller sees */
              }
            }
            throw error;
          }
        });
        migrationPhase = 'done';
        migrationError = '';
        // A finished migration no longer needs startup recovery.
        finalizeJournal(JOURNAL);
        invalidateSection();
        const replayed = await coordinator.replayQueue();
        return sendJson(res, 200, {
          ok: true, moved: migrated.journal?.files?.length ?? 0, replayed: replayed.replayed, overview: overview(),
        });
      } catch (error) {
        migrationError = `phase=${migrationPhase} · ${describeError(error)}`;
        // Pre-commit failure: the source is still authoritative, so put queued
        // messages back there now instead of waiting for a restart.
        let replayed = 0;
        try {
          replayed = (await coordinator.replayQueue()).replayed;
        } catch {
          /* queue stays on disk for the next start */
        }
        return sendJson(res, error?.committed ? 500 : 400, {
          ok: false, committed: Boolean(error?.committed), replayed, phase: migrationPhase,
          error: String(error?.message ?? error),
        });
      }
    }
    if (req.method === 'GET' && path === '/alerts') {
      return sendJson(res, 200, alertState(url.searchParams.get('session')));
    }
    if (req.method === 'POST' && path === '/ack') {
      const body = await readBody(req);
      const sessionId = String(body.sessionId ?? '').trim();
      const column = body.kind === 'full' ? 'alert100_at' : 'alert90_at';
      if (sessionId) {
        store.index.run(`UPDATE sessions SET ${column} = ? WHERE session_id = ?`, [timeStamp(), sessionId]);
      }
      return sendJson(res, 200, { ok: true, alerts: alertState() });
    }
    if (req.method === 'POST' && path === '/focus') {
      const body = await readBody(req);
      const sessionId = String(body.sessionId ?? '').trim();
      if (!sessionId) throw new Error('缺少 sessionId');
      ensureSession(sessionId);
      const memorySession = body.memorySession ? String(body.memorySession).trim() : null;
      if (memorySession && !sessionRow(memorySession)) throw new Error('找不到这段记忆');
      store.index.run(
        'UPDATE sessions SET focus_session = ? WHERE session_id = ?',
        [memorySession, sessionId],
      );
      invalidateSection();
      return sendJson(res, 200, { ok: true, overview: overview() });
    }
    if (req.method === 'POST' && path === '/session') {
      const body = await readBody(req);
      const sessionId = String(body.sessionId ?? '').trim();
      if (!sessionId) throw new Error('缺少 sessionId');
      ensureSession(sessionId);
      if (Number.isFinite(Number(body.limit)) && Number(body.limit) > 0) {
        // Raising the ceiling starts a fresh alert cycle for this conversation.
        store.index.run(
          'UPDATE sessions SET limit_override = ?, alert90_at = NULL, alert100_at = NULL WHERE session_id = ?',
          [Math.floor(Number(body.limit)), sessionId],
        );
      }
      if (body.state === 'recording' || body.state === 'paused') {
        store.index.run(
          'UPDATE sessions SET state = ?, alert90_at = NULL, alert100_at = NULL WHERE session_id = ?',
          [body.state, sessionId],
        );
      }
      invalidateSection();
      return sendJson(res, 200, { ok: true, overview: overview(), alerts: alertState() });
    }
    return sendJson(res, 404, { error: 'not found' });
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }
}

/* ------------------------------------------------------------------ */
/* Plugin entry                                                         */
/* ------------------------------------------------------------------ */

export function apply(ctx) {
  liveSessionIds = () => {
    try {
      return (ctx.get('agents')?.list() ?? []).map((agent) => String(agent.id));
    } catch {
      return [];
    }
  };
  currentSessionId = () => {
    try {
      const agent = ctx.get('agents')?.currentInitiator();
      return agent?.id ? String(agent.id) : undefined;
    } catch {
      return undefined;
    }
  };
  try {
    sessionQuery = ctx.get('sessionQuery') ?? null;
  } catch {
    sessionQuery = null;
  }

  try {
    // Recovery runs before anything opens a database: the journal plus the
    // actual pointer decide which directory is authoritative.
    const recovered = recoverMigration({ journalPath: JOURNAL, pointerPath: POINTER });
    let ready = true;
    if (recovered.journal) {
      const action = recovered.action;
      const journal = recovered.journal;
      const targetDriven = action === 'finish' || action === 'repoint';
      if (targetDriven) {
        const dir = recovered.dir;
        const files = recovered.journal.files ?? [];
        const missing = files.filter((relative) => !existsSync(join(dir, relative)));
        const schemaProblem = verifyStorageFull(dir);
        if (!existsSync(join(dir, 'index.db')) || missing.length || schemaProblem) {
          storeError = `迁移目标不完整（${dir}）：${[...(existsSync(join(dir, 'index.db')) ? [] : ['index.db']), ...missing, schemaProblem].filter(Boolean).slice(0, 3).join(', ')}`;
          ready = false;
        } else {
          if (action === 'repoint') writePointer(dir);
          finalizeJournal(JOURNAL);
          migrationPhase = `recovered:${action}`;
        }
      } else if (action === 'rollback-target' || action === 'rollback-pointer') {
        // Rolling back is only safe when the source is provably usable: a
        // missing source must never cost the complete target copy.
        const sourceProblem = verifyStorageFull(journal.from);
        if (sourceProblem) {
          storeError = `源目录不可用（${journal.from}）：${sourceProblem}；目标保留，日志未消费`;
          ready = false;
        } else {
          if (action === 'rollback-target' && journal.to) discardTarget(journal.to, journal.id);
          if (action === 'rollback-pointer') writePointer(journal.from);
          finalizeJournal(JOURNAL);
          migrationPhase = `recovered:${action}`;
        }
      } else {
        storeError = `迁移状态未知（${action}）：请人工检查 ${JOURNAL}`;
        ready = false;
      }
    }
    if (ready) {
      openStore(recovered.dir ?? readPointer() ?? DEFAULT_DIR);
      void coordinator.replayQueue();
    } else {
      // Nothing may lazily open the store while recovery is unresolved.
      coordinator.close();
    }
    if (sessionQuery) {
      const ids = store.index.all('SELECT session_id FROM sessions').map((row) => row.session_id);
      void syncKinds().then(() => {
        try {
          classifyScopes();
        } catch {
          /* attribution is best-effort */
        }
        return syncTitles(ids);
      });
    }
  } catch (error) {
    // A failed first open must not take the host down, but it must be visible:
    // status reports it and every tool call retries the open.
    storeError = describeError(error);
  }

  ctx.effect(() => {
    const disposers = [];
    disposers.push(ctx.tools.register(memoryTool));
    try {
      disposers.push(ctx.systemPrompt.section({ name: 'memory', order: 46, text: () => renderSection() }));
    } catch (error) {
      // A duplicate section name/order must not silently cost the whole
      // injection: retry on a private name and keep the reason visible.
      sectionError = String(error?.message ?? error);
      try {
        disposers.push(ctx.systemPrompt.section({
          name: 'persistent-memory',
          order: 146,
          text: () => renderSection(),
        }));
        sectionError += '（已换名重试成功）';
      } catch (second) {
        sectionError += ` / 重试失败：${String(second?.message ?? second)}`;
      }
    }
    try {
      const gatedApi = async (req, res) => {
        const pathname = String(req?.url ?? '/').split('?')[0];
        if (pathname.endsWith('/move')) return handleApi(req, res); // exclusive slot, not a normal one
        if (pathname.endsWith('/status')) {
          return sendJson(res, 200, {
            ok: true, ...coordinator.status(), migrationPhase, migrationError, storeError, syncError,
          });
        }
        if (!coordinator.admit()) {
          return sendJson(res, 503, { ok: false, migrating: true, mode: coordinator.status().mode });
        }
        try {
          return await handleApi(req, res);
        } finally {
          coordinator.leave();
        }
      };
      disposers.push(ctx.webServer.register({ kind: 'prefix', path: '/api/dsh-memory', handler: gatedApi }));
    } catch {
      /* without the route the tool still works, only the settings page goes quiet */
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* teardown is best-effort */
        }
      }
      invalidateSection();
      // Leave no SQLite handle behind: a reloaded plugin otherwise keeps the
      // old files locked (and blocks moving or deleting them).
      try {
        closeStore();
      } catch {
        /* the store may never have opened */
      }
    };
  });

  ctx.on('session/event', (session, event) => {
    try {
      recordEvent(session, event);
    } catch {
      /* recording must never disturb the conversation */
    }
  });

  // The section provider cannot see the incoming user message, so the relevance
  // input is captured here, where the pre-step payload still carries it.
  ctx.on('agent/pre-step', (payload, next) => {
    try {
      const id = payload?.agent?.id ? String(payload.agent.id) : null;
      if (id) {
        const text = (payload?.messages ?? [])
          .map((message) => messageText(message))
          .filter(Boolean)
          .join('\n')
          .slice(0, 4000);
        if (text && lastUserText.get(id) !== text) {
          lastUserText.set(id, text);
          invalidateSection();
        }
      }
    } catch {
      /* relevance is best-effort; never block the step */
    }
    return next();
  });
}

export const __test = { verifyStorageFull, verifyStorageSchema, state: () => ({ storeError, migrationPhase, dir: store.dir }), maybeRefreshTitle, injectOpenFailure: () => { openFailureOnce = true; }, coordinator, recordEvent, persistMessage, sessionDb, ensureSession, store, ensureStore, recoverMigration, runMigration, paths: { POINTER, JOURNAL, QUEUE, DEFAULT_DIR, HERE } };

const lastKeyBySession = new Map();

function renderSection() {
  let session = '-';
  try {
    session = String(currentSessionId() ?? '-');
  } catch {
    /* no initiator */
  }
  if (!coordinator.admit()) {
    // Never touch the database just to build a cache key while paused.
    const key = lastKeyBySession.get(session);
    return key ? cachedSection(key) ?? '' : '';
  }
  try {
    const key = sectionKey();
    const text = renderSectionInner();
    rememberSection(key, text);
    lastKeyBySession.set(session, key);
    return text;
  } finally {
    coordinator.leave();
  }
}

async function syncTitles(ids) {
  if (!coordinator.admit()) return 0;
  try {
    return await syncTitlesInner(ids);
  } finally {
    coordinator.leave();
  }
}

async function syncKinds() {
  if (!coordinator.admit()) return;
  try {
    await syncKindsInner();
  } finally {
    coordinator.leave();
  }
}
