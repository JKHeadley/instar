/**
 * Lint — the structural lint (deterministic, `invariant`: a failure REFUSES the
 * draft) and the semantic flags (signals, `judgment-candidate`: handed to the
 * cross-family reviewer, never a refusal) for a candidate SKILL.md
 * (docs/specs/skill-learning-sentinel.md §3.5, §4).
 *
 * Structural rules (each refusal names its rule):
 *   - `name-grammar`            the concept spec's slug grammar;
 *   - `description-length`      <= 256 chars (the loader's sanitised bound — a prompt-injection bound);
 *   - `description-use-when`    contains "use when";
 *   - `description-not-for`     contains "not for" / "not when";
 *   - `body-limit`              body within `bodyMaxChars` (see DRAFT_BODY_MAX_CHARS);
 *   - `body-empty`              a draft with no steps is not a skill;
 *   - `no-scripts`              no `scripts/` directory or reference;
 *   - `credential`              the repo's credential shapes (src/core/credentialShapes.ts) find nothing;
 *   - `reference-provenance`    every URL / route / path in the body appears in an operator message
 *                               or a tool-call TARGET (never a result, never an args excerpt);
 *   - `name-collision`          no existing skill carries the name (the patch target exempt);
 *   - `attribution-src`         a line attributing a wish/rule to the operator carries a `src:` /
 *                               `pref:` ref, or is phrased as the agent's own reading;
 *   - `transcript-excerpt`      no transcript rows and no sentence copied from a tool-call args excerpt;
 *   - `metadata-flat`           learned metadata values are flat strings.
 *
 * Semantic flags (never refuse here):
 *   - `description-overlap`     token Jaccard >= 0.6 against any hand-written description;
 *   - `policy-relaxation`       the correction sentinel's policy-relaxation keyword list;
 *   - `ungrounded-state-step`   a step that reports state without naming the registry/route it reads.
 */

import { CREDENTIAL_SHAPES } from '../../core/credentialShapes.js';
import { matchesPolicyRelaxation } from '../CorrectionLoopDriver.js';
import type { ParsedSkillDoc, ReviewFlag } from './Drafter.js';
import { SKILL_NAME_RE } from './types.js';

/** The concept spec's sanitised description bound (specs/instar-concepts/skill.md). */
export const DESCRIPTION_MAX_CHARS = 256;

/**
 * The body bound a draft must fit. Neither framework skills spec
 * (specs/frameworks/claude-code/skills.md, specs/frameworks/codex-cli/skills.md,
 * read 2026-11-06) documents a physical body cap — both load the body verbatim
 * into context when the skill triggers — so there is no loader number to copy.
 * This is therefore the DRAFTER's own output bound, recorded beside its check
 * (a learned skill is "lessons, not logs"; 32 K chars is ~8 K tokens of
 * context per trigger). The sentinel passes it in; a caller with a measured
 * framework limit overrides it here, never silently elsewhere.
 */
export const DRAFT_BODY_MAX_CHARS = 32 * 1024;

export type LintRule =
  | 'name-grammar' | 'description-length' | 'description-use-when' | 'description-not-for'
  | 'body-limit' | 'body-empty' | 'no-scripts' | 'credential' | 'reference-provenance'
  | 'name-collision' | 'attribution-src' | 'transcript-excerpt' | 'metadata-flat';

export type SemanticRule = 'description-overlap' | 'policy-relaxation' | 'ungrounded-state-step';

export interface LintRefusal { rule: LintRule; detail: string }

export interface LintContext {
  /** Scrubbed operator messages the drafter saw (§3.5 input 1). */
  operatorMessages: string[];
  /** Tool-call TARGETS from the run slices (§3.5 input 2) — never results. */
  toolTargets: string[];
  /** The args excerpts the drafter saw — any sentence from them in the body is a transcript excerpt. */
  argsExcerpts: string[];
  /** Every existing skill name (canonical + renderings). */
  existingSkillNames: string[];
  /** Descriptions of HAND-WRITTEN skills (the overlap flag's comparison set). */
  handWrittenDescriptions: string[];
  /** The patch target, exempt from the collision rule. */
  patchTarget?: string;
  bodyMaxChars?: number;
}

