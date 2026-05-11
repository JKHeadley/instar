/**
 * PlanDocParser — turn a markdown plan doc into a project seed plus child
 * seeds for the InitiativeTracker.
 *
 * Spec: docs/specs/PROJECT-SCOPE-SPEC.md Phase 1.6.
 *
 * Frontmatter schema (validated; unknown keys rejected):
 *   kind: project                      (required)
 *   id: <slug>                         (required; ^[a-z0-9][a-z0-9-]{0,63}$)
 *   title: <string>                    (required)
 *   status: active                     (required)
 *   owner: <string>                    (required)
 *   target_repo_path: <absolute path>  (required; must exist as a directory)
 *   source_docs: [<rel path>, ...]     (required; each jailed under target_repo_path)
 *   goal: <string>                     (required)
 *   auto_advance: true|false           (optional, default true)
 *   telegram_topic_id: <string>        (optional)
 *   defers: [<slug>, ...]              (optional)
 *
 * Body schema: tables under `### Tier N …` headers with columns
 *   | # | Item | Source | Effort |
 *   |---|------|--------|--------|
 *   | 1 | foo  | bar    | s      |
 *
 * Each row becomes a child seed at `pipelineStage: 'outline'` carrying
 * `parentProjectId`, `sourceTag`, `effortTag`, and `roundName` (the tier
 * header, e.g. "Tier 1 — first three").
 *
 * `parsePlanDoc` returns `errors[]` rather than throwing. The caller
 * decides whether to persist on partial errors. The HTTP layer maps any
 * non-empty `errors[]` from `POST /projects` to 400.
 */

import fs from 'node:fs';
import path from 'node:path';
import { extractFrontmatter } from './SafeYaml.js';
import { jailPath } from './StageTransitionValidator.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const ALLOWED_FRONTMATTER_KEYS = new Set([
  'kind',
  'id',
  'title',
  'status',
  'owner',
  'target_repo_path',
  'source_docs',
  'goal',
  'auto_advance',
  'telegram_topic_id',
  'defers',
  // Allow the unarchive flag from spec Phase 1.6 (slug-reuse path).
  'unarchive',
]);

export interface ProjectSeed {
  id: string;
  title: string;
  status: 'active';
  owner: string;
  targetRepoPath: string;
  sourceDocs: string[];
  description: string;          // = `goal` (mapped to Initiative.description)
  autoAdvance?: boolean;
  telegramTopicId?: string;
  defers?: string[];
  unarchive?: boolean;
}

export interface ChildSeed {
  id: string;
  title: string;
  sourceTag: string;
  effortTag: string;
  pipelineStage: 'outline';
  parentProjectId: string;
  /** "Tier 1 — first three", taken from the section header. */
  roundName: string;
}

export interface ParsedPlanDoc {
  project: ProjectSeed | null;
  children: ChildSeed[];
  errors: string[];
}

