/**
 * PreCompactionFlush — Save important context to MEMORY.md *before* Claude Code
 * compaction collapses working memory.
 *
 * Architecture (Option A — server-side, agent-noninterruptive):
 *   1. Claude Code emits PreCompact hook → instar's hook-event-reporter POSTs
 *      to /hooks/events → HookEventReceiver emits 'PreCompact' event.
 *   2. This class listens on that event. On each fire, it:
 *      a. Locates the agent's transcript jsonl using Claude Code's standard
 *         path convention: ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 *      b. Reads the last N chars of the transcript (default 30KB) — bounded
 *         to keep the LLM call cheap.
 *      c. Sends a fact-extraction prompt to the shared intelligence provider
 *         (subscription path, no per-call cost on default config).
 *      d. Parses the response. Acceptable shapes: JSON array, JSON object
 *         with `facts` array, or markdown bullet list. Any valid fact has
 *         `slug` (kebab-case, ≤48 chars) and `body` (≤500 chars).
 *      e. For each parsed fact, writes a new file under
 *         `<projectDir>/.instar/memory/learning_<ts>_<slug>.md` with the
 *         standard memory frontmatter (type=learning).
 *      f. Appends a one-line index entry to `<projectDir>/.instar/MEMORY.md`
 *         if a "## Learnings" or similar section exists (best-effort).
 *      g. Writes a structured audit entry to
 *         `<projectDir>/.instar/audit/pre-compaction-flush.jsonl`.
 *
 * Safety properties:
 *   - Default `enabled: false` — flush is opt-in. The behavior change is
 *     additive and the audit log surfaces every fire, so operators can
 *     observe before enabling.
 *   - `maxFactsPerFlush` (default 5) caps the blast radius if the LLM
 *     hallucinates a long list.
 *   - All writes are best-effort: any single failure (transcript missing,
 *     LLM error, file write race) is audited and returns; never throws.
 *   - Calls run async/detached from the hook caller. The hook itself
 *     returns immediately so compaction is never delayed.
 *
 * Spec: docs/specs/OPENCLAW-IMPORT-PRE-COMPACTION-FLUSH-SPEC.md
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { IntelligenceProvider } from './types.js';

export interface PreCompactionFlushConfig {
  /** Master switch. Default false. */
  enabled: boolean;
  /** Maximum facts written per flush. Default 5. Hard cap for safety. */
  maxFactsPerFlush: number;
  /** Max chars of transcript tail to send to the LLM. Default 30000. */
  transcriptCharBudget: number;
}

export const DEFAULT_PRE_COMPACTION_FLUSH_CONFIG: PreCompactionFlushConfig = {
  enabled: false,
  maxFactsPerFlush: 5,
  transcriptCharBudget: 30_000,
};

export interface PreCompactionFlushDeps {
  intelligence: IntelligenceProvider | null;
  /** Agent's project root — the dir that contains `.instar/`. */
  projectDir: string;
  /** Stable agent label, used in audit entries. */
  agentLabel?: string;
  /** Optional override for transcript root (testing). Defaults to ~/.claude/projects. */
  claudeProjectsRoot?: string;
  /** Now provider — overridable for tests. */
  now?: () => Date;
}

export interface PreCompactPayload {
  event?: string;
  session_id?: string;
  transcript_path?: string;
  trigger?: string;
}

export interface ParsedFact {
  slug: string;
  body: string;
}

export type FlushOutcome =
  | 'ok'
  | 'disabled'
  | 'no-intelligence'
  | 'no-session-id'
  | 'no-transcript'
  | 'no-facts'
  | 'parse-failure'
  | 'provider-error'
  | 'write-error';

export interface FlushAuditEntry {
  flushId: string;
  sessionId: string;
  trigger?: string;
  at: string;
  outcome: FlushOutcome;
  factsWritten?: number;
  durationMs?: number;
  reason?: string;
}

export class PreCompactionFlush {
  private readonly deps: PreCompactionFlushDeps;
  private readonly config: PreCompactionFlushConfig;

  constructor(deps: PreCompactionFlushDeps, config: PreCompactionFlushConfig) {
    this.deps = deps;
    this.config = config;
  }

