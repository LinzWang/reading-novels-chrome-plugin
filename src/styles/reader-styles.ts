export const READER_CSS = `
:host {
  color-scheme: light dark;
  all: initial;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "PingFang SC", sans-serif;
}

* {
  box-sizing: border-box;
}

.reader-shell {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  background: var(--reader-bg);
  color: var(--reader-fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "PingFang SC", sans-serif;
  font-size: calc(18px * var(--reader-font-scale, 1));
  line-height: 1.8;
  overflow: auto;
}

.reader-shell[data-theme="light"] {
  --reader-bg: #f8fafc;
  --reader-panel: #ffffff;
  --reader-fg: #111827;
  --reader-muted: #64748b;
  --reader-border: #e2e8f0;
  --reader-accent: #2563eb;
  --reader-highlight: #dbeafe;
}

.reader-shell[data-theme="sepia"] {
  --reader-bg: #f4ecd8;
  --reader-panel: #fff8e8;
  --reader-fg: #2d2418;
  --reader-muted: #7c6f57;
  --reader-border: #e3d4b5;
  --reader-accent: #9a5c16;
  --reader-highlight: #f8df9c;
}

.reader-shell[data-theme="dark"] {
  --reader-bg: #0f172a;
  --reader-panel: #111827;
  --reader-fg: #e5e7eb;
  --reader-muted: #94a3b8;
  --reader-border: #334155;
  --reader-accent: #60a5fa;
  --reader-highlight: #1e3a8a;
}

.reader-toolbar {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  flex-wrap: nowrap;
  gap: 6px;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--reader-border);
  background: var(--reader-panel);
}

.reader-toolbar .toolbar-left {
  display: flex;
  gap: 6px;
  align-items: center;
}

.reader-toolbar .toolbar-right {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-left: auto;
}

.reader-toolbar::-webkit-scrollbar {
  height: 4px;
}

.reader-toolbar::-webkit-scrollbar-thumb {
  background: var(--reader-border);
  border-radius: 2px;
}

.reader-toolbar button,
.reader-toolbar select,
.reader-toolbar input[type="range"] {
  color: var(--reader-fg);
  background: var(--reader-panel);
  border: 1px solid var(--reader-border);
  border-radius: 999px;
  padding: 4px 10px;
  font: inherit;
  font-size: 13px;
}

.reader-toolbar button {
  cursor: pointer;
}

.reader-toolbar button.primary {
  background: var(--reader-accent);
  border-color: var(--reader-accent);
  color: white;
}

.reader-toolbar label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--reader-muted);
  font-size: 13px;
  white-space: nowrap;
  flex-shrink: 0;
}

.reader-container {
  width: min(860px, calc(100vw - 32px));
  margin: 32px auto 96px;
  padding: 36px clamp(22px, 6vw, 64px);
  background: var(--reader-panel);
  border: 1px solid var(--reader-border);
  border-radius: 28px;
  box-shadow: 0 24px 80px rgb(15 23 42 / 0.18);
}

.reader-title {
  margin: 0 0 8px;
  font-size: clamp(28px, 4vw, 44px);
  line-height: 1.2;
}

.reader-meta,
.reader-status {
  margin: 0 0 16px;
  color: var(--reader-muted);
  font-size: 14px;
  line-height: 1.5;
}

.reader-status {
  padding: 10px 12px;
  border: 1px dashed var(--reader-border);
  border-radius: 12px;
}

.reader-content {
  margin-top: 24px;
}

.reader-segment {
  margin: 0.85em 0;
  padding: 0.1em 0.25em;
  border-radius: 8px;
  cursor: pointer;
  transition: background 120ms ease, outline-color 120ms ease;
}

.reader-segment:hover {
  outline: 1px solid var(--reader-border);
}

.reader-segment.is-active {
  background: var(--reader-highlight);
  outline: 2px solid var(--reader-accent);
}

.reader-error {
  color: #b91c1c;
  white-space: pre-wrap;
}

.reader-loading {
  opacity: 0.75;
}

a {
  color: var(--reader-accent);
}

/* Settings panel */
.reader-settings-panel {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2;
  opacity: 0;
  pointer-events: none;
  transition: opacity 200ms ease;
}

.reader-settings-panel.open {
  opacity: 1;
  pointer-events: auto;
}

.reader-settings-panel .settings-content {
  background: var(--reader-panel);
  border-radius: 16px;
  border: 1px solid var(--reader-border);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  width: min(400px, 90vw);
  max-height: 85vh;
  overflow-y: auto;
}

.reader-settings-panel .settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--reader-border);
  font-size: 16px;
  font-weight: 600;
}

.reader-settings-panel .settings-header .close-btn {
  background: transparent;
  border: none;
  font-size: 20px;
  cursor: pointer;
  color: var(--reader-muted);
  padding: 0;
  width: 28px;
  height: 28px;
  line-height: 1;
  border-radius: 50%;
}

.reader-settings-panel .settings-header .close-btn:hover {
  background: var(--reader-border);
}

.reader-settings-panel .settings-body {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.reader-settings-panel label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  color: var(--reader-muted);
  font-size: 14px;
}

.reader-settings-panel label select,
.reader-settings-panel label input[type="range"] {
  flex: 1;
  max-width: 200px;
  color: var(--reader-fg);
  background: var(--reader-panel);
  border: 1px solid var(--reader-border);
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 14px;
}

.reader-settings-panel .checkbox-label {
  justify-content: flex-start;
  gap: 8px;
}

.reader-settings-panel .checkbox-label input[type="checkbox"] {
  width: auto;
  flex: 0;
}
`;