export interface LintResult {
  refusals: LintRefusal[];
  flags: ReviewFlag[];
  ok: boolean;
}

const URL_RE = /\bhttps?:\/\/[^\s)>\]"'`]+/g;
/** A route: `/words` with at least one letter, optionally with a method before it. */
const ROUTE_RE = /(?:^|[\s(`"'])((?:GET|POST|PUT|PATCH|DELETE)\s+)?(\/[a-z][a-z0-9_-]*(?:\/[a-z0-9:_.-]+)*)(?=[\s)`"'.,;:]|$)/gi;
/** A path: two or more segments joined by `/`, or a dot-dir like `.instar/x`. */
const PATH_RE = /(?:^|[\s(`"'])((?:\.{1,2}\/|~\/|\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)(?=[\s)`"'.,;:]|$)/g;
const ATTRIBUTION_RE = /\b(the operator|the user|justin|he|she|they)\b[^.\n]{0,80}\b(said|says|asked|asks|told|tells|requested|requests|prefers?|wants?|instructed|insists?|likes?)\b/i;
const OWN_READING_RE = /\b(my reading|as i (read|understand)|i read this as|in my view|i take this to mean)\b/i;
const SRC_REF_RE = /\b(src|pref):\s*\S+/i;
const TRANSCRIPT_ROW_RE = /^\s*(\[step\]|→\s*result|\{"type"\s*:\s*"(tool_use|tool_result)"|"tool_use_id"\s*:)/m;
/** A step that REPORTS live state (status/health/quota…) — not one that summarises objects it already read. */
const STATE_REPORT_RE = /\b(report|tell|say|summari[sz]e|show|describe)\b[^.\n]{0,60}\b(status|state|health|running|quota|usage|uptime|availability)\b/i;
const GROUNDING_RE = /(\/[a-z][a-z0-9_-]*(\/[a-z0-9:_.-]+)*|\bGET\b|\bPOST\b|\bcurl\b|\bregistry\b|\bendpoint\b|\broute\b|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|`[^`]+`)/;

function stripTrailingPunct(s: string): string {
  return s.replace(/[.,;:)\]'"`]+$/, '');
}

export function extractReferences(body: string): string[] {
  const refs = new Set<string>();
  for (const m of body.matchAll(URL_RE)) refs.add(stripTrailingPunct(m[0]));
  for (const m of body.matchAll(ROUTE_RE)) refs.add(stripTrailingPunct(m[2]));
  for (const m of body.matchAll(PATH_RE)) {
    const p = stripTrailingPunct(m[1]);
    if (/^https?:/.test(p)) continue;
    if (/^\d+(\.\d+)*\/\d/.test(p)) continue;           // 1/2 style fractions
    refs.add(p);
  }
  return [...refs];
}

/** Token Jaccard over lowercase word tokens (>= 3 chars), the §3.5 overlap signal. */
export function jaccard(a: string, b: string): number {
  const tok = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  const A = tok(a); const B = tok(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Every string value inside a JSON excerpt (an Edit payload's new_string, a Bash command…); the raw text when it is not JSON (a cut excerpt). */
function excerptTexts(excerpt: string): string[] {
  try {
    const out: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'string') out.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
    };
    walk(JSON.parse(excerpt));
    return out;
  } catch {
    // A cut excerpt is not valid JSON: strip the JSON scaffolding around the text instead.
    return [excerpt.replace(/\\n/g, ' ').replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9.!?]+$/, '')];
  }
}

/** Sentences of >= 40 chars from an args excerpt — the units a draft must not copy. */
function excerptSentences(excerpt: string): string[] {
  return excerptTexts(excerpt)
    .flatMap((t) => t.replace(/\\n/g, ' ').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+|,\s+/))
    .map((s) => s.trim().replace(/^"+|"+$/g, ''))
    .filter((s) => s.length >= 40);
}

export function lintDraft(doc: ParsedSkillDoc, ctx: LintContext): LintResult {
  const refusals: LintRefusal[] = [];
  const flags: ReviewFlag[] = [];
  const bodyMax = Math.max(1024, ctx.bodyMaxChars ?? DRAFT_BODY_MAX_CHARS);
  const body = doc.body;
  const lines = body.split('\n');

  if (!SKILL_NAME_RE.test(doc.name) || doc.name.length > 64) refusals.push({ rule: 'name-grammar', detail: `name "${doc.name}" fails the slug grammar` });
  if (doc.description.length > DESCRIPTION_MAX_CHARS) refusals.push({ rule: 'description-length', detail: `${doc.description.length} > ${DESCRIPTION_MAX_CHARS} chars` });
  if (!/\buse when\b/i.test(doc.description)) refusals.push({ rule: 'description-use-when', detail: 'description lacks "use when"' });
  if (!/\bnot (for|when)\b/i.test(doc.description)) refusals.push({ rule: 'description-not-for', detail: 'description lacks "not for" / "not when"' });
  if (body.length > bodyMax) refusals.push({ rule: 'body-limit', detail: `${body.length} > ${bodyMax} chars` });
  if (body.trim().length < 20) refusals.push({ rule: 'body-empty', detail: 'body has no steps' });
  if (/\bscripts\//.test(body) || /\bscripts\//.test(doc.description)) refusals.push({ rule: 'no-scripts', detail: 'a scripts/ reference is not allowed in a learned skill' });

  const whole = `${doc.name}\n${doc.description}\n${Object.values(doc.metadata).join('\n')}\n${body}`;
  for (const { name, pattern } of CREDENTIAL_SHAPES) {
    if (pattern.test(whole)) { refusals.push({ rule: 'credential', detail: `${name} shape present` }); break; }
  }

  // Provenance of references: grounded only in operator messages or tool-call TARGETS.
  const grounding = [...ctx.operatorMessages, ...ctx.toolTargets].join('\n');
  for (const ref of extractReferences(body)) {
    if (!grounding.includes(ref)) refusals.push({ rule: 'reference-provenance', detail: `"${ref}" appears in neither an operator message nor a tool-call target` });
  }

  if (ctx.existingSkillNames.includes(doc.name) && doc.name !== ctx.patchTarget) {
    refusals.push({ rule: 'name-collision', detail: `a skill named "${doc.name}" already exists` });
  }

  for (const line of lines) {
    if (ATTRIBUTION_RE.test(line) && !SRC_REF_RE.test(line) && !OWN_READING_RE.test(line)) {
      refusals.push({ rule: 'attribution-src', detail: `attribution without a src: ref: "${line.trim().slice(0, 120)}"` });
    }
  }

  if (TRANSCRIPT_ROW_RE.test(body)) refusals.push({ rule: 'transcript-excerpt', detail: 'transcript rows present' });
  const sentences = ctx.argsExcerpts.flatMap(excerptSentences);
  for (const s of sentences) {
    if (body.includes(s)) { refusals.push({ rule: 'transcript-excerpt', detail: `a sentence from a tool-call args excerpt is copied: "${s.slice(0, 80)}"` }); break; }
  }

  for (const [k, v] of Object.entries(doc.metadata)) {
    if (typeof v !== 'string') refusals.push({ rule: 'metadata-flat', detail: `metadata.${k} is not a flat string` });
  }

  // ── Semantic flags (signals) ──
  let fid = 0;
  const flag = (rule: SemanticRule, line: string, detail: string) => flags.push({ id: `F${++fid}`, rule, line: line.trim().slice(0, 200), detail });
  for (const hw of ctx.handWrittenDescriptions) {
    const j = jaccard(doc.description, hw);
    if (j >= 0.6) { flag('description-overlap', doc.description, `Jaccard ${j.toFixed(2)} with a hand-written description: "${hw.slice(0, 80)}"`); break; }
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    if (matchesPolicyRelaxation(line)) flag('policy-relaxation', line, 'matches the correction sentinel\'s policy-relaxation keyword list');
    else if (STATE_REPORT_RE.test(line) && !GROUNDING_RE.test(line)) flag('ungrounded-state-step', line, 'reports state without naming the registry/route it reads');
  }

  return { refusals, flags, ok: refusals.length === 0 };
}
