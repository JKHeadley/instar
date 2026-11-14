/**
 * IndexCost — the measured size of the rendered skill index (spec
 * docs/specs/skill-learning-sentinel.md §3.9 "Keep the library small and the
 * prompt flat"; slice 2).
 *
 * Prompt cost is MEASURED, never capped: every tick the sentinel reads the real
 * rendered index — the sanitised `description` of every `SKILL.md` under
 * `.claude/skills` and `.agents/skills`, as each loader indexes it (name +
 * description, nothing else is loaded until the skill is invoked) — and hands
 * the drafter and the reviewer the headroom against the loader's own limit, so
 * description length is judged for scope, not clipped by a counter.
 *
 * Loader limits: Claude Code budgets the skill index at
 * `SLASH_COMMAND_TOOL_CHAR_BUDGET` characters (15 000 by default; descriptions
 * past the budget are dropped from the index, which is the cost the operator
 * never sees). The `.agents/skills` loaders (Codex and the others) publish no
 * budget: their headroom is reported as UNKNOWN, never guessed.
 *
 * A missing layout directory is "0 skills" — present:false — not an error.
 * Reading never throws: an unreadable SKILL.md is skipped and counted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseSkillDoc } from './Drafter.js';

/** Claude Code's default skill-index budget (chars) — the loader's own figure, overridable by its env var. */
export const CLAUDE_SKILL_INDEX_CHAR_BUDGET = 15_000;
export const CLAUDE_SKILL_INDEX_BUDGET_ENV = 'SLASH_COMMAND_TOOL_CHAR_BUDGET';
/** The parity rule's description cap: what a loader would see at most per skill. */
const MAX_DESCRIPTION_LEN = 256;
/** Rough chars-per-token for the headroom-in-tokens figure handed to the models. */
const CHARS_PER_TOKEN = 4;

export type IndexLayout = 'claude' | 'agents';

export interface IndexLayoutReading {
  layout: IndexLayout;
  /** Repo-relative directory the loader reads. */
  dir: string;
  present: boolean;
  skills: number;
  /** Skill dirs whose SKILL.md could not be read or parsed (counted, never hidden). */
  unreadable: number;
  /** Bytes of `name: description` lines the loader indexes. */
  bytes: number;
  /** The loader's budget in chars, or null when the loader publishes none. */
  limitChars: number | null;
  /** limit − bytes (may be negative: the index is already over budget), or null when the limit is unknown. */
  headroomChars: number | null;
}

export interface IndexCostReading {
  at: string;
  layouts: IndexLayoutReading[];
  /** Sum over layouts. */
  totalBytes: number;
  totalSkills: number;
  /** The largest single description seen (bytes), for the "one draft cannot eat the budget" judgment. */
  largestDescriptionBytes: number;
  /** Claude's headroom in chars and tokens (the only loader with a published budget), or null. */
  claudeHeadroomChars: number | null;
  claudeHeadroomTokens: number | null;
}

/** The parity rule's sanitiser (control chars stripped, whitespace collapsed, capped) — what the loader indexes. */
export function sanitiseDescription(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = String(raw ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > MAX_DESCRIPTION_LEN ? `${cleaned.slice(0, MAX_DESCRIPTION_LEN - 3)}...` : cleaned;
}

/** Bytes one skill occupies in a loader's index: the `name: description` line. */
export function indexLineBytes(name: string, description: string): number {
  return Buffer.byteLength(`${name}: ${sanitiseDescription(description)}\n`, 'utf-8');
}

export function claudeIndexBudgetChars(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[CLAUDE_SKILL_INDEX_BUDGET_ENV];
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : CLAUDE_SKILL_INDEX_CHAR_BUDGET;
}

function readLayout(projectDir: string, layout: IndexLayout, limitChars: number | null): { reading: IndexLayoutReading; largest: number } {
  const dir = layout === 'claude' ? '.claude/skills' : '.agents/skills';
  const root = path.join(projectDir, dir);
  let entries: fs.Dirent[] | null = null;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { entries = null; } // @silent-fallback-ok — an absent layout is simply zero skills there (present:false)
  let skills = 0;
  let unreadable = 0;
  let bytes = 0;
  let largest = 0;
  for (const e of entries ?? []) {
    if (!e.isDirectory()) continue;
    let text: string;
    try { text = fs.readFileSync(path.join(root, e.name, 'SKILL.md'), 'utf-8'); } catch { continue; } // @silent-fallback-ok — a dir without SKILL.md is not a skill
    const doc = parseSkillDoc(text);
    if (!doc) { unreadable++; continue; }
    skills++;
    const line = indexLineBytes(doc.name || e.name, doc.description);
    bytes += line;
    const descBytes = Buffer.byteLength(sanitiseDescription(doc.description), 'utf-8');
    if (descBytes > largest) largest = descBytes;
  }
  return {
    reading: {
      layout, dir, present: entries !== null, skills, unreadable, bytes, limitChars,
      headroomChars: limitChars === null ? null : limitChars - bytes,
    },
    largest,
  };
}

/** Measure the rendered index under `projectDir` (synchronous; a few dozen small reads). */
export function measureIndexCost(input: { projectDir: string; env?: NodeJS.ProcessEnv; now?: () => number }): IndexCostReading {
  const claude = readLayout(input.projectDir, 'claude', claudeIndexBudgetChars(input.env ?? process.env));
  const agents = readLayout(input.projectDir, 'agents', null);
  const layouts = [claude.reading, agents.reading];
  return {
    at: new Date((input.now ?? (() => Date.now()))()).toISOString(),
    layouts,
    totalBytes: layouts.reduce((n, l) => n + l.bytes, 0),
    totalSkills: layouts.reduce((n, l) => n + l.skills, 0),
    largestDescriptionBytes: Math.max(claude.largest, agents.largest),
    claudeHeadroomChars: claude.reading.headroomChars,
    claudeHeadroomTokens: claude.reading.headroomChars === null ? null : Math.floor(claude.reading.headroomChars / CHARS_PER_TOKEN),
  };
}

/** The one-line, content-free statement of the measurement handed to the drafter and reviewer prompts. */
export function renderIndexCostLine(r: IndexCostReading | null): string {
  if (!r) return 'Measured skill index cost: unmeasured this tick.';
  const parts = r.layouts.map((l) => {
    if (!l.present) return `${l.dir}: absent (0 skills)`;
    const limit = l.limitChars === null ? 'loader limit unknown' : `limit ${l.limitChars} chars, headroom ${l.headroomChars}`;
    return `${l.dir}: ${l.skills} skills, ${l.bytes} bytes of descriptions (${limit})`;
  });
  const tokens = r.claudeHeadroomTokens === null ? 'unknown' : `~${r.claudeHeadroomTokens} tokens`;
  return `Measured skill index cost: ${parts.join('; ')}. Claude index headroom ${tokens}; largest description ${r.largestDescriptionBytes} bytes. ` +
    'Judge the description for scope ("Use when / Not for"), not for a counter: there is no library count limit.';
}
