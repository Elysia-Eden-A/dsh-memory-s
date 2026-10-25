/**
 * dsh-memory — Client half.
 *
 * Two surfaces:
 *   1. Settings → 记忆存储: every conversation database with its text count,
 *      size, occupancy and path, plus the storage directory and limits.
 *   2. A frame-wide overlay: a 90% hint above the composer and a 100% modal
 *      that offers to raise the ceiling or stop recording this conversation.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-memory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    const API = '/api/dsh-memory';

    /** Native folder dialog, supplied by the host through `uiWorkspace`. */
    let pickDirectory = async () => null;

    /** The conversation this window is showing; the composer tells us. */
    let viewSessionId = null;

    /** Survives the section remounting between renders. */
    let archivedOpen = false;

    async function call(path, init) {
      const response = await fetch(API + path, {
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        ...init,
      });
      let data = {};
      try {
        data = await response.json();
      } catch {
        /* an empty body is fine for failures */
      }
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      return data;
    }

    const CSS = `
.dshmem {
  display: flex;
  flex-direction: column;
  gap: 18px;
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  overflow-x: hidden;
  padding: 4px 2px 28px;
  color: var(--dsw-alias-label-primary, #e6e6e6);
  font-size: 13px;
}
.dshmem h3 {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--dsw-alias-label-secondary, #9a9a9a);
  text-transform: uppercase;
}
.dshmem-field { display: flex; align-items: center; gap: 8px; }
.dshmem input {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.14));
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.04));
  color: inherit;
  font: inherit;
  font-size: 12px;
}
.dshmem input:focus {
  outline: none;
  border-color: var(--dsw-alias-brand-primary, #4d6bfe);
}
.dshmem button {
  padding: 7px 14px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.14));
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.06));
  color: inherit;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.dshmem button:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2, rgba(255,255,255,0.28)); }
.dshmem button:disabled { opacity: 0.45; cursor: default; }
.dshmem button.primary {
  background: var(--dsw-alias-brand-primary, #4d6bfe);
  border-color: transparent;
  color: #fff;
}
.dshmem-hint {
  margin: 6px 0 0;
  font-size: 11px;
  line-height: 1.7;
  color: var(--dsw-alias-label-secondary, #9a9a9a);
}
.dshmem-limits { display: flex; gap: 14px; flex-wrap: wrap; align-items: flex-end; }
.dshmem-limits label { display: flex; flex-direction: column; gap: 6px; font-size: 11px; color: var(--dsw-alias-label-secondary, #9a9a9a); }
.dshmem-limits input { width: 120px; flex: none; }
.dshmem-list { display: flex; flex-direction: column; }
.dshmem-item {
  padding: 12px 2px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.07));
}
.dshmem-item:last-child { border-bottom: none; }
.dshmem-item-top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.dshmem-name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshmem-pct { font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.dshmem-item-bar { margin: 9px 0 8px; }
.dshmem-item-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 3px 14px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, #9a9a9a);
  font-variant-numeric: tabular-nums;
}
.dshmem-bar {
  position: relative;
  width: 100%;
  height: 5px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.1));
  overflow: hidden;
}
.dshmem-bar > i {
  display: block;
  height: 100%;
  border-radius: 999px;
  transition: width 0.25s ease;
}
.dshmem-pct { font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.dshmem-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: "Cascadia Mono", Consolas, monospace;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, #9a9a9a);
}
.dshmem-foot {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, #9a9a9a);
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.1));
  padding-top: 10px;
}
.dshmem-error {
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 14%, transparent);
  color: var(--dsw-alias-state-error-primary, #e5484d);
  font-size: 12px;
}
.dshmem-empty { padding: 24px 0; text-align: center; color: var(--dsw-alias-label-secondary, #9a9a9a); }

.dshmem-item-actions { margin-left: auto; display: flex; gap: 6px; }
.dshmem-sub {
  display: block;
  width: 100%;
  margin: 18px 0 2px;
  padding: 9px 2px 5px;
  text-align: left;
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--dsw-alias-label-secondary, #9a9a9a);
  background: transparent;
  border: none;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.12));
  border-radius: 0;
}
.dshmem-sub:hover { color: var(--dsw-alias-label-primary, #e6e6e6); }
.dshmem-picker .group {
  margin-top: 6px;
  padding: 7px 8px;
  border: none;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.12));
  border-radius: 0;
  background: transparent;
  text-align: left;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, #9a9a9a);
}
.dshmem-picker .group:hover { color: var(--dsw-alias-label-primary, #e6e6e6); }
.dshmem-item-actions button.link,
.dshmem-picker button {
  padding: 2px 9px;
  font-size: 11px;
  border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.16));
  background: transparent;
  color: var(--dsw-alias-label-secondary, #9a9a9a);
  cursor: pointer;
  white-space: nowrap;
}
.dshmem-item-actions button.link:hover { color: var(--dsw-alias-label-primary, #e6e6e6); border-color: var(--dsw-alias-border-l2, rgba(255,255,255,0.3)); }

/* ---------- composer memory picker ---------- */
.dshmem-picker { position: relative; display: inline-flex; align-items: center; gap: 4px; }
.dshmem-picker button.chip { padding: 4px 10px; font-size: 12px; }
.dshmem-picker button.chip.active { color: var(--dsw-alias-brand-primary, #4d6bfe); border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.dshmem-picker button.x { padding: 2px 7px; font-size: 12px; }
.dshmem-picker .pop {
  position: absolute;
  bottom: 36px;
  left: 0;
  z-index: 80;
  width: 320px;
  max-height: 360px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-overlay, #1c1c1c);
  border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.22));
  box-shadow: 0 16px 40px rgba(0,0,0,0.4);
}
.dshmem-picker .pop input {
  width: 100%;
  padding: 7px 10px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.16));
  background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.05));
  color: inherit;
  font: inherit;
  font-size: 12px;
}
.dshmem-picker .list { overflow: auto; display: flex; flex-direction: column; gap: 2px; }
.dshmem-picker .item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 7px 8px;
  border: none;
  background: transparent;
  text-align: left;
  border-radius: 8px;
}
.dshmem-picker .item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.08)); }
.dshmem-picker .item .t {
  font-size: 12px;
  color: var(--dsw-alias-label-primary, #e6e6e6);
  max-width: 290px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshmem-picker .item .m { font-size: 11px; color: var(--dsw-alias-label-secondary, #9a9a9a); }
.dshmem-picker .empty { padding: 10px 4px; font-size: 11px; color: var(--dsw-alias-label-secondary, #9a9a9a); }
.dshmem-layer {
  position: fixed;
  inset: 0;
  z-index: 900;
  pointer-events: none;
  font-family: inherit;
}
.dshmem-layer button {
  padding: 7px 14px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.14));
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.06));
  color: inherit;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.dshmem-layer button:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2, rgba(255,255,255,0.3)); }
.dshmem-layer button:disabled { opacity: 0.45; cursor: default; }
.dshmem-layer button.primary {
  background: var(--dsw-alias-brand-primary, #4d6bfe);
  border-color: transparent;
  color: #fff;
}
.dshmem-layer input {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.16));
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.05));
  color: inherit;
  font: inherit;
  font-size: 12px;
}
.dshmem-toast {
  position: fixed;
  left: 50%;
  bottom: 152px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: min(620px, 90vw);
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-overlay, #1c1c1c);
  border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.22));
  box-shadow: 0 8px 28px rgba(0,0,0,0.28);
  color: var(--dsw-alias-label-primary, #e6e6e6);
  font-size: 12px;
  line-height: 1.5;
  pointer-events: auto;
}
.dshmem-toast-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.dshmem-toast-text { flex: 1; min-width: 0; }
.dshmem-backdrop {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.42);
  pointer-events: auto;
}
.dshmem-modal {
  width: 460px;
  max-width: 90vw;
  max-height: 86vh;
  overflow: auto;
  padding: 22px;
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1, #1b1b1b);
  border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.2));
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45);
  color: var(--dsw-alias-label-primary, #e6e6e6);
}
.dshmem-modal h4 { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
.dshmem-modal p {
  margin: 0 0 14px;
  font-size: 12px;
  line-height: 1.75;
  color: var(--dsw-alias-label-secondary, #9a9a9a);
}
.dshmem-modal b { color: var(--dsw-alias-label-primary, #e6e6e6); font-weight: 500; }
.dshmem-actions {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
  margin-top: 18px;
}
.dshmem-actions .grow { flex: 1; min-width: 0; }
.dshmem-actions .group { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.dshmem-layer button.danger {
  color: var(--dsw-alias-state-error-primary, #e5484d);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 42%, transparent);
}
.dshmem-presets { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.dshmem-custom { display: flex; gap: 8px; margin: 12px 0 0; }

`;

    const COLOR = {
      ok: 'var(--dsw-alias-state-success-primary, #30a46c)',
      warn: 'var(--dsw-alias-state-warn-primary, #f5a524)',
      danger: 'var(--dsw-alias-state-error-primary, #e5484d)',
      full: 'var(--dsw-alias-state-error-primary, #e5484d)',
    };

    const MB = 1024 * 1024;

    function short(text, limit = 18) {
      const value = String(text ?? '');
      return value.length > limit ? `${value.slice(0, limit)}…` : value;
    }

    function human(bytes) {
      if (!bytes) return '0 B';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / MB).toFixed(2)} MB`;
    }

    function MemoryPage() {
      const [data, setData] = useState(null);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState('');
      const [dir, setDir] = useState('');
      const [defaultLimit, setDefaultLimit] = useState('10000');
      const [sizeLimitMB, setSizeLimitMB] = useState('50');
      const [showArchived, setShowArchived] = useState(archivedOpen);

      const load = useCallback(async () => {
        try {
          const next = await call('/overview');
          setData(next);
          setDir(next.dir);
          setDefaultLimit(String(next.defaultLimit));
          setSizeLimitMB(String(next.sizeLimitMB));
          setError('');
        } catch (failure) {
          setError(failure.message);
        }
      }, []);

      useEffect(() => { load(); }, [load]);

      const saveSettings = async () => {        setBusy('settings');
        try {
          const next = await call('/settings', {
            method: 'POST',
            body: JSON.stringify({ defaultLimit: Number(defaultLimit), sizeLimitMB: Number(sizeLimitMB) }),
          });
          setData(next.overview);
          setError('');
        } catch (failure) {
          setError(failure.message);
        } finally {
          setBusy('');
        }
      };

      const moveStorage = async () => {
        const target = dir.trim();
        if (!target) return;
        const confirmed = window.confirm(`把全部数据库迁移到：\n${target}\n\n目标目录必须为空。迁移成功后切换到新目录，原目录暂时保留。继续吗？`);
        if (!confirmed) return;
        setBusy('move');
        try {
          const next = await call('/move', { method: 'POST', body: JSON.stringify({ dir: target }) });
          setData(next.overview);
          setDir(next.overview.dir);
          setError('');
        } catch (failure) {
          setError(failure.message);
        } finally {
          setBusy('');
        }
      };

      const setSession = async (id, payload) => {
        try {
          const next = await call('/session', {
            method: 'POST',
            body: JSON.stringify({ sessionId: id, ...payload }),
          });
          setData(next.overview);
          setError('');
        } catch (failure) {
          setError(failure.message);
        }
      };

      const sessions = data?.sessions ?? [];
      const activeSessions = sessions.filter((row) => row.folder !== 'archive');
      const archivedSessions = sessions.filter((row) => row.folder === 'archive');

      const rowView = (row) => {
        const color = COLOR[row.level] || COLOR.ok;
        return h('div', { className: 'dshmem-item', key: row.id },
          h('div', { className: 'dshmem-item-top' },
            h('span', { className: 'dshmem-name', title: row.title }, row.title),
            h('span', { className: 'dshmem-pct', style: { color } }, `${row.pct}%`),
          ),
          h('div', { className: 'dshmem-item-bar' },
            h('div', { className: 'dshmem-bar' },
              h('i', { style: { width: `${Math.min(100, Math.max(1.5, row.pct))}%`, background: color } })),
          ),
          h('div', { className: 'dshmem-item-meta' },
            h('span', null, row.startedAt),
            h('span', null, `${row.messages} / ${row.limit} 条`),
            h('span', null, human(row.bytes)),
            h('span', { className: 'dshmem-path', title: row.path }, row.fileName),
            h('span', { className: 'dshmem-item-actions' },
              h('button', {
                className: 'link',
                onClick: () => {
                  const value = window.prompt('这段对话的文本上限（条）', String(row.limit));
                  if (value && Number(value) > 0) setSession(row.id, { limit: Number(value) });
                },
              }, '上限'),
              h('button', {
                className: 'link',
                onClick: () => setSession(row.id, { state: row.state === 'recording' ? 'paused' : 'recording' }),
              }, row.state === 'recording' ? '暂停' : '恢复'),
            ),
          ),
        );
      };

      return h('div', { className: 'dshmem' },
        h('style', null, CSS),

        h('section', null,
          h('h3', null, '存储目录'),
          h('div', { className: 'dshmem-field' },
            h('input', {
              value: dir,
              spellCheck: false,
              onChange: (event) => setDir(event.target.value),
              placeholder: 'D:\\Deepseek_work\\dsh-memory\\data',
            }),
            h('button', {
              disabled: busy === 'move',
              onClick: async () => {
                try {
                  const picked = await pickDirectory();
                  if (picked) setDir(picked);
                } catch (failure) {
                  setError(failure?.message ?? '无法打开目录选择器');
                }
              },
            }, '选择…'),
            h('button', { disabled: busy === 'move' || dir.trim() === (data?.dir ?? ''), onClick: moveStorage },
              busy === 'move' ? '迁移中…' : '迁移到该目录'),
          ),
          h('p', { className: 'dshmem-hint' }, '迁移会把该目录下所有数据库（含索引库）复制到新位置。目标目录必须为空；迁移成功后切换到新目录，原目录暂时保留。'),
        ),

        h('section', null,
          h('h3', null, '提醒阈值'),
          h('div', { className: 'dshmem-limits' },
            h('label', null, '每对话提醒阈值（条）',
              h('input', { type: 'number', min: 100, step: 1000, value: defaultLimit, onChange: (event) => setDefaultLimit(event.target.value) })),
            h('label', null, '单库大小阈值（MB）',
              h('input', { type: 'number', min: 1, step: 10, value: sizeLimitMB, onChange: (event) => setSizeLimitMB(event.target.value) })),
            h('button', { className: 'primary', disabled: busy === 'settings', onClick: saveSettings },
              busy === 'settings' ? '保存中…' : '保存'),
          ),
          h('p', { className: 'dshmem-hint' }, '占用按两者中较高的比例计算：低于 70% 绿色，70%–90% 黄色，超过 90% 红色，达到 100% 会提醒。阈值只决定何时提醒，不会删除或覆盖已有内容。'),
        ),

        error ? h('div', { className: 'dshmem-error' }, error) : null,

        h('section', null,
          h('h3', null, '每个对话的存储'),
          sessions.length === 0
            ? h('div', { className: 'dshmem-empty' }, data ? '还没有记录任何对话。' : '读取中…')
            : h('div', null,
              h('div', { className: 'dshmem-list' }, activeSessions.map(rowView)),
              archivedSessions.length
                ? h('button', {
                  type: 'button',
                  className: 'dshmem-sub',
                  onClick: () => { archivedOpen = !archivedOpen; setShowArchived(archivedOpen); },
                }, `${showArchived ? '▾' : '▸'} 已归档 · ${archivedSessions.length}`)
                : null,
              showArchived && archivedSessions.length
                ? h('div', { className: 'dshmem-list' }, archivedSessions.map(rowView))
                : null,
            ),
          h('div', { className: 'dshmem-foot', style: { marginTop: 12 } },
            h('span', null, data
              ? `共 ${data.totals.sessions} 个对话 · ${data.totals.messages} 条文本`
              : '—'),
            h('span', null, data ? `合计 ${human(data.totals.bytes)}` : ''),
          ),
        ),
      );
    }

    // The overlay lives in `shell.overlay`, whose wrapper is a zero-height box
    // inside a transformed ancestor, so `position: fixed` cannot reach the
    // viewport from there. Portalling to <body> restores real viewport
    // coordinates; the stylesheet travels with the node because the settings
    // page may never have mounted.
    let createPortal = null;
    try {
      const ReactDOM = require('react-dom');
      createPortal = ReactDOM?.createPortal ?? null;
    } catch {
      createPortal = null;
    }

    function overlay(content) {
      const node = h('div', { className: 'dshmem-layer' }, h('style', null, CSS), content);
      if (createPortal && typeof document !== 'undefined' && document.body) {
        return createPortal(node, document.body);
      }
      return node;
    }

    function Alerts() {
      const [state, setState] = useState(null);
      const [acked, setAcked] = useState({});
      const [forced, setForced] = useState(false);
      const [custom, setCustom] = useState('');
      const [busy, setBusy] = useState(false);

      useEffect(() => {
        let alive = true;
        const tick = async () => {
          try {
            const suffix = viewSessionId ? `?session=${encodeURIComponent(viewSessionId)}` : '';
            const next = await call(`/alerts${suffix}`);
            if (alive) setState(next);
          } catch {
            /* host briefly unavailable: keep the last known state */
          }
        };
        tick();
        const timer = setInterval(tick, 4000);
        return () => { alive = false; clearInterval(timer); };
      }, []);

      if (!state || !state.active) return null;

      const seen = (kind) => Boolean(acked[`${state.sessionId}:${kind}`]);
      const acknowledge = async (kind) => {
        setAcked((prev) => ({ ...prev, [`${state.sessionId}:${kind}`]: true }));
        try {
          await call('/ack', { method: 'POST', body: JSON.stringify({ sessionId: state.sessionId, kind }) });
        } catch {
          /* the local dismissal alone is enough to stop the nagging */
        }
      };

      const change = async (payload) => {
        setBusy(true);
        try {
          const next = await call('/session', {
            method: 'POST',
            body: JSON.stringify({ sessionId: state.sessionId, ...payload }),
          });
          setState(next.alerts);
          setAcked({});
          setForced(false);
          setCustom('');
        } catch {
          setForced(false);
        } finally {
          setBusy(false);
        }
      };

      const full = (state.needs100 || forced) && !seen('full');
      const warn = !full && !forced && state.needs90 && !seen('warn');
      const presets = state.presets ?? [];
      const later = () => {
        if (state.needs100) acknowledge('full');
        else setForced(false);
      };

      if (full) {
        return overlay(h('div', { className: 'dshmem-backdrop' },
          h('div', { className: 'dshmem-modal' },
            h('h4', null, state.needs100 ? '已达提醒阈值' : '调整提醒阈值'),
            h('p', null,
              `「${short(state.title, 24)}」已用 `, h('b', null, `${state.pct}%`),
              `（${state.messages} / ${state.limit} 条，${human(state.bytes)}）。`,
              h('br'),
              state.needs100
                ? '目前仍在继续记录，不会删除或覆盖已有内容。可以提高阈值，或停止记录这段对话。'
                : '提高阈值后可以继续记录更多内容。'),
            h('div', { className: 'dshmem-presets' },
              presets.map((value) => h('button', {
                key: value,
                disabled: busy,
                onClick: () => change({ limit: value }),
              }, `提到 ${value}`)),
            ),
            h('div', { className: 'dshmem-custom' },
              h('input', {
                type: 'number',
                min: 100,
                placeholder: '自定义上限（条）',
                value: custom,
                onChange: (event) => setCustom(event.target.value),
              }),
              h('button', {
                className: 'primary',
                disabled: busy || !(Number(custom) > 0),
                onClick: () => change({ limit: Number(custom) }),
              }, '确定'),
            ),
            h('div', { className: 'dshmem-actions' },
              h('button', {
                className: 'danger',
                disabled: busy,
                onClick: () => change({ state: 'paused' }),
              }, '本对话停止记录'),
              h('div', { className: 'group' },
                h('button', { disabled: busy, onClick: later }, '稍后'),
              ),
            ),
          ),
        ));
      }

      if (warn) {
        return overlay(h('div', { className: 'dshmem-toast' },
          h('i', { className: 'dshmem-toast-dot', style: { background: 'var(--dsw-alias-state-warn-primary, #f5a524)' } }),
          h('span', { className: 'dshmem-toast-text' },
            `「${short(state.title, 20)}」已用 ${state.pct}%（${state.messages} / ${state.limit} 条），到 100% 会提醒你。`),
          h('button', { onClick: () => setForced(true) }, '调整上限'),
          h('button', { onClick: () => acknowledge('warn') }, '知道了'),
        ));
      }

      return null;
    }

    /** Composer control: pick a previous conversation to keep reading from. */
    function MemoryPicker(props) {
      const sessionId = props?.sessionId ?? null;
      const [open, setOpen] = useState(false);
      const [data, setData] = useState(null);
      const [query, setQuery] = useState('');
      const [focus, setFocus] = useState(null);
      const [showArchived, setShowArchived] = useState(archivedOpen);

      const load = useCallback(async () => {
        try {
          const next = await call('/overview');
          setData(next);
          setFocus(next.sessions.find((row) => row.id === sessionId)?.focus ?? null);
        } catch {
          /* keep whatever we last knew */
        }
      }, [sessionId]);

      // Load on mount as well: the composer remounts on session updates, and the
      // chosen memory lives on the host, not in this component's state.
      useEffect(() => {
        if (sessionId) viewSessionId = sessionId;
        load();
      }, [load, open, sessionId]);

      const choose = async (memorySession) => {
        try {
          const next = await call('/focus', {
            method: 'POST',
            body: JSON.stringify({ sessionId, memorySession }),
          });
          setData(next.overview);
          setFocus(memorySession);
          setOpen(false);
        } catch {
          /* a failed pick simply keeps the previous choice */
        }
      };

      if (!sessionId) return null;
      const focused = (data?.sessions ?? []).find((row) => row.id === focus);
      const rows = (data?.sessions ?? [])
        .filter((row) => row.id !== sessionId && (!query || row.title.includes(query)));
      const activeRows = rows.filter((row) => row.folder !== 'archive');
      const archivedRows = rows.filter((row) => row.folder === 'archive');
      const itemView = (row) => h('button', {
        key: row.id,
        className: 'item',
        onClick: () => choose(row.id),
      },
        h('span', { className: 't' }, row.title),
        h('span', { className: 'm' }, `${row.startedAt.slice(5, 16)} · ${row.messages} 条 · ${human(row.bytes)}`),
      );

      return h('div', { className: 'dshmem-picker' },
        h('style', null, CSS),
        h('button', {
          className: focused ? 'chip active' : 'chip',
          onClick: () => setOpen((value) => !value),
          title: '选一段记忆，接着往下读',
        }, focused ? `继续：${short(focused.title, 8)}` : '记忆'),
        focused ? h('button', { className: 'x', onClick: () => choose(null), title: '取消' }, '×') : null,
        open ? h('div', { className: 'pop' },
          h('input', {
            autoFocus: true,
            placeholder: '搜索对话…',
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          h('div', { className: 'list' },
            activeRows.length
              ? activeRows.map(itemView)
              : h('div', { className: 'empty' }, data ? '没有其它对话' : '读取中…'),
            archivedRows.length
              ? h('button', {
                type: 'button',
                className: 'group',
                onClick: () => { archivedOpen = !archivedOpen; setShowArchived(archivedOpen); },
              }, `${showArchived ? '▾' : '▸'} 已归档 · ${archivedRows.length}`)
              : null,
            showArchived ? archivedRows.map(itemView) : null,
          ),
        ) : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          const ui = ctx.get('uiWorkspace');
          if (ui?.pickDirectory) pickDirectory = () => ui.pickDirectory();
        } catch {
          /* without the service the field stays editable by hand */
        }
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'memory-storage', order: 60, label: '记忆存储' },
          MemoryPage,
        ));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: 'memory-alerts', order: 95 },
          Alerts,
        ));
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
          { name: 'conversation.input.left', id: 'memory-picker', order: -100 },
          MemoryPicker,
        ));
      },
    };
  },
});
