/**
 * OrgIntentManager — Parses and validates ORG-INTENT.md for organizational intent.
 *
 * The organizational intent layer sits above individual agent intent (AGENT.md).
 * Three-rule contract:
 *   1. Org constraints are mandatory — agents cannot override
 *   2. Org goals are defaults — agents can specialize
 *   3. Agent identity fills the rest — personality, style, domain expertise
 *
 * Storage: ORG-INTENT.md in the project's .instar/ directory.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseIdentityLayer, type OrgIdentity } from './OrgIntentIdentityLayer.js';

// ── Types ────────────────────────────────────────────────────────────

export interface OrgConstraint {
  text: string;
  source: 'org-intent';
}

export interface OrgGoal {
  text: string;
  source: 'org-intent';
  specializable: boolean; // always true for goals
}

export interface ParsedOrgIntent {
  name: string;
  constraints: OrgConstraint[];
  goals: OrgGoal[];
  values: string[];
  tradeoffHierarchy: string[];
  /** MTP Protocol layer 3 (EXO 3.0): why high-judgment humans stay + what we're not for. */
  identity?: OrgIdentity;
  raw: string;
}

export interface IntentConflict {
  orgConstraint: string;
  agentStatement: string;
  severity: 'error' | 'warning';
  description: string;
}

