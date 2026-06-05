/**
 * OrgIntentIdentityLayer — the third layer of the "MTP Protocol" (EXO 3.0).
 *
 * Salim Ismail's EXO 3.0 frames a Massive Transformative Purpose as a
 * machine-readable protocol with three layers:
 *   1. Constraint layer — what agents are forbidden from doing  (ORG-INTENT `constraints`)
 *   2. Decision layer    — how agents resolve trade-offs         (ORG-INTENT `tradeoffHierarchy`)
 *   3. Identity layer     — why high-judgment humans stay, and what the org is NOT for
 *
 * Instar already has layers 1 and 2. This module parses layer 3 from an
 * optional `## Identity` section of ORG-INTENT.md, so the purpose can bind
 * humans (not just gate agents). It is intentionally tolerant: a missing or
 * template-only section yields `null`, never an error.
 *
 * Parsing contract (all optional, order-independent):
 *   ## Identity
 *   ### Why People Stay      -> bindingStatements[]   (also accepts "What Binds Us")
 *   - <statement>
 *   ### What We're Not For    -> disqualifiers[]        (also accepts "Not For" / "Identity Disqualifiers")
 *   - <statement>
 * Bare list items directly under `## Identity` (no subheading) are treated as
 * bindingStatements, so a minimal section still parses.
 */

// ── Types ────────────────────────────────────────────────────────────

export interface OrgIdentity {
  /** Why a high-judgment human stays — the binding statements. */
  bindingStatements: string[];
  /** What the org is explicitly NOT for — identity disqualifiers. */
  disqualifiers: string[];
  /** Raw text of the `## Identity` section (excluding the heading line). */
  raw: string;
}

// ── Helpers (kept local so this module is self-contained) ────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract the text of a `## <name>` section (up to the next `##`, excluding `###`).
 * Returns null when the section is absent.
 */
function extractH2Section(content: string, sectionName: string): string | null {
  const lines = content.split('\n');
  let inSection = false;
  const out: string[] = [];
  const re = new RegExp(`^##\\s+${escapeRegex(sectionName)}\\b`, 'i');
  for (const line of lines) {
    if (re.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(line) && !/^###/.test(line)) break;
    if (inSection) out.push(line);
  }
  return inSection ? out.join('\n') : null;
}

/**
 * Within a section body, extract the list items under a `### <name>` subheading
 * (up to the next `###` or `##`). Accepts any of the provided alias names.
 */
function extractH3List(sectionBody: string, aliases: string[]): string[] {
  const lines = sectionBody.split('\n');
  const re = new RegExp(`^###\\s+(?:${aliases.map(escapeRegex).join('|')})\\b`, 'i');
  let inSub = false;
  const items: string[] = [];
  for (const line of lines) {
    if (re.test(line)) {
      inSub = true;
      continue;
    }
    if (inSub && /^#{2,3}\s+/.test(line)) break;
    if (inSub) {
      const m = line.trim().match(/^[-*]\s+(.+)/);
      if (m) items.push(m[1].trim());
    }
  }
  return items;
}

/** All `- ` / `* ` list items in a body, ignoring ones under any `###` subheading. */
function extractTopLevelList(sectionBody: string): string[] {
  const withoutComments = sectionBody.replace(/<!--[\s\S]*?-->/g, '');
  const items: string[] = [];
  let underSub = false;
  for (const line of withoutComments.split('\n')) {
    if (/^###\s+/.test(line)) {
      underSub = true;
      continue;
    }
    if (/^##\s+/.test(line)) underSub = false;
    if (underSub) continue;
    const m = line.trim().match(/^[-*]\s+(.+)/);
    if (m) items.push(m[1].trim());
  }
  return items;
}

function isTemplateOnly(content: string): boolean {
  const withoutComments = content.replace(/<!--[\s\S]*?-->/g, '');
  const withoutHeadings = withoutComments.replace(/^#+.*$/gm, '');
  return !withoutHeadings.trim();
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Parse the identity layer from full ORG-INTENT.md content.
 * Returns null when there is no `## Identity` section or it is template-only/empty.
 */
export function parseIdentityLayer(orgIntentContent: string): OrgIdentity | null {
  const section = extractH2Section(orgIntentContent, 'Identity');
  if (section === null || isTemplateOnly(section)) return null;

  const binding = extractH3List(section, ['Why People Stay', 'What Binds Us', 'Binding']);
  const disqualifiers = extractH3List(section, [
    "What We're Not For",
    'What We Are Not For',
    'Not For',
    'Identity Disqualifiers',
    'Disqualifiers',
  ]);

  // Fall back to bare list items as binding statements when no subheadings used.
  const bindingStatements = binding.length > 0 ? binding : extractTopLevelList(section);

  if (bindingStatements.length === 0 && disqualifiers.length === 0) return null;

  return {
    bindingStatements,
    disqualifiers,
    raw: section.trim(),
  };
}
