/** Structural-only, bounded evidence extracted locally from a Claude transcript tail. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { scrubSecrets } from './scrubSecrets.js';

export type EvidenceActionKind = 'sent' | 'deployed' | 'handed-off' | 'committed' | 'pushed' | 'merged' | 'restarted' | 'fixed' | 'other';

export interface TurnEvidenceItem {
  tool: string;
  actionKind: EvidenceActionKind;
  targetSummary?: string;
  ok: boolean;
  errorClass?: string;
}

export interface TurnEvidence {
  hadToolCalls: boolean;
  toolCalls: TurnEvidenceItem[];
  truncated: boolean;
  unavailable: boolean;
  canaryOk: boolean;
  reason?: string;
}

export const TURN_EVIDENCE_MAX_TAIL_BYTES = 512 * 1024;
const FIELD_MAX_BYTES = 256;
const SAFE_IDENTIFIER = /^[a-zA-Z0-9._/@:+-]{1,200}$/;
const ACTION_KINDS = new Set<EvidenceActionKind>(['sent', 'deployed', 'handed-off', 'committed', 'pushed', 'merged', 'restarted', 'fixed', 'other']);

export interface TurnEvidencePrivacyOptions { redactIdentifiers?: boolean }
export interface TurnEvidenceCanaryResult { ok: boolean; driftSignaled: boolean; reason?: string }
let bootCanaryDriftSignaled = false;

/** Used by tests and the boot canary; the production Stop hook runs the same
 * bounded parser client-side and sends only the validated result to the server. */
export function extractTurnEvidence(transcriptPath: string | undefined, cwd?: string, privacy?: TurnEvidencePrivacyOptions): TurnEvidence {
  if (!transcriptPath) return unavailable('no-transcript');
  try {
    const resolved = path.resolve(transcriptPath);
    const allowedRoot = cwd ? path.resolve(cwd) : path.dirname(resolved);
    if (cwd && resolved !== allowedRoot && !resolved.startsWith(`${allowedRoot}${path.sep}`)) return unavailable('path-outside-cwd');
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return unavailable('not-a-file');
    const start = Math.max(0, stat.size - TURN_EVIDENCE_MAX_TAIL_BYTES);
    const fd = fs.openSync(resolved, 'r');
    const buffer = Buffer.alloc(stat.size - start);
    try { fs.readSync(fd, buffer, 0, buffer.length, start); } finally { fs.closeSync(fd); }
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // partial first JSONL row
    return extractTurnEvidenceFromRows(lines, start > 0, privacy);
  } catch { return unavailable('read-failed'); }
}

export function extractTurnEvidenceFromRows(lines: string[], truncated = false, privacy?: TurnEvidencePrivacyOptions): TurnEvidence {
  const rows: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line) as Record<string, unknown>); } catch { /* partial/invalid row */ }
  }
  let boundary = -1;
  for (let i = 0; i < rows.length; i++) if (isUserRow(rows[i])) boundary = i;
  const calls = new Map<string, TurnEvidenceItem>();
  let anonymous = 0;
  for (const row of rows.slice(boundary + 1)) {
    const message = asObject(row.message);
    const content = Array.isArray(message?.content) ? message.content : Array.isArray(row.content) ? row.content : [];
    for (const rawBlock of content) {
      const block = asObject(rawBlock);
      if (!block) continue;
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        const id = typeof block.id === 'string' ? block.id : `anonymous-${anonymous++}`;
        calls.set(id, extractTool(block.name, asObject(block.input)));
      } else if (block.type === 'tool_result') {
        applyResult(calls, block);
      }
    }
    if (row.type === 'tool_result') applyResult(calls, row);
  }
  const toolCalls = [...calls.values()].map((item) => scrubItem(item, privacy));
  return {
    hadToolCalls: toolCalls.length > 0,
    toolCalls,
    truncated,
    unavailable: false,
    canaryOk: rows.length === 0 || rows.some((row) => isUserRow(row) || containsRecognizedBlock(row)),
    ...(rows.length > 0 && !rows.some((row) => isUserRow(row) || containsRecognizedBlock(row)) ? { reason: 'format-drift-canary' } : {}),
  };
}

