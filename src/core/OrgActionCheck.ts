/**
 * Organization never rules checking actions (docs/specs/org-never-actions.md).
 *
 * The hook forwards the raw tool input; this module, on the same machine as the same user, builds
 * the evidence (what is actually sent), runs the keyword signal and the meaning judge, and keeps the
 * records, the cache, the pending checks and the single-use "allow once" approvals.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { IntentTestHarness, judgeOrgAction, type OrgActionVerdict } from './IntentTestHarness.js';
import type { ParsedOrgIntent } from './OrgIntentManager.js';
import type { IntelligenceProvider } from './types.js';
import { OrgPackStore } from './OrgPackStore.js';
import { parsePolicy } from './OrgPack.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import { CLAUDE_CODE_FRAMEWORK } from './frameworkFacts.js';

export const EVIDENCE_SAMPLE_MAX = 32 * 1024;
export const FILE_SAMPLE_MAX = 16 * 1024;
export const FILE_READ_MAX = 1024 * 1024;
export const EXTRACT_FILES_MAX = 20;
export const EXTRACT_BYTES_MAX = 10 * 1024 * 1024;
export const CACHE_MS = 10 * 60_000;
export const PENDING_MS = 30 * 60_000;
export const DEFAULT_DAILY_CENTS = 50;
const FALLBACK_CALL_CENTS = 0.1;
/** Fast-model rates used to turn reported tokens into cents (conservative; spec §B budget, EXO 3.0 condition 6). */
const CENTS_PER_INPUT_TOKEN = 0.0001;
const CENTS_PER_OUTPUT_TOKEN = 0.0005;

/** Tells the person something about the policy check (an attention item, or the app's list and a push). */
let orgNotify: ((key: string, title: string, text: string) => void) | null = null;
export function setOrgNotify(fn: ((key: string, title: string, text: string) => void) | null): void { orgNotify = fn; }
function notify(key: string, title: string, text: string): void {
  try { orgNotify?.(key, title, text); } catch (err) { console.error('[org-policy] notice failed:', err instanceof Error ? err.message : String(err)); }
}

export interface Evidence {
  kind: 'mcp' | 'bash' | 'message';
  /** Tool or command name. */
  operation: string;
  target: string;
  /** What the judge sees (at most EVIDENCE_SAMPLE_MAX). */
  sample: string;
  /** False when anything was not seen in full (spec §A "Complete or incomplete"). */
  complete: boolean;
  incompleteReason?: string;
  /** SHA-256 of the complete content sent; null when incomplete. */
  contentHash: string | null;
}

// ── MCP ──────────────────────────────────────────────────────────────────────

/** The external-operation gate's non-read classifier (a copy; a unit test pins both to one table). */
export function mcpIsNonRead(toolName: string): boolean {
  if (!toolName.startsWith('mcp__')) return false;
  const parts = toolName.split('__');
  if (parts.length < 3) return false;
  const action = parts.slice(2).join('_');
  const tokens = action.split('_').filter(Boolean);
  const mutatingTail = tokens.slice(1).some((t) => /^(delete|remove|trash|purge|destroy|drop|clear|send|create|post|write|add|insert|new|compose|publish|update|modify|edit|replace|patch|rename|move|change|set|toggle|enable|disable|revoke|archive|flush|wipe|expunge)$/.test(t));
  if (/^(delete|remove|trash|purge|destroy|drop|clear|send|create|post|write|add|insert|new|compose|publish|update|modify|edit|patch|rename|move|change|set|toggle|enable|disable)/.test(action)) return true;
  if (!mutatingTail && /^(get|list|search|fetch|check|read|view|describe|show|count|query|find|status)(?:_|$)/.test(action)) return false;
  return true;
}

/** A field whose last name segment says the content is passed by reference (not `profile`, `filename`). */
const CONTENT_REF = /^(attachments?|attachment_?ids?|files?|file_?(ids?|paths?|urls?)|documents?|document_?ids?|media(_?ids?|_?urls?)?|uploads?|upload_?ids?)$/i;
const TARGET_KEY = /^(to|cc|bcc|recipients?|channel(_?id)?|chat(_?id)?|thread(_?id)?|email|address|url|repo(sitory)?|owner)$/i;
const lastSeg = (key: string): string => key.split(/[.[\]]/).filter(Boolean).pop()?.replace(/\d+$/, '') ?? '';