  /**
   * Handle a PreCompact event. Fire-and-forget; never throws to the caller.
   * Returns the audit entry it wrote (for tests).
   */
  async handle(payload: PreCompactPayload): Promise<FlushAuditEntry> {
    const startedAt = (this.deps.now?.() ?? new Date()).getTime();
    const flushId = `flush_${crypto.randomBytes(6).toString('hex')}`;
    const sessionId = payload.session_id ?? '';
    const trigger = payload.trigger;

    const audit = (outcome: FlushOutcome, extra?: Partial<FlushAuditEntry>): FlushAuditEntry => {
      const entry: FlushAuditEntry = {
        flushId,
        sessionId,
        trigger,
        at: (this.deps.now?.() ?? new Date()).toISOString(),
        outcome,
        durationMs: (this.deps.now?.() ?? new Date()).getTime() - startedAt,
        ...extra,
      };
      this.writeAudit(entry);
      return entry;
    };

    if (!this.config.enabled) return audit('disabled');
    if (!this.deps.intelligence) return audit('no-intelligence');
    if (!sessionId) return audit('no-session-id');

    const transcriptPath = this.resolveTranscriptPath(payload);
    const transcriptTail = this.readTranscriptTail(transcriptPath);
    if (!transcriptTail) return audit('no-transcript', { reason: `path: ${transcriptPath}` });

    let llmResponse: string;
    try {
      llmResponse = await this.deps.intelligence.evaluate(
        this.buildPrompt(transcriptTail),
        { maxTokens: 800, temperature: 0 },
      );
    } catch (err) {
      return audit('provider-error', { reason: String(err).slice(0, 200) });
    }

    const facts = this.parseFacts(llmResponse).slice(0, this.config.maxFactsPerFlush);
    if (facts.length === 0) {
      // Distinguish "LLM returned NONE / empty list" from "couldn't parse".
      if (/^\s*NONE\s*$/i.test(llmResponse) || /^\s*\[\s*\]\s*$/.test(llmResponse)) {
        return audit('no-facts');
      }
      return audit('parse-failure', { reason: llmResponse.slice(0, 200) });
    }

    let written = 0;
    try {
      for (const fact of facts) {
        if (this.writeFact(flushId, fact)) written++;
      }
      this.appendMemoryIndex(facts, flushId);
    } catch (err) {
      return audit('write-error', { reason: String(err).slice(0, 200), factsWritten: written });
    }
    return audit('ok', { factsWritten: written });
  }

  /** Build the flush prompt. Exported as a member for test inspection. */
  buildPrompt(transcriptTail: string): string {
    return [
      'You are an instar agent about to undergo context compaction. Recent conversation will be',
      'collapsed into a generic summary. Identify 0-5 DURABLE facts from the recent conversation',
      'that should survive compaction by being written to MEMORY.md as learnings.',
      '',
      'A durable fact is:',
      '  - specific (not "we talked about X")',
      '  - actionable for a future session ("X is at path Y", "approach Z works for case W")',
      '  - not already in your code or git history (those are recoverable from disk)',
      '  - not ephemeral state ("I am about to commit", "I am waiting for CI")',
      '',
      'Respond with a JSON array of objects, each with:',
      '  - "slug": kebab-case, max 48 chars, identifies the fact uniquely',
      '  - "body": 1-3 sentences, max 500 chars',
      '',
      'If nothing durable surfaces, respond with the literal token: NONE',
      '',
      'Recent conversation (tail):',
      '---',
      transcriptTail,
      '---',
      '',
      'Respond with the JSON array or NONE. No other text.',
    ].join('\n');
  }

