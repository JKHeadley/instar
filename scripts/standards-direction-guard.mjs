// safe-git-allow: CI bootstrap uses read-only merge-base/show before TypeScript is compiled.
/**
 * Direction-aware constitutional amendment guard.
 *
 * Mechanical facts (article identity, addition, removal, population) come from
 * the protected base and candidate registries. Semantic direction for an edit
 * is declared, then independently ratified with an Ed25519 signature over the
 * exact before/after bytes. A repository file written by the changer is never
 * authority by itself.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ARTICLE_ID_RE, articleIds, parseRegistryStructure } from './standards-registry-article-core.mjs';

export const DIRECTION_APPROVAL_SCHEMA_VERSION = 1;
export const DIRECTION_GUARD_SYMBOL = 'evaluateStandardsDirection';
const FIELD_RE = /^\*\*(.+?)\.\*\*\s*(.*)$/;
const DIRECTIONS = new Set(['add', 'remove', 'strengthen', 'neutral', 'weaken']);
const SHA256_RE = /^[a-f0-9]{64}$/;
const RFC3339_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const canonicalText = (value) => String(value).replace(/\r\n?/g, '\n');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isObject(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const familyName = (heading) => heading.split(/\s+[—–-]\s+/)[0].trim();

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function canonicalDirectionPayload(payload) {
  return `standards-direction-ratification-v1\0${JSON.stringify(stableValue(payload))}`;
}

function slug(value) {
  return value.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function fieldsFor(block) {
  const fields = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    fields.push({ heading: current.heading, text: current.lines.join('\n').trim() });
    current = null;
  };
  for (const line of block.visibleLines) {
    if (line === null) continue;
    const match = line.match(FIELD_RE);
    if (match) {
      flush();
      current = { heading: match[1].trim(), lines: [match[2]] };
    } else if (current) current.lines.push(line);
  }
  flush();
  return fields;
}

/** Resolve every Rule-bearing article to a closed, unique identity set. */
export function inventoryStandardsArticles(markdown) {
  const text = canonicalText(markdown);
  const articles = [];
  const errors = [];
  const identities = new Set();
  let parsedRuleMarkers = 0;

  for (const section of parseRegistryStructure(text)) {
    const family = familyName(section.heading);
    for (const block of section.blocks) {
      const fields = fieldsFor(block);
      const rules = fields.filter((field) => field.heading === 'Rule');
      if (rules.length === 0) continue;
      parsedRuleMarkers += rules.length;
      if (rules.length !== 1) {
        errors.push(`article "${block.name}" must contain exactly one Rule field (found ${rules.length})`);
        continue;
      }
      const explicitIds = articleIds(block);
      if (explicitIds.length > 1) {
        errors.push(`article "${block.name}" has duplicate Article ID declarations`);
        continue;
      }
      if (explicitIds.length === 1 && !ARTICLE_ID_RE.test(explicitIds[0])) {
        errors.push(`article "${block.name}" has invalid Article ID "${explicitIds[0]}"`);
        continue;
      }
      const id = explicitIds[0] ?? `legacy/${slug(family)}/${slug(block.name)}`;
      if (identities.has(id)) {
        errors.push(`article identity collision for "${id}"`);
        continue;
      }
      identities.add(id);
      const rule = rules[0].text;
      articles.push({
        id,
        family,
        name: block.name,
        rule,
        ruleSha256: sha256(`standards-rule-v1\0${rule}`),
        articleSha256: sha256(`standards-article-v1\0${canonicalText(block.raw)}`),
      });
    }
  }

  const rawRuleMarkers = text.split('\n').filter((line) => /^\*\*Rule\.\*\*/.test(line)).length;
  if (rawRuleMarkers !== parsedRuleMarkers || parsedRuleMarkers !== articles.length) {
    errors.push(
      `article enumeration is open: raw Rule fields=${rawRuleMarkers}, parsed Rule fields=${parsedRuleMarkers}, identities=${articles.length}`,
    );
  }
  if (articles.length === 0) errors.push('standards article population is empty (NOT-PROVEN, never 0/0 clean)');
  return { articles, errors };
}

function articleSummary(article) {
  if (!article) return null;
  return {
    id: article.id,
    family: article.family,
    name: article.name,
    ruleSha256: article.ruleSha256,
    articleSha256: article.articleSha256,
  };
}