/** §A MCP: every string field, in order, with its name; content passed by reference is incomplete. */
export function mcpEvidence(toolName: string, toolInput: unknown): Evidence {
  const lines: string[] = [];
  let complete = true;
  let reason: string | undefined;
  const targetBits: string[] = [];
  const forwardish = /(forward|share|send)/i.test(toolName);
  const walk = (v: unknown, key: string): void => {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      // Numbers and true/false are part of the action (an id, an amount) and of what an approval binds to.
      lines.push(`${key}: ${String(v)}`);
      const seg = lastSeg(key);
      if (TARGET_KEY.test(seg)) targetBits.push(String(v));
      if (CONTENT_REF.test(seg) || (forwardish && /^message_?ids?$/i.test(seg))) { complete = false; reason = `content passed by reference (${key})`; }
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${key}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, key ? `${key}.${k}` : k);
  };
  walk(toolInput, '');
  const full = lines.join('\n');
  if (Buffer.byteLength(full) > EVIDENCE_SAMPLE_MAX) { complete = false; reason ??= 'arguments longer than the judge sees'; }
  return {
    kind: 'mcp', operation: toolName, target: targetBits.join(', ').slice(0, 500),
    sample: full.slice(0, EVIDENCE_SAMPLE_MAX), complete, ...(complete ? {} : { incompleteReason: reason }),
    contentHash: complete ? sha256(full) : null,
  };
}

// ── Bash ─────────────────────────────────────────────────────────────────────

/**
 * Splits a command line at unquoted `&&`, `||`, `;`, `|` and newlines. Each part says whether its
 * input is piped from the part before it (so a body read from stdin is known to come from elsewhere).
 */
export function splitCommands(cmd: string): Array<{ text: string; piped: boolean }> {
  const out: Array<{ text: string; piped: boolean }> = [];
  let cur = ''; let q: string | null = null; let piped = false;
  const push = (nextPiped: boolean): void => { if (cur.trim()) out.push({ text: cur.trim(), piped }); cur = ''; piped = nextPiped; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (q) { cur += c; if (c === q) q = null; else if (c === '\\' && q === '"' && i + 1 < cmd.length) cur += cmd[++i]; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '\\' && i + 1 < cmd.length) { cur += c + cmd[++i]; continue; }
    if ((c === '&' && cmd[i + 1] === '&') || (c === '|' && cmd[i + 1] === '|')) { i++; push(false); continue; }
    if (c === ';' || c === '\n' || c === '&') { push(false); continue; }
    if (c === '|') { push(true); continue; }
    cur += c;
  }
  push(false);
  return out;
}

/** Joined short flags and `--flag=value` are split so `-d@f`, `-XPOST` and `--data=x` read like their spaced forms. */
/** curl/wget short options that take a value (so a group like `-sd@f` or `-sXPOST` splits correctly). */
const VALUE_SHORT = new Set(['d', 'X', 'F', 'T', 'H', 'u', 'o', 'b', 'e', 'A', 'K', 'x', 'w', 'r', 'm']);
function normalizeFlags(t: string[], tool: string): string[] {
  const out: string[] = [];
  const curlish = tool === 'curl' || tool === 'wget';
  for (const a of t) {
    const long = /^(--[A-Za-z][\w-]*)=(.*)$/s.exec(a);
    if (long) { out.push(long[1]!, long[2]!); continue; }
    if (curlish && /^-[A-Za-z]/.test(a) && a.length > 2) {
      // A group of short flags: each letter is a flag until one takes a value, which is the rest.
      for (let i = 1; i < a.length; i++) {
        const c = a[i]!;
        out.push(`-${c}`);
        if (VALUE_SHORT.has(c)) { if (i + 1 < a.length) out.push(a.slice(i + 1)); break; }
      }
      continue;
    }
    out.push(a);
  }
  return out;
}