/** Treat request bodies as hostile: closed enums, bounded strings, bounded list. */
export function validateTurnEvidence(value: unknown, privacy?: TurnEvidencePrivacyOptions): TurnEvidence | null {
  const obj = asObject(value);
  if (!obj || typeof obj.hadToolCalls !== 'boolean' || typeof obj.truncated !== 'boolean'
    || typeof obj.unavailable !== 'boolean' || !Array.isArray(obj.toolCalls) || obj.toolCalls.length > 200) return null;
  const toolCalls: TurnEvidenceItem[] = [];
  for (const raw of obj.toolCalls) {
    const item = asObject(raw);
    if (!item || typeof item.tool !== 'string' || item.tool.length > 100 || typeof item.ok !== 'boolean'
      || !ACTION_KINDS.has(item.actionKind as EvidenceActionKind)) return null;
    toolCalls.push(scrubItem({
      tool: item.tool,
      actionKind: item.actionKind as EvidenceActionKind,
      ...(typeof item.targetSummary === 'string' ? { targetSummary: item.targetSummary } : {}),
      ok: item.ok,
      ...(typeof item.errorClass === 'string' ? { errorClass: item.errorClass } : {}),
    }, privacy));
  }
  return {
    hadToolCalls: toolCalls.length > 0,
    toolCalls,
    truncated: obj.truncated,
    unavailable: obj.unavailable,
    canaryOk: obj.canaryOk !== false,
    ...(typeof obj.reason === 'string' ? { reason: bounded(obj.reason) } : {}),
  };
}