function changeKind(before, after) {
  if (!before) return 'add';
  if (!after) return 'remove';
  return 'edit';
}

function directionLabel(direction, kind) {
  if (kind === 'remove') return 'REMOVAL';
  if (kind === 'add') return 'ADDITION';
  if (direction === 'weaken') return 'WEAKENING';
  if (direction === 'strengthen') return 'STRENGTHENING';
  if (direction === 'neutral') return 'NEUTRAL EDIT';
  return 'DIRECTION UNDECLARED';
}

function validTimestamp(value) {
  if (typeof value !== 'string' || !RFC3339_UTC_RE.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function verifyApprovalSignature(payload, signature, publicKeyPem) {
  if (typeof signature !== 'string' || signature.length < 40 || typeof publicKeyPem !== 'string') return false;
  try {
    const key = crypto.createPublicKey(publicKeyPem);
    return crypto.verify(
      null,
      Buffer.from(canonicalDirectionPayload(payload), 'utf8'),
      key,
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
}

function validateApprovalShape(entry) {
  if (!exactKeys(entry, ['payload', 'signature'])) return 'must contain exactly payload and signature';
  const payload = entry.payload;
  if (!exactKeys(payload, [
    'schemaVersion', 'baseRevision', 'baseRegistrySha256', 'candidateRegistrySha256',
    'articleId', 'change', 'direction', 'before', 'after', 'approvedBy', 'approvedAt',
  ])) return 'payload has unknown or missing fields';
  if (payload.schemaVersion !== DIRECTION_APPROVAL_SCHEMA_VERSION) return 'payload schemaVersion is unsupported';
  if (!['add', 'remove', 'edit'].includes(payload.change) || !DIRECTIONS.has(payload.direction)) return 'payload change/direction is invalid';
  if (typeof payload.baseRevision !== 'string' || payload.baseRevision.length < 1 || payload.baseRevision.length > 160) return 'payload baseRevision is invalid';
  if (!SHA256_RE.test(payload.baseRegistrySha256) || !SHA256_RE.test(payload.candidateRegistrySha256)) return 'payload registry digest is invalid';
  if (typeof payload.articleId !== 'string' || payload.articleId.length < 3 || payload.articleId.length > 180) return 'payload articleId is invalid';
  if (typeof payload.approvedBy !== 'string' || payload.approvedBy.trim().length < 2 || payload.approvedBy.length > 120) return 'payload approvedBy is invalid';
  if (!validTimestamp(payload.approvedAt) || Date.parse(payload.approvedAt) > Date.now() + 5 * 60_000) return 'payload approvedAt is invalid';
  for (const [which, summary] of [['before', payload.before], ['after', payload.after]]) {
    if (summary === null) continue;
    if (!exactKeys(summary, ['id', 'family', 'name', 'ruleSha256', 'articleSha256']) ||
      typeof summary.id !== 'string' || typeof summary.family !== 'string' || typeof summary.name !== 'string' ||
      !SHA256_RE.test(summary.ruleSha256) || !SHA256_RE.test(summary.articleSha256)) {
      return `payload ${which} summary is invalid`;
    }
  }
  return null;
}

function parseApprovalLedger(value) {
  const errors = [];
  if (!exactKeys(value, ['schemaVersion', 'approvals']) ||
    value.schemaVersion !== DIRECTION_APPROVAL_SCHEMA_VERSION || !Array.isArray(value.approvals)) {
    return { approvals: [], errors: ['direction approval ledger must contain exactly schemaVersion: 1 and approvals[]'] };
  }
  const approvals = [];
  for (const [index, entry] of value.approvals.entries()) {
    const error = validateApprovalShape(entry);
    if (error) errors.push(`direction approval ${index} ${error}`);
    else approvals.push(entry);
  }
  return { approvals, errors };
}

function familyPopulation(articles) {
  const map = new Map();
  for (const article of articles) {
    if (!map.has(article.family)) map.set(article.family, new Set());
    map.get(article.family).add(article.id);
  }
  return map;
}

/**
 * Evaluate candidate constitutional direction against a protected base.
 * This exact export is imported by the pipeline and its negative-control test.
 */
export function evaluateStandardsDirection({
  baseMarkdown,
  candidateMarkdown,
  approvalLedger = { schemaVersion: 1, approvals: [] },
  approverPublicKeyPem = '',
  candidateApproverPublicKeyPem = null,
  baseRevision = 'unknown-protected-base',
}) {
  const base = inventoryStandardsArticles(baseMarkdown);
  const candidate = inventoryStandardsArticles(candidateMarkdown);
  const ledger = parseApprovalLedger(approvalLedger);
  const errors = [
    ...base.errors.map((error) => `protected base: ${error}`),
    ...candidate.errors.map((error) => `candidate: ${error}`),
    ...ledger.errors,
  ];
  if (candidateApproverPublicKeyPem !== null && candidateApproverPublicKeyPem !== approverPublicKeyPem) {
    errors.push(
      'APPROVER TRUST ROOT CHANGE is not self-authorizable: candidate pin differs from protected base; ' +
      'bootstrap or rotation requires external protected-main control-plane authorization',
    );
  }
  const baseRegistrySha256 = sha256(canonicalText(baseMarkdown));
  const candidateRegistrySha256 = sha256(canonicalText(candidateMarkdown));
  const baseById = new Map(base.articles.map((article) => [article.id, article]));
  const candidateById = new Map(candidate.articles.map((article) => [article.id, article]));
  const ids = [...new Set([...baseById.keys(), ...candidateById.keys()])].sort();
  const changes = [];

  for (const id of ids) {
    const before = baseById.get(id) ?? null;
    const after = candidateById.get(id) ?? null;
    if (before && after && before.articleSha256 === after.articleSha256 &&
      before.family === after.family && before.name === after.name) continue;
    changes.push({ id, kind: changeKind(before, after), before, after });
  }

  const basePopulation = familyPopulation(base.articles);
  const candidatePopulation = familyPopulation(candidate.articles);
  const families = [...new Set([...basePopulation.keys(), ...candidatePopulation.keys()])].sort();
  const byFamily = {};
  for (const family of families) {
    const baseIds = basePopulation.get(family) ?? new Set();
    const candidateIds = candidatePopulation.get(family) ?? new Set();
    byFamily[family] = {
      protectedBase: baseIds.size,
      candidate: candidateIds.size,
      continuity: new Set([...baseIds, ...candidateIds]).size,
    };
  }

  for (const change of changes) {
    const matching = ledger.approvals.filter(({ payload }) =>
      payload.baseRegistrySha256 === baseRegistrySha256 &&
      payload.candidateRegistrySha256 === candidateRegistrySha256 &&
      payload.articleId === change.id);
    const displayName = change.after?.name ?? change.before?.name ?? change.id;
    if (matching.length === 0) {
      errors.push(
        `${directionLabel(null, change.kind)} "${displayName}" (${change.id}) requires an independently signed direction ratification`,
      );
      continue;
    }
    if (matching.length > 1) {
      errors.push(`article "${displayName}" has multiple ratifications for the same protected-base/candidate pair`);
      continue;
    }
    const approval = matching[0];
    const direction = approval.payload.direction;
    const expectedDirection = change.kind === 'add' ? 'add' : change.kind === 'remove' ? 'remove' : direction;
    const expectedPayload = {
      schemaVersion: DIRECTION_APPROVAL_SCHEMA_VERSION,
      baseRevision,
      baseRegistrySha256,
      candidateRegistrySha256,
      articleId: change.id,
      change: change.kind,
      direction: expectedDirection,
      before: articleSummary(change.before),
      after: articleSummary(change.after),
      approvedBy: approval.payload.approvedBy,
      approvedAt: approval.payload.approvedAt,
    };
    const label = directionLabel(direction, change.kind);
    if (change.kind === 'edit' && !['strengthen', 'neutral', 'weaken'].includes(direction)) {
      errors.push(`${label} "${displayName}" has invalid edit direction "${direction}"`);
      continue;
    }
    if (JSON.stringify(stableValue(approval.payload)) !== JSON.stringify(stableValue(expectedPayload))) {
      errors.push(`${label} "${displayName}" ratification does not bind the exact protected-base/candidate article bytes`);
      continue;
    }
    if (!verifyApprovalSignature(approval.payload, approval.signature, approverPublicKeyPem)) {
      errors.push(`${label} "${displayName}" lacks a valid different-principal signature`);
      continue;
    }
    change.direction = direction;
    change.approvedBy = approval.payload.approvedBy;
  }

  return {
    status: errors.length === 0 ? 'passed' : 'not-proven',
    errors,
    baseRevision,
    baseRegistrySha256,
    candidateRegistrySha256,
    changes: changes.map((change) => ({
      articleId: change.id,
      name: change.after?.name ?? change.before?.name ?? change.id,
      familyBefore: change.before?.family ?? null,
      familyAfter: change.after?.family ?? null,
      change: change.kind,
      direction: change.direction ?? null,
      approvedBy: change.approvedBy ?? null,
    })),
    population: {
      protectedBase: base.articles.length,
      candidate: candidate.articles.length,
      continuity: new Set([...baseById.keys(), ...candidateById.keys()]).size,
      additions: changes.filter((change) => change.kind === 'add').map((change) => change.id),
      removals: changes.filter((change) => change.kind === 'remove').map((change) => change.id),
      byFamily,
    },
  };
}

function resolveProtectedBaseText({ root, explicitFile, explicitRevision, repoPath, noun, envHint }) {
  if (explicitFile !== undefined) {
    if (typeof explicitFile !== 'string' || explicitFile.length === 0) {
      return { text: null, revision: null, source: 'explicit', errors: [`protected-base ${noun} path is empty`] };
    }
    try {
      const stat = fs.lstatSync(explicitFile);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file');
      return {
        text: fs.readFileSync(explicitFile, 'utf8'),
        revision: explicitRevision || 'explicit-protected-base',
        source: explicitFile,
        errors: [],
      };
    } catch (error) {
      return { text: null, revision: null, source: explicitFile, errors: [`protected-base ${noun} is unavailable: ${error instanceof Error ? error.message : String(error)}`] };
    }
  }

  for (const ref of ['refs/remotes/upstream/main', 'refs/remotes/origin/main']) {
    try {
      const revision = execFileSync('git', ['merge-base', 'HEAD', ref], { cwd: root, encoding: 'utf8' }).trim();
      if (!revision) continue;
      const text = execFileSync('git', ['show', `${revision}:${repoPath}`], { cwd: root, encoding: 'utf8' });
      return { text, revision, source: ref, errors: [] };
    } catch {
      // Try the next protected main ref. Failure of all candidates is loud below.
    }
  }
  return {
    text: null,
    revision: null,
    source: null,
    errors: [`protected-base ${noun} is unavailable (set ${envHint} or fetch upstream/main/origin/main)`],
  };
}

/** Fail-closed protected-base registry acquisition for the real pipeline. */
export function resolveProtectedBaseRegistry({ root, explicitFile, explicitRevision }) {
  const result = resolveProtectedBaseText({
    root,
    explicitFile,
    explicitRevision,
    repoPath: 'docs/STANDARDS-REGISTRY.md',
    noun: 'registry',
    envHint: 'STANDARDS_DIRECTION_BASE_FILE',
  });
  return { ...result, markdown: result.text };
}

/** The approver pin is always read from the same protected base as the registry. */
export function resolveProtectedApproverKey({ root, explicitFile, explicitRevision }) {
  const result = resolveProtectedBaseText({
    root,
    explicitFile,
    explicitRevision,
    repoPath: '.github/keyrings/telegram-principal-pub.pem',
    noun: 'approver trust root',
    envHint: 'STANDARDS_DIRECTION_BASE_APPROVER_KEY_FILE',
  });
  return { ...result, pem: result.text };
}

/** Candidate pin bytes are observed only to refuse drift; they never verify a signature. */
export function readCandidateApproverKey(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file');
    return { pem: fs.readFileSync(file, 'utf8'), errors: [] };
  } catch (error) {
    return {
      pem: null,
      errors: [`candidate approver trust root is unavailable: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

export function readDirectionApprovalLedger(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file');
    return { value: JSON.parse(fs.readFileSync(file, 'utf8')), errors: [] };
  } catch (error) {
    return {
      value: { schemaVersion: 1, approvals: [] },
      errors: [`direction approval ledger is unavailable or malformed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}