export async function parsePlanDoc(absPath: string): Promise<ParsedPlanDoc> {
  const errors: string[] = [];
  if (!path.isAbsolute(absPath)) {
    return { project: null, children: [], errors: [`planDocPath must be absolute, got "${absPath}"`] };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(absPath, 'utf-8');
  } catch (err) {
    return {
      project: null,
      children: [],
      errors: [`could not read plan doc: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  if (raw.length > 256 * 1024) {
    return { project: null, children: [], errors: ['plan doc exceeds 256 KB cap'] };
  }

  const fm = extractFrontmatter(raw);
  if (fm.error) errors.push(`frontmatter error: ${fm.error}`);
  if (!fm.frontmatter) {
    errors.push('plan doc is missing a YAML frontmatter block');
    return { project: null, children: [], errors };
  }

  const project = validateProjectFrontmatter(fm.frontmatter, errors);
  if (!project) {
    return { project: null, children: [], errors };
  }

  // Walk the body for tier sections.
  const children = parseTierTables(fm.body, project.id, errors);

  // Append children to round names (sourced from tier headers).

  return { project, children, errors };
}

function validateProjectFrontmatter(
  data: Record<string, unknown>,
  errors: string[]
): ProjectSeed | null {
  // Unknown keys?
  for (const key of Object.keys(data)) {
    if (!ALLOWED_FRONTMATTER_KEYS.has(key)) {
      errors.push(`unknown frontmatter key "${key}"`);
    }
  }
  const must = (k: string, type: 'string' | 'boolean' | 'array') => {
    const v = data[k];
    if (v === undefined || v === null || v === '') {
      errors.push(`"${k}" is required`);
      return false;
    }
    if (type === 'string' && typeof v !== 'string') {
      errors.push(`"${k}" must be a string`);
      return false;
    }
    if (type === 'boolean' && typeof v !== 'boolean') {
      errors.push(`"${k}" must be a boolean`);
      return false;
    }
    if (type === 'array' && !Array.isArray(v)) {
      errors.push(`"${k}" must be an array`);
      return false;
    }
    return true;
  };
  if (data.kind !== 'project') {
    errors.push(`"kind" must be "project", got "${String(data.kind)}"`);
    return null;
  }
  if (!must('id', 'string')) return null;
  if (!SLUG_RE.test(data.id as string)) {
    errors.push(`"id" must match ${SLUG_RE.source}`);
    return null;
  }
  if (!must('title', 'string')) return null;
  if ((data.title as string).length > 200) {
    errors.push('"title" must be ≤ 200 chars');
    return null;
  }
  if (data.status !== 'active') {
    errors.push('"status" must be "active"');
    return null;
  }
  if (!must('owner', 'string')) return null;
  if (!must('target_repo_path', 'string')) return null;
  const targetRepoPath = data.target_repo_path as string;
  if (!path.isAbsolute(targetRepoPath)) {
    errors.push('"target_repo_path" must be an absolute path');
    return null;
  }
  if (!fs.existsSync(targetRepoPath) || !fs.statSync(targetRepoPath).isDirectory()) {
    errors.push(`"target_repo_path" does not exist or is not a directory: ${targetRepoPath}`);
    return null;
  }
  if (!must('source_docs', 'array')) return null;
  const sourceDocs: string[] = [];
  for (const sd of data.source_docs as unknown[]) {
    if (typeof sd !== 'string' || !sd.trim()) {
      errors.push('"source_docs" entries must be non-empty strings');
      continue;
    }
    const jailed = jailPath(targetRepoPath, sd);
    if (!jailed.ok) {
      errors.push(`source_docs entry "${sd}" escapes target_repo_path: ${jailed.reason}`);
      continue;
    }
    sourceDocs.push(sd);
  }
  if (sourceDocs.length === 0) {
    errors.push('"source_docs" must contain at least one valid path');
    return null;
  }
  if (!must('goal', 'string')) return null;
  const goal = data.goal as string;
  if (goal.length > 4000) {
    errors.push('"goal" must be ≤ 4000 chars');
    return null;
  }
  let autoAdvance: boolean | undefined;
  if (data.auto_advance !== undefined) {
    if (typeof data.auto_advance !== 'boolean') {
      errors.push('"auto_advance" must be a boolean');
      return null;
    }
    autoAdvance = data.auto_advance;
  }
  let telegramTopicId: string | undefined;
  if (data.telegram_topic_id !== undefined) {
    if (typeof data.telegram_topic_id !== 'string') {
      errors.push('"telegram_topic_id" must be a string');
      return null;
    }
    telegramTopicId = data.telegram_topic_id;
  }
  let defers: string[] | undefined;
  if (data.defers !== undefined) {
    if (!Array.isArray(data.defers)) {
      errors.push('"defers" must be an array');
      return null;
    }
    const arr: string[] = [];
    for (const d of data.defers) {
      if (typeof d !== 'string' || !SLUG_RE.test(d)) {
        errors.push(`"defers" entries must match slug regex; got "${String(d)}"`);
        return null;
      }
      arr.push(d);
    }
    defers = arr;
  }
  let unarchive: boolean | undefined;
  if (data.unarchive !== undefined) {
    if (typeof data.unarchive !== 'boolean') {
      errors.push('"unarchive" must be a boolean');
      return null;
    }
    unarchive = data.unarchive;
  }

  return {
    id: data.id as string,
    title: data.title as string,
    status: 'active',
    owner: data.owner as string,
    targetRepoPath,
    sourceDocs,
    description: goal,
    autoAdvance,
    telegramTopicId,
    defers,
    unarchive,
  };
}

const TIER_HEADER_RE = /^###\s+(Tier\s+\d+[^\n]*)$/;
const SLUG_FROM_TITLE_RE = /[^a-z0-9]+/g;

function parseTierTables(body: string, projectId: string, errors: string[]): ChildSeed[] {
  const children: ChildSeed[] = [];
  const seenIds = new Set<string>();
  const lines = body.split(/\r?\n/);

  let i = 0;
  let currentTier: string | null = null;
  while (i < lines.length) {
    const line = lines[i];
    const headerMatch = line.match(TIER_HEADER_RE);
    if (headerMatch) {
      currentTier = headerMatch[1].trim();
      i++;
      continue;
    }
    // Detect a table: a header row starting with `|` followed by a separator row.
    if (currentTier && line.trim().startsWith('|')) {
      const headerCells = splitRow(line);
      const sepIdx = i + 1;
      if (sepIdx < lines.length && /^\s*\|?\s*[-: ]+/.test(lines[sepIdx])) {
        // Validate column layout.
        const colMap = mapColumns(headerCells);
        if (!colMap) {
          errors.push(`tier "${currentTier}" has a table but column headers don't match "# | Item | Source | Effort"`);
          // Skip the malformed table.
          i = sepIdx + 1;
          while (i < lines.length && lines[i].trim().startsWith('|')) i++;
          continue;
        }
        let r = sepIdx + 1;
        while (r < lines.length && lines[r].trim().startsWith('|')) {
          const row = splitRow(lines[r]);
          const numCell = row[colMap.numIdx] ?? '';
          const itemCell = row[colMap.itemIdx] ?? '';
          const sourceCell = row[colMap.sourceIdx] ?? '';
          const effortCell = row[colMap.effortIdx] ?? '';
          if (!itemCell.trim()) {
            r++;
            continue;
          }
          const derivedId = deriveChildId(projectId, numCell, itemCell);
          if (!SLUG_RE.test(derivedId)) {
            errors.push(`derived child id "${derivedId}" is not a valid slug (from row "${itemCell}")`);
            r++;
            continue;
          }
          if (seenIds.has(derivedId)) {
            errors.push(`duplicate child id "${derivedId}" in plan doc`);
            r++;
            continue;
          }
          seenIds.add(derivedId);
          children.push({
            id: derivedId,
            title: itemCell.trim().slice(0, 200),
            sourceTag: sourceCell.trim(),
            effortTag: effortCell.trim(),
            pipelineStage: 'outline',
            parentProjectId: projectId,
            roundName: currentTier,
          });
          r++;
        }
        i = r;
        continue;
      }
    }
    i++;
  }
  return children;
}

