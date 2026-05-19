/**
 * conversationalActionCatalog — discovery + rendering for the conversational
 * action catalog (Layer-3 primitive #10, v0.1).
 *
 * Spec: specs/instar-concepts/conversational-action.md
 *
 * Walks canonical skills under `.instar/skills/<name>/SKILL.md`, generates a
 * stable markdown block listing each one as a conversational action, and
 * idempotently inserts/replaces that block in canonical AGENT.md.
 *
 * v0.1 scope:
 *   - Catalog discovery + filtering.
 *   - Markdown block generation with delimiter comments.
 *   - Idempotent applyCatalogBlock() — insert or replace cleanly.
 *
 * v0.2 deferred:
 *   - `user-invocable: true` frontmatter filter (pending Skill v0.2 field surface).
 *   - Authed POST execution endpoints.
 *   - Per-action JSON Schema / action-shape declarations.
 *   - Wiring into FrameworkParitySentinel as a parity rule (catalog-drift detection).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const CANONICAL_SKILLS_ROOT = '.instar/skills';
const BLOCK_START = '<!-- instar:conversational-actions:start -->';
const BLOCK_END = '<!-- instar:conversational-actions:end -->';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface ConversationalAction {
  /** Canonical skill name (== slug == slash-command suffix) */
  name: string;
  /** Short description used in catalog entry + agent-side intent classification */
  description: string;
  /** Framework-agnostic invocation path. v0.1: always `/${name}` */
  invocation: string;
}

class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogError';
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function parseFrontmatter(raw: string): { fm: Record<string, unknown>; rest: string } {
  if (!raw.startsWith('---\n')) {
    return { fm: {}, rest: raw };
  }
  const close = raw.indexOf('\n---', 4);
  if (close < 0) {
    throw new CatalogError('skill SKILL.md has unterminated YAML frontmatter');
  }
  const fmRaw = raw.slice(4, close);
  let fm: unknown;
  try {
    fm = yaml.load(fmRaw, { schema: yaml.FAILSAFE_SCHEMA, json: false });
  } catch (err) {
    throw new CatalogError(`skill SKILL.md YAML parse error: ${(err as Error).message}`);
  }
  const rest = raw.slice(close + 4).replace(/^\n/, '');
  return { fm: (fm && typeof fm === 'object' ? fm : {}) as Record<string, unknown>, rest };
}

/**
 * Walk `.instar/skills/<name>/SKILL.md` under `projectRoot`, return the
 * discovered conversational actions sorted by name.
 *
 * v0.1: enumerates ALL canonical skills (no `user-invocable` filter).
 */
export async function discoverActions(projectRoot: string): Promise<ConversationalAction[]> {
  const skillsRoot = path.join(projectRoot, CANONICAL_SKILLS_ROOT);
  if (!(await pathExists(skillsRoot))) return [];
  const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  const actions: ConversationalAction[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!SLUG_RE.test(entry.name)) continue;
    const skillMdPath = path.join(skillsRoot, entry.name, 'SKILL.md');
    if (!(await pathExists(skillMdPath))) continue;
    let raw: string;
    try {
      raw = await fs.readFile(skillMdPath, 'utf-8');
    } catch {
      continue;
    }
    let parsed: { fm: Record<string, unknown>; rest: string };
    try {
      parsed = parseFrontmatter(raw);
    } catch {
      // Skip broken skills; the Skill parity rule surfaces them separately.
      continue;
    }
    const name = String(parsed.fm.name ?? entry.name);
    const description =
      typeof parsed.fm.description === 'string'
        ? parsed.fm.description
        : '(no description)';
    actions.push({
      name,
      description,
      invocation: `/${name}`,
    });
  }
  actions.sort((a, b) => a.name.localeCompare(b.name));
  return actions;
}

/**
 * Render the catalog markdown block (with start/end delimiter comments).
 *
 * Stable output — given the same actions list, returns the same string.
 * Pure function: no I/O. Caller decides where the block lands (typically a
 * Tier 2 ContextHierarchy segment, a SelfKnowledgeTree probe response, or a
 * Playbook context item — NOT inlined into AGENT.md, per the bloat-aware
 * design constraint documented in the concept spec).
 */
export function renderCatalogBlock(actions: ReadonlyArray<ConversationalAction>): string {
  const lines: string[] = [BLOCK_START, '## Conversational Actions', ''];
  if (actions.length === 0) {
    lines.push(
      '_No conversational actions installed yet. Install a skill under `.instar/skills/<name>/` to make it available here._',
    );
  } else {
    lines.push(
      'When the user expresses intent that maps to one of these, invoke the slash-command (or guide them conversationally to the equivalent action). You do not need to surface the slash-command name to the user — translate intent into invocation.',
      '',
    );
    for (const a of actions) {
      lines.push(`- \`${a.invocation}\` — ${a.description}`);
    }
  }
  lines.push('', BLOCK_END);
  return lines.join('\n') + '\n';
}

/*
 * NOTE: applyCatalogBlock(...) deliberately NOT exported in v0.1.
 *
 * Writing the catalog block directly into AGENT.md (the always-loaded Tier 0
 * identity file) is the AGENT.md-bloat antipattern Instar built three
 * defenses against (ContextHierarchy, Playbook, SelfKnowledgeTree). The
 * catalog block is returned as a string from renderCatalogBlock(); the
 * caller (a v0.2 ContextHierarchy Tier 2 segment writer, a SelfKnowledgeTree
 * probe handler, or a Playbook context item) decides where it lands.
 *
 * See specs/instar-concepts/conversational-action.md ("Bloat-awareness as a
 * v0.1 design constraint") for the full rationale.
 */

export const _internals = { parseFrontmatter, BLOCK_START, BLOCK_END };
