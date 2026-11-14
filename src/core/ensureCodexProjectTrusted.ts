/**
 * Never-Silent Conversation (docs/specs/never-silent-conversation.md §1.5, §3.3 startup-dialog):
 * a Codex session launched in a folder its CODEX_HOME has never trusted stops at
 * "Trust this folder?" and never answers. On 2026-11-13 three Inspec conversations
 * moved to Codex sat at that dialog in silence.
 *
 * Codex records the answer as a `[projects."<abs path>"] trust_level = "trusted"`
 * table in `<CODEX_HOME>/config.toml`. The folder here is the agent's own launch
 * directory — the folder Instar already runs Codex in with its own flags — so
 * recording it ahead of the launch is the same answer the operator would give,
 * given structurally instead of by a keypress on a screen.
 *
 * Contract: idempotent, append-only (never rewrites an existing entry, including
 * an explicit `untrusted`), never throws. Returns what it did so the caller logs it.
 */
import fs from 'node:fs';
import path from 'node:path';

export type CodexTrustResult =
  | { patched: true; reason: 'added' }
  | { patched: false; reason: 'already-recorded' | 'no-home' | 'not-absolute' | 'write-failed' | 'read-failed' };

/** TOML basic-string escape for a path used as a quoted table key. */
function tomlQuote(p: string): string {
  return `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * True when config.toml already mentions this folder in any form — a `[projects."<dir>"]` or
 * `[projects.'<dir>']` table, or a `"<dir>" = {…}` key inside `[projects]`. Conservative on
 * purpose: appending a second table for a folder already recorded another way makes the TOML
 * invalid and Codex refuses the whole file, so any mention means "leave it alone".
 */
export function hasCodexProjectEntry(toml: string, dir: string): boolean {
  return toml.includes(tomlQuote(dir)) || toml.includes(`'${dir}'`);
}

export function ensureCodexProjectTrusted(codexHome: string | null | undefined, projectDir: string): CodexTrustResult {
  if (!codexHome) return { patched: false, reason: 'no-home' };
  if (!path.isAbsolute(projectDir)) return { patched: false, reason: 'not-absolute' };
  const dir = path.resolve(projectDir);
  const file = path.join(codexHome, 'config.toml');
  let existing = '';
  try {
    if (fs.existsSync(file)) existing = fs.readFileSync(file, 'utf8');
  } catch {
    // @silent-fallback-ok — returned as read-failed; the caller logs it and the launch proceeds as before
    return { patched: false, reason: 'read-failed' };
  }
  if (hasCodexProjectEntry(existing, dir)) return { patched: false, reason: 'already-recorded' };
  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  const block = `${sep}\n[projects.${tomlQuote(dir)}]\ntrust_level = "trusted"\n`;
  try {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.appendFileSync(file, block, { encoding: 'utf8', mode: 0o600 });
    return { patched: true, reason: 'added' };
  } catch {
    // @silent-fallback-ok — returned as write-failed; the caller logs it and the never-silent watcher still tells the user if the session stalls
    return { patched: false, reason: 'write-failed' };
  }
}