/** A value whose real content comes from the shell or a file we didn't read (`$(…)`, backticks, `<file`). */
function shellSourced(v: string): boolean { return /\$\(|`|\$\{?[A-Za-z_]/.test(v); }

/** A shell-ish tokenizer good enough for the listed commands (quotes, no expansion). */
export function tokenize(cmd: string): string[] {
  const out: string[] = [];
  let cur = ''; let q: string | null = null; let had = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (q) { if (c === q) q = null; else if (c === '\\' && q === '"' && i + 1 < cmd.length) cur += cmd[++i]; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; had = true; continue; }
    if (/\s/.test(c)) { if (cur || had) { out.push(cur); cur = ''; had = false; } continue; }
    if (c === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; continue; }
    cur += c;
  }
  if (cur || had) out.push(cur);
  return out;
}

interface FileRead { name: string; text: string | null; bytes: number; tooBig: boolean }

/**
 * §A Bash: the listed commands only (curl/wget with a body or non-GET, gh issue|pr create|comment and
 * gh api with fields, scp/rsync to a remote, mail/sendmail). Anything else ⇒ null (not checked).
 */
export function bashEvidence(command: string, cwd: string, deadline: number, now: () => number = Date.now): Evidence | null {
  // Every part of a compound or piped command is looked at, not only the first.
  const found: Evidence[] = [];
  for (const part of splitCommands(command)) {
    const e = segmentEvidence(part.text, part.piped, cwd, deadline, now);
    if (e) found.push(e);
  }
  if (found.length === 0) return null;
  if (found.length === 1) return { ...found[0]!, contentHash: found[0]!.contentHash ? sha256(`${command}\n${found[0]!.contentHash}`) : null };
  const complete = found.every((e) => e.complete);
  const sample = found.map((e) => `[${e.operation} → ${e.target}]\n${e.sample}`).join('\n').slice(0, EVIDENCE_SAMPLE_MAX);
  return {
    kind: 'bash', operation: found.map((e) => e.operation).join(' + '), target: found.map((e) => e.target).join(', ').slice(0, 500), sample, complete,
    ...(complete ? {} : { incompleteReason: found.find((e) => !e.complete)?.incompleteReason ?? 'part of the command could not be read' }),
    // The approval binds to the whole command line plus every file's content.
    contentHash: complete ? sha256(`${command}\n${found.map((e) => e.contentHash).join('\n')}`) : null,
  };
}

function segmentEvidence(segment: string, piped: boolean, cwd: string, deadline: number, now: () => number): Evidence | null {
  const raw0 = tokenize(segment.replace(/^[({\s]+/, '').replace(/[)}\s]+$/, ''));
  let t = raw0;
  while (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]!)) t = t.slice(1); // env prefix: FOO=1 curl …
  if (t[0] === 'env' || t[0] === 'command' || t[0] === 'exec' || t[0] === 'sudo') { t = t.slice(1); while (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]!)) t = t.slice(1); }
  if (t.length === 0) return null;
  const tool = path.basename(t[0]!);
  t = [t[0]!, ...normalizeFlags(t.slice(1), tool)];
  const files: FileRead[] = [];
  let bytes = 0;
  let complete = true; let reason: string | undefined;
  const readFile = (p: string): FileRead => {
    const abs = path.resolve(cwd, p);
    if (files.length >= EXTRACT_FILES_MAX || now() > deadline) { complete = false; reason = 'too many files or out of time'; return { name: p, text: null, bytes: 0, tooBig: true }; }
    try {
      const st = fs.statSync(abs);
      if (st.size > FILE_READ_MAX || bytes + st.size > EXTRACT_BYTES_MAX) { complete = false; reason = `file over the read limit (${p})`; return { name: p, text: null, bytes: st.size, tooBig: true }; }
      const buf = fs.readFileSync(abs);
      bytes += buf.length;
      if (buf.includes(0)) { complete = false; reason = `binary file (${p})`; return { name: p, text: null, bytes: buf.length, tooBig: false }; }
      return { name: p, text: buf.toString('utf8'), bytes: buf.length, tooBig: false };
    } catch { complete = false; reason = `file could not be read (${p})`; return { name: p, text: null, bytes: 0, tooBig: false }; } // @silent-fallback-ok — unreadable means incomplete evidence, decided as unknown
  };
  const bodies: string[] = [];
  let target = '';
  let checked = false;

  if (tool === 'curl' || tool === 'wget') {
    let method = 'GET';
    for (let i = 1; i < t.length; i++) {
      const a = t[i]!;
      const next = (): string => t[++i] ?? '';
      if (a === '-X' || a === '--request') method = next().toUpperCase();
      else if (/^(-d|--data|--data-raw|--data-binary|--data-urlencode|--json|-F|--form|--post-data|--body-data)$/.test(a)) {
        const v = next(); method = method === 'GET' ? 'POST' : method;
        const ref = /^[@<](.+)$/.exec(v.replace(/^[^=@<]*=([@<])/, '$1'));
        if (ref) { if (ref[1] === '-') { complete = false; reason = 'body from stdin'; } else files.push(readFile(ref[1]!)); }
        else if (shellSourced(v)) { complete = false; reason = 'body built by the shell'; bodies.push(v); }
        else bodies.push(v);
      } else if (/^(--post-file|--body-file|-T|--upload-file)$/.test(a)) { method = 'POST'; files.push(readFile(next())); }
      else if (/^https?:\/\//.test(a)) target = a;
    }
    checked = method !== 'GET' && method !== 'HEAD';
  } else if (tool === 'gh') {
    const sub = `${t[1] ?? ''} ${t[2] ?? ''}`;
    if (/^(issue|pr) (create|comment)$/.test(sub) || t[1] === 'api') {
      for (let i = 2; i < t.length; i++) {
        const a = t[i]!;
        const isApi = t[1] === 'api';
        if (!isApi && a === '-F') {
          // In gh issue/pr, -F is --body-file.
          const f = t[++i] ?? '';
          if (f === '-') { complete = false; reason = 'body from stdin'; } else files.push(readFile(f));
        } else if (/^(-t|--title|-b|--body|-f|--field|-F|--raw-field)$/.test(a)) {
          const v = t[++i] ?? '';
          const ref = /^[^=]*=@(.+)$/.exec(v);
          if (ref) files.push(readFile(ref[1]!));
          else if (shellSourced(v)) { complete = false; reason = 'body built by the shell'; bodies.push(v); }
          else bodies.push(v);
        } else if (/^(--body-file|--input)$/.test(a)) {
          const f = t[++i] ?? '';
          if (f === '-') { complete = false; reason = 'body from stdin'; } else files.push(readFile(f));
        } else if (!a.startsWith('-') && t[1] === 'api' && i === 2) target = a;
      }
      target ||= `gh ${sub}`;
      checked = t[1] !== 'api' || bodies.length + files.length > 0;
    }
  } else if (tool === 'scp' || tool === 'rsync') {
    // Options that take a value (a key file, a port, a remote shell) are never read as files to send.
    const withValue = tool === 'scp' ? /^-[iPoFcSJl]$/ : /^(-e|--rsh|--rsync-path|--password-file|--exclude-from|--include-from|--files-from|-f|--filter)$/;
    const args: string[] = [];
    for (let i = 1; i < t.length; i++) {
      const a = t[i]!;
      if (withValue.test(a)) { i++; continue; }
      if (a.startsWith('-')) continue;
      args.push(a);
    }
    const dest = args[args.length - 1] ?? '';
    if (/^[^/]*:/.test(dest) || /^rsync:\/\//.test(dest)) {
      target = dest;
      for (const src of args.slice(0, -1)) if (!/^[^/]*:/.test(src)) files.push(readFile(src));
      checked = true;
    }
  } else if (tool === 'mail' || tool === 'sendmail' || tool === 'mailx') {
    checked = true;
    target = t.filter((a) => /@/.test(a)).join(', ');
    const redirect = piped ? null : /<\s*(\S+)/.exec(segment);
    if (redirect) files.push(readFile(redirect[1]!)); else { complete = false; reason = piped ? 'message body piped from another command' : 'message body from stdin'; }
  }
  if (!checked) return null;
  const parts = [...bodies.map((b) => `body: ${b}`), ...files.map((f) => `file ${f.name}: ${f.text === null ? '(not readable)' : f.text.length > FILE_SAMPLE_MAX ? f.text.slice(0, FILE_SAMPLE_MAX) : f.text}`)];
  if (files.some((f) => f.text !== null && f.text.length > FILE_SAMPLE_MAX)) { complete = false; reason ??= 'a file was cut at its sample'; }
  const sample = parts.join('\n');
  if (Buffer.byteLength(sample) > EVIDENCE_SAMPLE_MAX) { complete = false; reason ??= 'content longer than the judge sees'; }
  const full = [...bodies, ...files.map((f) => f.text ?? '')].join('\n');
  return {
    kind: 'bash', operation: tool, target: target.slice(0, 500), sample: sample.slice(0, EVIDENCE_SAMPLE_MAX), complete,
    ...(complete ? {} : { incompleteReason: reason }), contentHash: complete ? sha256(`${target}\n${full}`) : null,
  };
}

// ── The person's last request ───────────────────────────────────────────────

/** The last user entry that is not a tool_result, first 1 KB (spec §A). */
export function lastUserRequest(transcriptPath: string | undefined): string {
  if (!transcriptPath) return '';
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n').reverse();
      for (const line of lines) {
        let e: { type?: string; message?: { content?: unknown } };
        try { e = JSON.parse(line); } catch { continue; } // @silent-fallback-ok — a torn first line of the tail
        if (e.type !== 'user') continue;
        const c = e.message?.content;
        if (typeof c === 'string') return c.slice(0, 1024);
        if (Array.isArray(c)) {
          if (c.some((x) => (x as { type?: string })?.type === 'tool_result')) continue;
          const text = c.map((x) => (x as { text?: string })?.text ?? '').join(' ').trim();
          if (text) return text.slice(0, 1024);
        }
      }
    } finally { fs.closeSync(fd); }
  } catch { /* @silent-fallback-ok — no transcript means no request context */ }
  return '';
}

// ── State: budget, cache, records, pending checks ───────────────────────────

export function sha256(s: string): string { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

function writeAtomic(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) as T; } catch { return null; } // @silent-fallback-ok — absent reads as none
}

/** Masks e-mail addresses, phone numbers and runs of 6+ digits (spec §B Provenance). */
export function maskSample(s: string): string {
  return s.slice(0, 200).replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]').replace(/\+?\d[\d\s().-]{6,}\d/g, '[number]').replace(/\d{6,}/g, '[digits]');
}

export interface CheckDecision {
  checkId: string;
  outcome: 'allowed' | 'breach' | 'unknown';
  rule?: string;
  alternative?: string;
  reason?: string;
  keywordSignal?: string;
  allowedOnce?: boolean;
}

interface PendingCheck { checkId: string; createdAt: number; envelope: string | null; kind: string; operation: string; target: string; sample: string; complete: boolean; rule: string | null }
/** Per state directory: pending checks and approvals held in the server process only. */
const MEMORY = new Map<string, { pending: Map<string, PendingCheck>; allowed: Map<string, number> }>();

export class OrgActionChecker {
  private readonly root: string;
  constructor(private readonly stateDir: string, private readonly now: () => number = Date.now) {
    this.root = path.join(stateDir, 'org');
  }

  /** The envelope an approval binds to (spec §C): kind, operation, target, content hash, policy hash. */
  static envelopeHash(e: Evidence, policyHash: string): string | null {
    return e.contentHash ? sha256([e.kind, e.operation, e.target, e.contentHash, policyHash].join('\n')) : null;
  }

  private spendFile(): string { return path.join(this.root, 'judge-spend.json'); }
  spentToday(): number {
    const s = readJson<{ day: string; cents: number }>(this.spendFile());
    return s && s.day === new Date(this.now()).toISOString().slice(0, 10) ? s.cents : 0;
  }
  private addSpend(cents: number): void {
    writeAtomic(this.spendFile(), JSON.stringify({ day: new Date(this.now()).toISOString().slice(0, 10), cents: this.spentToday() + cents }));
  }

  private cacheFile(): string { return path.join(this.root, 'check-cache.json'); }
  private cacheGet(key: string): OrgActionVerdict | null {
    const c = readJson<Record<string, { at: number; v: OrgActionVerdict }>>(this.cacheFile()) ?? {};
    const hit = c[key];
    return hit && this.now() - hit.at < CACHE_MS ? hit.v : null;
  }
  private cachePut(key: string, v: OrgActionVerdict): void {
    const c = readJson<Record<string, { at: number; v: OrgActionVerdict }>>(this.cacheFile()) ?? {};
    for (const [k, x] of Object.entries(c)) if (this.now() - x.at >= CACHE_MS) delete c[k];
    c[key] = { at: this.now(), v };
    writeAtomic(this.cacheFile(), JSON.stringify(c));
  }

  record(entry: Record<string, unknown>): void {
    const file = path.join(this.root, 'action-checks.jsonl');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    try { if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, `${file}.1`); } catch { /* @silent-fallback-ok — first record */ }
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date(this.now()).toISOString(), ...entry })}\n`, { mode: 0o600 });
  }

  /** A held or blocked action, kept 30 minutes for the app's "Allow this once?" card (spec §C). */
  // Pending checks and allow-once approvals live only in this server's memory (EXO 3.0 re-audit): no file the
  // agent can write grants an approval or changes what the person's card shows. They last ten minutes and do
  // not survive a restart (the agent simply asks again).
  private mem(): { pending: Map<string, PendingCheck>; allowed: Map<string, number> } {
    let m = MEMORY.get(this.stateDir);
    if (!m) { m = { pending: new Map(), allowed: new Map() }; MEMORY.set(this.stateDir, m); }
    return m;
  }

  registerPending(e: Evidence, policyHash: string, rule: string | undefined): string {
    const checkId = crypto.randomUUID();
    this.mem().pending.set(checkId, {
      checkId, createdAt: this.now(), envelope: OrgActionChecker.envelopeHash(e, policyHash),
      kind: e.kind, operation: e.operation, target: e.target, sample: e.sample, complete: e.complete, rule: rule ?? null,
    });
    return checkId;
  }

  listPending(): Array<Record<string, unknown>> {
    const { pending } = this.mem();
    const out: Array<Record<string, unknown>> = [];
    for (const [id, p] of pending) {
      if (this.now() - p.createdAt > PENDING_MS) { pending.delete(id); continue; }
      const { envelope: _e, ...shown } = p;
      out.push(shown);
    }
    return out;
  }

  /** The person's tap: an allowed-once approval for one pending check (only complete evidence). */
  allowOnce(checkId: string): 'allowed' | 'not-found' | 'incomplete' {
    const { pending, allowed } = this.mem();
    const p = pending.get(checkId);
    if (!p || this.now() - p.createdAt > PENDING_MS) return 'not-found';
    if (!p.complete || !p.envelope) return 'incomplete';
    allowed.set(p.envelope, this.now());
    pending.delete(checkId);
    return 'allowed';
  }

  /** Consumes an approval for exactly this envelope, once. */
  consumeAllowOnce(envelope: string | null): boolean {
    if (!envelope) return false;
    const { allowed } = this.mem();
    const at = allowed.get(envelope);
    if (at === undefined) return false;
    allowed.delete(envelope);
    return this.now() - at < PENDING_MS;
  }

  /**
   * The judgment (spec §B): keyword signal, then the meaning judge on the agent's own provider, under
   * its own budget and the remaining deadline. Never throws.
   */
  async judge(args: {
    intent: ParsedOrgIntent; policyHash: string; evidence: Evidence; userRequest: string;
    provider: IntelligenceProvider | null; providerIsOwn: boolean; dailyCents: number; remainingMs: number; mode?: 'observe' | 'block'; framework?: string;
  }): Promise<{ verdict: OrgActionVerdict; keywordSignal?: string; cached: boolean }> {
    const never = args.intent.constraints.map((c) => c.text);
    const e = args.evidence;
    if (never.length === 0) return { verdict: { verdict: 'allowed' }, cached: false };
    const kw = new IntentTestHarness(args.intent).testRefusal(`${e.operation} ${e.target} ${e.sample}`.slice(0, 4000));
    const keywordSignal = kw.refused ? kw.matchedConstraint : undefined;
    if (!e.complete) return { verdict: { verdict: 'unknown', reason: e.incompleteReason ?? 'incomplete evidence' }, ...(keywordSignal ? { keywordSignal } : {}), cached: false };
    const key = sha256([e.kind, e.operation, e.contentHash, e.target, args.userRequest, args.policyHash].join('\n'));
    const hit = this.cacheGet(key);
    if (hit) return { verdict: hit, ...(keywordSignal ? { keywordSignal } : {}), cached: true };
    if (!args.provider || !args.providerIsOwn) return { verdict: { verdict: 'unknown', reason: 'no judge on the agent\'s own provider' }, ...(keywordSignal ? { keywordSignal } : {}), cached: false };
    if (this.spentToday() >= args.dailyCents) {
      // Told once a day, before a day of held actions (EXO 3.0 condition 6).
      const day = new Date(this.now()).toISOString().slice(0, 10);
      const told = path.join(this.root, 'budget-notice-day');
      let last = ''; try { last = fs.readFileSync(told, 'utf-8').trim(); } catch { last = ''; } // @silent-fallback-ok — never told yet
      if (last !== day) {
        writeAtomic(told, day);
        notify(`org-budget:${day}`, 'Organization policy checks paused for today', args.mode === 'block'
          ? "Today's budget for checking actions against your organization's policy is used up. Until tomorrow, actions that need a check are held for you in the Instar app."
          : "Today's budget for checking actions against your organization's policy is used up. Until tomorrow, actions go ahead without being checked; your agent is told it couldn't check them.");
      }
      return { verdict: { verdict: 'unknown', reason: 'daily judge budget used' }, ...(keywordSignal ? { keywordSignal } : {}), cached: false };
    }
    const timeoutMs = Math.max(0, args.remainingMs - 500);
    if (timeoutMs < 500) return { verdict: { verdict: 'unknown', reason: 'out of time' }, cached: false };
    let usedCents: number | null = null;
    let timedOut = false;
    const verdict = await Promise.race([
      judgeOrgAction({ never, kind: e.kind, target: `${e.operation} ${e.target}`, evidence: (keywordSignal ? `[keyword hint: "${keywordSignal}"]\n` : '') + e.sample, userRequest: args.userRequest }, args.provider, {
        timeoutMs,
        // Charged when it arrives, even after a timeout (the late call still cost something).
        onUsage: (u) => { usedCents = u.inputTokens * CENTS_PER_INPUT_TOKEN + u.outputTokens * CENTS_PER_OUTPUT_TOKEN; if (timedOut) this.addSpend(usedCents); },
        ...(args.framework ? { pinFramework: args.framework } : {}),
      }),
      new Promise<OrgActionVerdict>((r) => setTimeout(() => { timedOut = true; r({ verdict: 'unknown', reason: 'judge timed out' }); }, timeoutMs).unref?.()),
    ]);
    // The cost the provider reported, or the fixed estimate when it reported nothing.
    this.addSpend(usedCents ?? FALLBACK_CALL_CENTS);
    if (verdict.verdict !== 'unknown') this.cachePut(key, verdict);
    return { verdict, ...(keywordSignal ? { keywordSignal } : {}), cached: false };
  }
}