function splitRow(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((c) => c.trim());
}

function mapColumns(cells: string[]):
  | { numIdx: number; itemIdx: number; sourceIdx: number; effortIdx: number }
  | null {
  const lower = cells.map((c) => c.toLowerCase());
  const numIdx = lower.findIndex((c) => c === '#' || c === 'no' || c === 'num');
  const itemIdx = lower.findIndex((c) => c === 'item' || c === 'name' || c === 'feature');
  const sourceIdx = lower.findIndex((c) => c === 'source' || c === 'origin');
  const effortIdx = lower.findIndex((c) => c === 'effort' || c === 'size');
  if (numIdx === -1 || itemIdx === -1 || sourceIdx === -1 || effortIdx === -1) return null;
  return { numIdx, itemIdx, sourceIdx, effortIdx };
}

function deriveChildId(projectId: string, numCell: string, itemCell: string): string {
  const numTrim = numCell.trim();
  // Prefer explicit slug-like numbering ("1", "2a"); otherwise use slugified title.
  if (numTrim && /^[a-z0-9][a-z0-9-]{0,16}$/.test(numTrim.toLowerCase())) {
    return `${projectId}-${numTrim.toLowerCase()}`;
  }
  const slugified = itemCell
    .toLowerCase()
    .replace(SLUG_FROM_TITLE_RE, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${projectId}-${slugified}`;
}