function extractTool(name: string, input: Record<string, unknown> | null): TurnEvidenceItem {
  const tool = bounded(name, 100);
  if (name === 'Bash' || name === 'functions.exec_command') {
    const command = typeof input?.command === 'string' ? input.command : typeof input?.cmd === 'string' ? input.cmd : '';
    // Default deny: recognize only a single safe git subcommand. Never retain the command.
    if (!/[;&|`\n\r]/.test(command)) {
      const push = command.trim().match(/^git\s+push(?:\s+--[a-z-]+)*\s+([^\s]+)(?:\s+([^\s]+))?$/i);
      if (push) return { tool, actionKind: 'pushed', targetSummary: safeJoin(push[1], push[2]), ok: true };
      if (/^git\s+commit(?:\s+--[a-z-]+|\s+-[a-zA-Z]+(?:\s+[^\s]+)?)*$/i.test(command.trim())) return { tool, actionKind: 'committed', ok: true };
      const merge = command.trim().match(/^git\s+merge\s+([^\s]+)$/i);
      if (merge) return { tool, actionKind: 'merged', targetSummary: safeIdentifier(merge[1]), ok: true };
    }
    return { tool, actionKind: 'other', ok: true };
  }
  if (['Edit', 'Write', 'MultiEdit', 'functions.apply_patch'].includes(name)) {
    const file = typeof input?.file_path === 'string' ? path.basename(input.file_path) : undefined;
    return { tool, actionKind: 'fixed', ...(file ? { targetSummary: safeIdentifier(file) } : {}), ok: true };
  }
  if (/slack|telegram|send_message|reply/i.test(name)) {
    const target = safeIdentifier(input?.channel) ?? safeIdentifier(input?.topicId) ?? safeIdentifier(input?.target);
    return { tool, actionKind: 'sent', ...(target ? { targetSummary: target } : {}), ok: true };
  }
  if (/deploy/i.test(name)) return { tool, actionKind: 'deployed', ...(safeIdentifier(input?.project) ? { targetSummary: safeIdentifier(input?.project) } : {}), ok: true };
  if (/merge/i.test(name)) return { tool, actionKind: 'merged', ...(safeIdentifier(input?.pull_number) ? { targetSummary: safeIdentifier(input?.pull_number) } : {}), ok: true };
  return { tool, actionKind: 'other', ok: true };
}

function applyResult(calls: Map<string, TurnEvidenceItem>, block: Record<string, unknown>): void {
  const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : typeof block.id === 'string' ? block.id : '';
  const item = calls.get(id);
  if (!item) return;
  const failed = block.is_error === true || block.error != null || block.success === false;
  if (failed) calls.set(id, { ...item, ok: false, errorClass: 'tool-error' });
}

function isUserRow(row: Record<string, unknown>): boolean {
  const message = asObject(row.message);
  const content = Array.isArray(message?.content) ? message.content : Array.isArray(row.content) ? row.content : [];
  // Claude records tool results in role=user envelopes. They are continuations
  // of the assistant turn, not a new operator boundary.
  const toolResultOnly = content.length > 0 && content.every((block) => asObject(block)?.type === 'tool_result');
  return !toolResultOnly && (row.type === 'user' || row.role === 'user' || message?.role === 'user');
}
function containsRecognizedBlock(row: Record<string, unknown>): boolean {
  const message = asObject(row.message);
  const content = Array.isArray(message?.content) ? message.content : Array.isArray(row.content) ? row.content : [];
  return content.some((block) => ['tool_use', 'tool_result'].includes(String(asObject(block)?.type)));
}
function asObject(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function safeIdentifier(value: unknown): string | undefined { const text = typeof value === 'number' ? String(value) : value; return typeof text === 'string' && SAFE_IDENTIFIER.test(text) ? bounded(text) : undefined; }
function safeJoin(a: unknown, b: unknown): string | undefined { const parts = [safeIdentifier(a), safeIdentifier(b)].filter(Boolean); return parts.length ? parts.join('/') : undefined; }
function bounded(value: string, max = FIELD_MAX_BYTES): string { return Buffer.from(scrubSecrets(value)).subarray(0, max).toString('utf8'); }
function scrubItem(item: TurnEvidenceItem, privacy?: TurnEvidencePrivacyOptions): TurnEvidenceItem {
  const target = item.targetSummary ? bounded(item.targetSummary) : undefined;
  const targetSummary = target && privacy?.redactIdentifiers
    ? `id:${createHash('sha256').update(target.split('/').at(-1) ?? target).digest('hex').slice(0, 16)}`
    : target;
  return { tool: bounded(item.tool, 100), actionKind: item.actionKind, ...(targetSummary ? { targetSummary } : {}), ok: item.ok, ...(item.errorClass ? { errorClass: bounded(item.errorClass, 100) } : {}) };
}
function unavailable(reason: string): TurnEvidence { return { hadToolCalls: false, toolCalls: [], truncated: false, unavailable: true, canaryOk: true, reason }; }

/**
 * Production positive-control boot canary. Call once during server construction.
 * A format drift emits at most one process-lifetime signal and increments the
 * supplied metric callback exactly once.
 */
export function runTurnEvidenceBootCanary(onDrift?: (reason: string) => void, fixtureRows?: string[]): TurnEvidenceCanaryResult {
  const fixture = fixtureRows ?? [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'ship it' } }),
    JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', id: 'canary-push', name: 'Bash', input: { command: 'git push origin turn-evidence-canary' } }] } }),
    JSON.stringify({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'canary-push', is_error: false }] } }),
  ];
  const evidence = extractTurnEvidenceFromRows(fixture);
  const ok = evidence.canaryOk && !evidence.unavailable && evidence.toolCalls.length === 1
    && evidence.toolCalls[0]?.actionKind === 'pushed'
    && evidence.toolCalls[0]?.targetSummary === 'origin/turn-evidence-canary';
  if (ok) return { ok: true, driftSignaled: false };
  const reason = 'turn-evidence-positive-control-failed';
  const first = !bootCanaryDriftSignaled;
  if (first) {
    bootCanaryDriftSignaled = true;
    try { onDrift?.(reason); } catch { /* signal sink cannot affect boot */ }
  }
  return { ok: false, driftSignaled: first, reason };
}
