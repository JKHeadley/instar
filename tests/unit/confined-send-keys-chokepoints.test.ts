/**
 * D3 enumeration (docs/specs/confined-spawn-subscription-reroute.md): every raw tmux `send-keys`
 * site in SessionManager and the server either sits in a function that consults the confined-write
 * guard BEFORE it, or carries a `confined-write-allowed: <reason>` comment within the four lines
 * above it. A new raw writer with neither fails this test, so the "no Instar writer types into a
 * confined session" claim is enforced by enumeration, not by memory.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILES = ['src/core/SessionManager.ts', 'src/commands/server.ts', ...fs.readdirSync(path.join(ROOT, 'src/server')).filter((f) => f.endsWith('.ts')).map((f) => `src/server/${f}`)];
// Quoted argv forms (single, double, backtick) and the shell-string form; an arbitrarily constructed argv is a known limit.
const SITE_RE = /['"`]send-keys['"`]|\bsend-keys -t\b|buildLiteralSendArgs\(/;
const GUARD_RE = /confinedWriteRefused\(|isConfinedWriteRefused\(/;
const ALLOW_RE = /confined-write-allowed:\s*\S/;
/** A method/function definition line: a 2-space class member `name(` (not a control keyword), or a `function` declaration, or an object-literal method `name(args) {` at 6 spaces (the server's tmuxOps). */
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'await', 'else']);
function isDef(line: string): boolean {
  if (/^\s*(?:export )?(?:async )?function\s/.test(line)) return true;
  // 2-space class member: `  name(` / `  private async name(` (never a call: calls sit deeper).
  const member = /^\s{2}(?:private |public |protected |readonly |static )*(?:async )?(#?[A-Za-z_]\w*)\s*(?:<[^>]*>)?\(/.exec(line);
  if (member && !KEYWORDS.has(member[1])) return true;
  // 6-space object-literal method DEFINITION `name(args): type {` (the server's tmuxOps); a call
  // such as `withSyncOp(() =>` never ends in `{` after its parameter list.
  return /^\s{6}(?:async )?[A-Za-z_]\w*\s*\([^()]*\)\s*(?::\s*[^{]+)?\{\s*$/.test(line);
}

interface Site { file: string; line: number; text: string; verdict: 'guarded' | 'allowlisted' | 'UNCOVERED' }

function scan(file: string): Site[] {
  const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
  const sites: Site[] = [];
  lines.forEach((text, i) => {
    if (!SITE_RE.test(text) || /^\s*\/\//.test(text) || /^\s*\*/.test(text)) return;
    if (/^export function buildLiteralSendArgs/.test(text)) return;
    // Allowlist comment within the four lines above.
    if (lines.slice(Math.max(0, i - 4), i).some((l) => ALLOW_RE.test(l))) { sites.push({ file, line: i + 1, text, verdict: 'allowlisted' }); return; }
    // Guard consulted earlier in the enclosing function.
    let start = i;
    while (start > 0 && !isDef(lines[start])) start--;
    const body = lines.slice(start, i).join('\n');
    sites.push({ file, line: i + 1, text, verdict: GUARD_RE.test(body) ? 'guarded' : 'UNCOVERED' });
  });
  return sites;
}

describe('every raw tmux send-keys site is guarded for confined sessions or allowlisted by name', () => {
  const sites = FILES.flatMap(scan);
  it('finds the known writers (the enumeration is not blind)', () => {
    expect(sites.length).toBeGreaterThanOrEqual(12);
    const names = sites.map((s) => `${s.file}:${s.line}`);
    expect(names.some((n) => n.startsWith('src/core/SessionManager.ts'))).toBe(true);
    expect(names.some((n) => n.startsWith('src/commands/server.ts'))).toBe(true);
  });
  it('leaves no uncovered writer', () => {
    const uncovered = sites.filter((s) => s.verdict === 'UNCOVERED').map((s) => `${s.file}:${s.line} ${s.text.trim().slice(0, 100)}`);
    expect(uncovered, `raw send-keys with neither the confined-write guard nor a confined-write-allowed comment:\n${uncovered.join('\n')}`).toEqual([]);
  });
  it('the guarded set covers the real chokepoints', () => {
    const guardedFns = ['performTmuxInjectionEffect', 'performStuckInputKeyEffect', 'detectClaudePrompt', 'sendKey(', 'sendKeyAsync'];
    const src = fs.readFileSync(path.join(ROOT, 'src/core/SessionManager.ts'), 'utf8');
    for (const fn of guardedFns) {
      const at = src.indexOf(fn);
      expect(at, fn).toBeGreaterThan(-1);
      const next = src.indexOf("'send-keys'", at);
      expect(GUARD_RE.test(src.slice(at, next)), `${fn} consults the guard before its first send-keys`).toBe(true);
    }
    expect(/sendKeys\(tmuxSession: string, text: string\): boolean \{\n[^\n]*\n\s*if \(sessionManager\.isConfinedWriteRefused\(tmuxSession\)\) return false;/.test(fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf8'))).toBe(true);
  });
});