// ── One pipeline for tool calls and outgoing messages ───────────────────────


export interface OrgCheckContext {
  stateDir: string;
  config: { orgPolicy?: { actions?: { mode?: string; blockingApproved?: boolean; judgeDailyCents?: number } }; sessions?: { framework?: string } };
  provider: IntelligenceProvider | null;
  journal?: (event: string, detail: Record<string, unknown>) => void;
  now?: () => number;
}

export type OrgCheckResult =
  | { decision: 'pass' }
  | { decision: 'allow'; note?: string }
  | { decision: 'deny'; reason: string; checkId: string };

export function orgCheckMode(cfg: OrgCheckContext['config']): 'observe' | 'block' {
  const a = cfg.orgPolicy?.actions ?? {};
  return a.mode === 'block' && a.blockingApproved === true ? 'block' : 'observe';
}

/** Evidence for an outgoing message: the text itself, always complete. */
export function messageEvidence(text: string, channel: string, conversation: string): Evidence {
  const capped = text.length > EVIDENCE_SAMPLE_MAX;
  return {
    kind: 'message', operation: `reply via ${channel}`, target: conversation.slice(0, 200), sample: text.slice(0, EVIDENCE_SAMPLE_MAX),
    complete: !capped, ...(capped ? { incompleteReason: 'message longer than the judge sees' } : {}),
    contentHash: capped ? null : sha256(`${conversation}\n${text}`),
  };
}