export interface IntentValidationResult {
  valid: boolean;
  conflicts: IntentConflict[];
  warnings: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Extract list items from a markdown section.
 * Recognizes lines starting with `- ` or `* `.
 * Skips HTML comments.
 */
function extractListItems(sectionContent: string): string[] {
  const items: string[] = [];
  const withoutComments = sectionContent.replace(/<!--[\s\S]*?-->/g, '');
  for (const line of withoutComments.split('\n')) {
    const trimmed = line.trim();
    const match = trimmed.match(/^[-*]\s+(.+)/);
    if (match) {
      items.push(match[1].trim());
    }
  }
  return items;
}

/**
 * Extract text between a specific ## heading and the next ## heading.
 * Returns the raw text of the section (excluding the heading line itself).
 */
function extractSection(content: string, sectionName: string): string | null {
  const lines = content.split('\n');
  let inSection = false;
  const sectionLines: string[] = [];
  const sectionRe = new RegExp(`^##\\s+${escapeRegex(sectionName)}\\b`, 'i');

  for (const line of lines) {
    if (sectionRe.test(line)) {
      inSection = true;
      continue;
    }
    // Another ## heading (but not ###) ends the section
    if (inSection && /^##\s+/.test(line) && !/^###/.test(line)) {
      break;
    }
    if (inSection) {
      sectionLines.push(line);
    }
  }

  if (sectionLines.length === 0) return null;
  return sectionLines.join('\n');
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check if content is template-only (all HTML comments, no real text).
 */
function isTemplateOnly(content: string): boolean {
  const withoutComments = content.replace(/<!--[\s\S]*?-->/g, '');
  const withoutHeadings = withoutComments.replace(/^#+.*$/gm, '');
  return !withoutHeadings.trim();
}

// ── Keyword contradiction detection ──────────────────────────────────

/** Normalize text for keyword comparison. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Extract the core action/subject from a constraint or statement.
 * For "Never share internal data" -> "share internal data"
 * For "Always validate inputs" -> "validate inputs"
 */
function extractCore(text: string): { negated: boolean; positiveCore: string } {
  const norm = normalize(text);

  // Check for negation patterns
  const negationPatterns = [
    /^never\s+(.+)/,
    /^do not\s+(.+)/,
    /^don t\s+(.+)/,
    /^must not\s+(.+)/,
    /^should not\s+(.+)/,
    /^cannot\s+(.+)/,
    /^must never\s+(.+)/,
    /^avoid\s+(.+)/,
    /^prohibit\s+(.+)/,
    /^no\s+(.+)/,
  ];

  for (const pattern of negationPatterns) {
    const match = norm.match(pattern);
    if (match) {
      return { negated: true, positiveCore: match[1].trim() };
    }
  }

  // Check for positive/mandatory patterns
  const positivePatterns = [
    /^always\s+(.+)/,
    /^must\s+(.+)/,
    /^should\s+(.+)/,
    /^require\s+(.+)/,
  ];

  for (const pattern of positivePatterns) {
    const match = norm.match(pattern);
    if (match) {
      return { negated: false, positiveCore: match[1].trim() };
    }
  }

  return { negated: false, positiveCore: norm };
}

/**
 * Check if two core phrases overlap significantly.
 * Uses word overlap heuristic.
 */
function coresOverlap(core1: string, core2: string): boolean {
  const words1 = new Set(core1.split(' ').filter(w => w.length > 2));
  const words2 = new Set(core2.split(' ').filter(w => w.length > 2));

  if (words1.size === 0 || words2.size === 0) return false;

  let overlap = 0;
  for (const w of words1) {
    if (words2.has(w)) overlap++;
  }

  // Require at least 2 overlapping words or >50% of the smaller set
  const minSize = Math.min(words1.size, words2.size);
  return overlap >= 2 || (overlap > 0 && overlap / minSize >= 0.5);
}

// ── Session-Start Formatter (Phase 2) ───────────────────────────────

/**
 * Render a `ParsedOrgIntent` into a session-start text block. Constraints
 * lead (most load-bearing), then goals, values, and tradeoff hierarchy.
 * Empty buckets are omitted. Used by the session-start hook and exposed via
 * `GET /intent/org/session-context`.
 *
 * Deterministic, single-newline-joined text — no LLM involvement — so it is
 * safe to inject directly into agent context at session boot.
 */
export function formatOrgIntentForSessionStart(intent: ParsedOrgIntent): string {
  const lines: string[] = [];
  lines.push('=== ORGANIZATIONAL INTENT ===');
  lines.push(`Organization: ${intent.name}`);
  lines.push('');
  lines.push('This is your operating contract. Constraints are mandatory; goals are organizational defaults; values shape representation; the tradeoff hierarchy resolves ties.');
  if (intent.constraints.length > 0) {
    lines.push('');
    lines.push('CONSTRAINTS (mandatory — outbound messages that violate these are blocked at the Coherence Gate):');
    for (const c of intent.constraints) lines.push(`  - ${c.text}`);
  }
  if (intent.goals.length > 0) {
    lines.push('');
    lines.push('GOALS (organizational defaults — specialize but never contradict):');
    for (const g of intent.goals) lines.push(`  - ${g.text}`);
  }
  if (intent.values.length > 0) {
    lines.push('');
    lines.push('VALUES (representation — keep these visible in how you communicate):');
    for (const v of intent.values) lines.push(`  - ${v}`);
  }
  if (intent.tradeoffHierarchy.length > 0) {
    lines.push('');
    lines.push('TRADEOFF HIERARCHY (when two values pull in opposite directions, the earlier entry wins):');
    intent.tradeoffHierarchy.forEach((t, i) => lines.push(`  ${i + 1}. ${t}`));
  }
  lines.push('');
  lines.push('=== END ORGANIZATIONAL INTENT ===');
  return lines.join('\n');
}

// ── Main Class ───────────────────────────────────────────────────────

export class OrgIntentManager {
  private orgIntentPath: string;

  constructor(private stateDir: string) {
    this.orgIntentPath = path.join(stateDir, 'ORG-INTENT.md');
  }

  /** Check if ORG-INTENT.md exists */
  exists(): boolean {
    return fs.existsSync(this.orgIntentPath);
  }

  /** Read and return raw content */
  readRaw(): string | null {
    if (!this.exists()) return null;
    try {
      return fs.readFileSync(this.orgIntentPath, 'utf-8');
    } catch {
      // @silent-fallback-ok — ORG-INTENT read returns null
      return null;
    }
  }

  /** Parse ORG-INTENT.md into structured data */
  parse(): ParsedOrgIntent | null {
    const raw = this.readRaw();
    if (!raw) return null;

    // Check if the file is template-only (all comments, no real content)
    if (isTemplateOnly(raw)) return null;

    // Extract organization name from heading
    const nameMatch = raw.match(/^#\s+Organizational Intent:\s*(.+)$/m);
    const name = nameMatch ? nameMatch[1].trim() : 'Unknown';

    // Extract sections
    const constraintsSection = extractSection(raw, 'Constraints \\(Mandatory.*\\)') ?? extractSection(raw, 'Constraints');
    const goalsSection = extractSection(raw, 'Goals \\(Defaults.*\\)') ?? extractSection(raw, 'Goals');
    const valuesSection = extractSection(raw, 'Values');
    const tradeoffSection = extractSection(raw, 'Tradeoff Hierarchy');

    const constraints: OrgConstraint[] = constraintsSection
      ? extractListItems(constraintsSection).map(text => ({ text, source: 'org-intent' as const }))
      : [];

    const goals: OrgGoal[] = goalsSection
      ? extractListItems(goalsSection).map(text => ({ text, source: 'org-intent' as const, specializable: true }))
      : [];

    const values = valuesSection ? extractListItems(valuesSection) : [];
    let tradeoffHierarchy = tradeoffSection ? extractListItems(tradeoffSection) : [];
    // The Tradeoff Hierarchy is documented (and scaffolded by `instar intent org-init`)
    // as a single chained line — "Safety > Operator trust > Correctness > ..." — not a
    // bulleted list, so extractListItems returns []. Accept the chained form too so the
    // resolver actually sees the order. (exo3-harness mtp-tradeoff: was "no hierarchy".)
    if (tradeoffHierarchy.length === 0 && tradeoffSection) {
      const chain = tradeoffSection
        .replace(/<!--[\s\S]*?-->/g, '')
        .split('\n').map(l => l.trim()).filter(Boolean)
        .find(l => /[>›»]/.test(l));
      if (chain) {
        tradeoffHierarchy = chain.split(/\s*[>›»]\s*/).map(s => s.trim()).filter(Boolean);
      }
    }
    const identity = parseIdentityLayer(raw) ?? undefined;

    // If all sections are empty after parsing, treat as template-only
    if (constraints.length === 0 && goals.length === 0 && values.length === 0 && tradeoffHierarchy.length === 0 && !identity) {
      return null;
    }

    return { name, constraints, goals, values, tradeoffHierarchy, identity, raw };
  }

  /** Validate agent intent against org constraints (structural/heuristic) */
  validateAgentIntent(agentIntentContent: string): IntentValidationResult {
    const orgIntent = this.parse();
    const conflicts: IntentConflict[] = [];
    const warnings: string[] = [];

    if (!orgIntent) {
      return { valid: true, conflicts: [], warnings: ['No ORG-INTENT.md found or it contains no real content.'] };
    }

    if (!agentIntentContent.trim()) {
      return { valid: true, conflicts: [], warnings: ['Agent intent content is empty.'] };
    }

    // Extract all list items and sentences from agent intent
    const agentStatements = this.extractStatements(agentIntentContent);

    for (const constraint of orgIntent.constraints) {
      const orgCore = extractCore(constraint.text);

      for (const statement of agentStatements) {
        const agentCore = extractCore(statement);

        // Check for contradiction: one is negated and the other is positive,
        // and they share the same core subject
        if (orgCore.negated !== agentCore.negated && coresOverlap(orgCore.positiveCore, agentCore.positiveCore)) {
          conflicts.push({
            orgConstraint: constraint.text,
            agentStatement: statement,
            severity: 'error',
            description: `Agent statement "${statement}" contradicts org constraint "${constraint.text}"`,
          });
        }
      }
    }

    return {
      valid: conflicts.length === 0,
      conflicts,
      warnings,
    };
  }

  /**
   * Extract actionable statements from agent intent content.
   * Finds list items and sentences containing "never", "always", etc.
   */
  private extractStatements(content: string): string[] {
    const statements: string[] = [];
    const withoutComments = content.replace(/<!--[\s\S]*?-->/g, '');

    for (const line of withoutComments.split('\n')) {
      const trimmed = line.trim();

      // List items
      const listMatch = trimmed.match(/^[-*]\s+(.+)/);
      if (listMatch) {
        statements.push(listMatch[1].trim());
        continue;
      }

      // Sentences containing directive keywords (outside of headings)
      if (/^#/.test(trimmed)) continue;
      if (!trimmed) continue;

      const norm = normalize(trimmed);
      if (/\b(never|always|must|should not|do not|cannot|avoid|require)\b/.test(norm)) {
        statements.push(trimmed);
      }
    }

    return statements;
  }
}
