/**
 * The two reads the browser-care sweep needs that touch a running browser or its
 * folders (docs/specs/machine-self-maintenance.md, Part B, "Unsaved input and
 * downloads"). Both are reads. Kept outside `monitoring/machineMaintenance/` because
 * the per-tab check runs the installed `chrome-unsaved.sh` helper, and that folder
 * holds a source rule that it cannot run any command but its fixed readings.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TabCheck } from '../monitoring/machineMaintenance/BrowserCare.js';

export const UNSAVED_CHECK_TIMEOUT_MS = 60_000;

/**
 * Parses `chrome-unsaved.sh` output: one `tab <window>.<tab> yes|no|unreadable` line per
 * tab, then `done`. Output without `done`, or with no tab lines, is unreadable: nothing is
 * closed to find out.
 */
export function parseUnsavedOutput(output: string): TabCheck[] | 'unreadable' {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines[lines.length - 1] !== 'done') return 'unreadable';
  const tabs: TabCheck[] = [];
  for (const line of lines.slice(0, -1)) {
    const m = /^tab \d+\.\d+ (yes|no|unreadable)$/.exec(line);
    if (!m) return 'unreadable';
    tabs.push(m[1] as TabCheck);
  }
  return tabs.length > 0 ? tabs : 'unreadable';
}

/** Runs the installed helper for one profile. A non-zero exit or a timeout is unreadable. */
export function makeTabChecker(agentHome: string, platform: NodeJS.Platform = process.platform) {
  const script = path.join(agentHome, '.instar', 'scripts', 'browser', 'chrome-unsaved.sh');
  return (userDataDir: string): Promise<TabCheck[] | 'unreadable'> => new Promise((resolve) => {
    if (platform !== 'darwin' || !fs.existsSync(script)) { resolve('unreadable'); return; }
    execFile('/bin/bash', [script, userDataDir], { timeout: UNSAVED_CHECK_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (err, stdout) => resolve(err ? 'unreadable' : parseUnsavedOutput(stdout)));
  });
}

/** The profile's download folder: its own setting, else ~/Downloads. */
export function downloadFolder(userDataDir: string, home: string = os.homedir()): string {
  try {
    const prefs = JSON.parse(fs.readFileSync(path.join(userDataDir, 'Default', 'Preferences'), 'utf-8')) as { download?: { default_directory?: unknown } };
    const dir = prefs.download?.default_directory;
    if (typeof dir === 'string' && path.isAbsolute(dir)) return dir;
  } catch { /* @silent-fallback-ok — an unreadable Preferences file uses Chrome's default folder. */ }
  return path.join(home, 'Downloads');
}

/** True when a `.crdownload` in that folder changed in the last `freshMs`; null when unreadable. */
export function makeDownloadCheck(freshMs: number, now: () => number = Date.now, home: string = os.homedir()) {
  return async (userDataDir: string): Promise<boolean | null> => {
    const folder = downloadFolder(userDataDir, home);
    let names: string[];
    try { names = fs.readdirSync(folder); }
    catch (err) { return (err as NodeJS.ErrnoException).code === 'ENOENT' ? false : null; }
    for (const name of names) {
      if (!name.endsWith('.crdownload')) continue;
      try { if (now() - fs.statSync(path.join(folder, name)).mtimeMs < freshMs) return true; }
      catch { return null; }
    }
    return false;
  };
}