/** Runs the check for one piece of evidence (spec §B, §C). Never throws. */
export async function runOrgCheck(ctx: OrgCheckContext, evidence: Evidence | null, extra: { sessionId?: unknown; userRequest: string; deadlineAt: number }): Promise<OrgCheckResult> {
  const now = ctx.now ?? Date.now;
  try {
    const s = new OrgPackStore(ctx.stateDir, '', now);
    const m = s.membership();
    if (!m || m.state !== 'joined' || !evidence) return { decision: 'pass' };
    const rec = s.currentRecord();
    let policy: string | null = null;
    try { policy = rec ? fs.readFileSync(path.join(ctx.stateDir, 'org', rec.orgId, `v${rec.version}`, 'policy.md'), 'utf-8') : null; } catch { policy = null; } // @silent-fallback-ok — nothing applied, nothing to check
    if (!rec) return { decision: 'pass' };
    if (policy === null) {
      // Joined, but the applied policy can't be read: recorded, and held in block mode (never a silent pass).
      const mode0 = orgCheckMode(ctx.config);
      try { new OrgActionChecker(ctx.stateDir, now).record({ sessionId: extra.sessionId ?? null, mode: mode0, outcome: 'policy-unreadable', operation: evidence.operation }); } catch { /* @silent-fallback-ok — the stderr line reports it */ }
      console.error('[org-policy] the applied policy could not be read');
      return mode0 === 'block' ? { decision: 'deny', reason: "Your organization's policy couldn't be read, so I can't check this. Try again in a moment, or ask your person.", checkId: '' } : { decision: 'pass' };
    }
    const c = new OrgActionChecker(ctx.stateDir, now);
    const mode = orgCheckMode(ctx.config);
    const envelope = OrgActionChecker.envelopeHash(evidence, rec.policySha256);
    if (mode === 'block' && c.consumeAllowOnce(envelope)) {
      c.record({ sessionId: extra.sessionId, mode, outcome: 'allowed-once', operation: evidence.operation, evidenceHash: evidence.contentHash });
      ctx.journal?.('org-action-check', { sessionId: extra.sessionId ?? null, principle: `org-policy:${rec.orgName}`, outcome: 'allowed-once', operation: evidence.operation, mode });
      return { decision: 'allow' };
    }
    const parsed = parsePolicy(policy);
    const intent = { name: rec.orgName, constraints: parsed.never.map((text) => ({ text, source: 'org-intent' as const })), goals: [], values: [], tradeoffHierarchy: [], raw: '' };
    const framework = ctx.config.sessions?.framework ?? CLAUDE_CODE_FRAMEWORK;
    const providerIsOwn = !!ctx.provider && (ctx.provider.frameworkId === undefined || ctx.provider.frameworkId === framework);
    const j = await c.judge({
      intent, policyHash: rec.policySha256, evidence, userRequest: extra.userRequest, provider: ctx.provider, providerIsOwn, framework,
      dailyCents: ctx.config.orgPolicy?.actions?.judgeDailyCents ?? DEFAULT_DAILY_CENTS, remainingMs: extra.deadlineAt - now(), mode,
    });
    const v = j.verdict;
    const keepers = rec.keepers.length ? rec.keepers.join(' or ') : 'the policy owners';
    c.record({
      sessionId: extra.sessionId ?? null, mode, outcome: v.verdict, kind: evidence.kind, operation: evidence.operation,
      target: evidence.target.replace(/^(https?:\/\/[^/]+).*$/, '$1'), evidenceHash: evidence.contentHash,
      keywordSignal: j.keywordSignal ?? null, rule: v.verdict === 'breach' ? v.rule : null, confidence: v.verdict === 'breach' ? v.confidence : null,
      reason: v.verdict === 'unknown' ? v.reason : null, cached: j.cached, sample: maskSample(evidence.sample),
    });
    ctx.journal?.('org-action-check', { sessionId: extra.sessionId ?? null, principle: `org-policy:${rec.orgName}`, outcome: v.verdict, rule: v.verdict === 'breach' ? v.rule : null, operation: evidence.operation, mode, cached: j.cached });
    if (v.verdict === 'allowed') return { decision: 'allow' };
    if (mode === 'observe') {
      return { decision: 'allow', note: v.verdict === 'breach'
        ? `This may break ${rec.orgName}'s rule "${v.rule}". Tell your person and ${keepers}.${v.alternative ? ` Suggested by the policy check: ${v.alternative}` : ''}`
        : `This couldn't be checked against ${rec.orgName}'s policy (${v.reason}). If it might break a rule, ask your person first.` };
    }
    const checkId = c.registerPending(evidence, rec.policySha256, v.verdict === 'breach' ? v.rule : undefined);
    // The held action reaches the person (EXO 3.0 condition 2): one notice per check, with the allow-once card in the app.
    notify(`org-check:${checkId}`, `${rec.orgName} policy held an action`, `${v.verdict === 'breach' ? `It may break the rule "${v.rule}".` : `It couldn't be checked (${v.reason}).`} Open the Instar app to read it and allow it once if it's fine.`);
    const reason = v.verdict === 'breach'
      ? `This would break ${rec.orgName}'s rule "${v.rule}". Ask ${keepers}, or your person can allow it once in the Instar app.${v.alternative ? ` Suggested by the policy check: ${v.alternative}` : ''}`
      : evidence.complete
        ? `I couldn't check this against ${rec.orgName}'s policy right now (${v.reason}). Your person can allow it once in the Instar app.`
        : evidence.kind === 'message'
          ? `This message is too long to check against ${rec.orgName}'s policy. Send it in shorter parts.`
          : `I couldn't read all of this, so I can't check it against ${rec.orgName}'s policy. Send it as a file I can read.`;
    return { decision: 'deny', reason, checkId };
  } catch (err) {
    // Recorded, never silent (EXO 3.0 no-silent-fallback): block holds the action, observe passes with the failure on record.
    const mode = orgCheckMode(ctx.config);
    try { new OrgActionChecker(ctx.stateDir, ctx.now ?? Date.now).record({ sessionId: extra.sessionId ?? null, mode, outcome: 'check-failed', reason: err instanceof Error ? err.message.slice(0, 200) : 'error' }); } catch { /* @silent-fallback-ok — the stderr line below still reports it */ }
    console.error('[org-policy] check failed:', err instanceof Error ? err.message : String(err));
    ctx.journal?.('org-action-check', { outcome: 'check-failed', mode });
    return mode === 'block' ? { decision: 'deny', reason: 'The organization policy check failed. Try again in a moment.', checkId: '' } : { decision: 'pass' };
  }
}

/** A message note for the agent's next session start (spec §C observe, outgoing messages). */
export function appendMessageNote(stateDir: string, conversation: string, note: string): void {
  const file = path.join(stateDir, 'org', 'message-notes.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), conversation, note })}\n`, { mode: 0o600 });
}

/**
 * Takes every waiting note once (session start). The file is renamed away first, so a note appended
 * while this runs lands in a fresh file for next time instead of being lost.
 */
export function takeMessageNotes(stateDir: string): Array<{ conversation: string; note: string }> {
  const file = path.join(stateDir, 'org', 'message-notes.jsonl');
  const taking = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.taking`;
  try { fs.renameSync(file, taking); } catch { return []; } // @silent-fallback-ok — no notes waiting
  let lines: string[] = [];
  try { lines = fs.readFileSync(taking, 'utf-8').split('\n').filter(Boolean); } catch { lines = []; } // @silent-fallback-ok — just renamed; unreadable means nothing to show
  try { SafeFsExecutor.safeUnlinkSync(taking, { operation: 'org action check: message notes taken' }); } catch { /* @silent-fallback-ok — already gone */ }
  const out: Array<{ conversation: string; note: string }> = [];
  for (const l of lines.slice(-200)) { try { const e = JSON.parse(l); out.push({ conversation: String(e.conversation), note: String(e.note) }); } catch { /* @silent-fallback-ok — a torn line is skipped */ } }
  return out;
}

/**
 * Writes one organization-policy judgment to the decision journal (EXO 3.0 provenance; spec §B). Never throws:
 * a journal failure is reported once to stderr and the check goes on.
 */
export function orgDecisionJournal(stateDir: string): (event: string, detail: Record<string, unknown>) => void {
  return (event, detail) => {
    void import('./DecisionJournal.js').then(({ DecisionJournal }) => {
      new DecisionJournal(stateDir).log({
        sessionId: typeof detail.sessionId === 'string' && detail.sessionId ? detail.sessionId : 'org-policy-check',
        decision: `${event}: ${String(detail.outcome ?? '')}${detail.rule ? ` (rule: ${String(detail.rule).slice(0, 160)})` : ''}`,
        principle: typeof detail.principle === 'string' ? detail.principle : 'org-policy',
        context: JSON.stringify({ operation: detail.operation, mode: detail.mode }).slice(0, 400),
        tags: ['org-policy', String(detail.mode ?? 'observe')],
      }, [{ kind: 'session', sourceId: 'org/action-checks.jsonl' } as never]);
    }).catch((err) => { console.error('[org-policy] decision journal write failed:', err instanceof Error ? err.message : String(err)); });
  };
}