  /** Parse the LLM response into facts. Accepts JSON array, JSON object with `facts`, or markdown. */
  parseFacts(response: string): ParsedFact[] {
    const trimmed = response.trim();
    if (/^\s*NONE\s*$/i.test(trimmed)) return [];

    // Try fenced JSON first.
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
    const candidate = fenceMatch ? fenceMatch[1] : trimmed;

    try {
      const parsed = JSON.parse(candidate);
      const arr = Array.isArray(parsed)
        ? parsed
        : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { facts?: unknown[] }).facts)
            ? (parsed as { facts: unknown[] }).facts
            : null);
      if (!arr) return [];
      const facts: ParsedFact[] = [];
      for (const item of arr) {
        const fact = this.coerceFact(item);
        if (fact) facts.push(fact);
      }
      return facts;
    } catch {
      return [];
    }
  }

  private coerceFact(item: unknown): ParsedFact | null {
    if (!item || typeof item !== 'object') return null;
    const obj = item as Record<string, unknown>;
    const rawSlug = typeof obj.slug === 'string' ? obj.slug : null;
    const rawBody = typeof obj.body === 'string' ? obj.body : null;
    if (!rawSlug || !rawBody) return null;
    const slug = rawSlug
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
    if (!slug) return null;
    const body = rawBody.trim().slice(0, 500);
    if (!body) return null;
    return { slug, body };
  }

  private resolveTranscriptPath(payload: PreCompactPayload): string {
    if (payload.transcript_path) return payload.transcript_path;
    if (!payload.session_id) return '';
    const root = this.deps.claudeProjectsRoot ?? path.join(os.homedir(), '.claude', 'projects');
    const encoded = this.deps.projectDir.replace(/[\/.]/g, '-');
    return path.join(root, encoded, `${payload.session_id}.jsonl`);
  }

  private readTranscriptTail(transcriptPath: string): string | null {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
    try {
      const stat = fs.statSync(transcriptPath);
      const budget = this.config.transcriptCharBudget;
      if (stat.size <= budget) {
        return fs.readFileSync(transcriptPath, 'utf8');
      }
      const fd = fs.openSync(transcriptPath, 'r');
      const buf = Buffer.alloc(budget);
      fs.readSync(fd, buf, 0, budget, stat.size - budget);
      fs.closeSync(fd);
      // Drop leading partial line so we start on a complete event boundary.
      const text = buf.toString('utf8');
      const firstNl = text.indexOf('\n');
      return firstNl >= 0 ? text.slice(firstNl + 1) : text;
    } catch {
      return null;
    }
  }

  private writeFact(flushId: string, fact: ParsedFact): boolean {
    try {
      const ts = (this.deps.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
      const memoryDir = path.join(this.deps.projectDir, '.instar', 'memory');
      fs.mkdirSync(memoryDir, { recursive: true });
      const file = path.join(memoryDir, `learning_precompact_${ts}_${fact.slug}.md`);
      const body = [
        '---',
        `name: precompact-${fact.slug}`,
        `description: ${fact.body.split('\n')[0].slice(0, 120)}`,
        'metadata:',
        '  type: learning',
        `  source: pre-compaction-flush`,
        `  flushId: ${flushId}`,
        '---',
        '',
        fact.body,
        '',
      ].join('\n');
      fs.writeFileSync(file, body);
      return true;
    } catch {
      return false;
    }
  }

  private appendMemoryIndex(facts: ParsedFact[], flushId: string): void {
    try {
      const indexPath = path.join(this.deps.projectDir, '.instar', 'MEMORY.md');
      if (!fs.existsSync(indexPath)) return;
      const existing = fs.readFileSync(indexPath, 'utf8');
      const newLines = facts.map(
        (f) => `- [precompact: ${f.slug}](memory/learning_precompact_*_${f.slug}.md) — ${f.body.split('\n')[0].slice(0, 120)} (flush ${flushId})`,
      );
      // Append under a "## Pre-Compaction Saves" section, creating it if missing.
      const SECTION = '## Pre-Compaction Saves';
      let updated: string;
      if (existing.includes(SECTION)) {
        updated = existing.replace(
          new RegExp(`(${SECTION}[^\n]*\n)`),
          (m) => `${m}${newLines.join('\n')}\n`,
        );
      } else {
        updated = existing.trimEnd() + `\n\n${SECTION}\n\n${newLines.join('\n')}\n`;
      }
      fs.writeFileSync(indexPath, updated);
    } catch {
      // Best effort.
    }
  }

  private writeAudit(entry: FlushAuditEntry): void {
    try {
      const auditDir = path.join(this.deps.projectDir, '.instar', 'audit');
      fs.mkdirSync(auditDir, { recursive: true });
      const auditPath = path.join(auditDir, 'pre-compaction-flush.jsonl');
      fs.appendFileSync(auditPath, JSON.stringify(entry) + '\n');
    } catch {
      // Audit must never throw.
    }
  }
}
