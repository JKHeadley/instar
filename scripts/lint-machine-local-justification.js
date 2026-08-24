#!/usr/bin/env node
/**
 * lint-machine-local-justification.js — the DETERMINISTIC marker floor for
 * Standard A ("An Instar Agent Is Always a Multi-Machine Entity",
 * docs/STANDARDS-REGISTRY.md), built per docs/specs/three-standards-enforcement.md
 * §178-202 ("The marker's location + parse contract").
 *
 * ── What it is (Signal vs. Authority — the BODY, not the MIND) ─────────────
 * A no-LLM static parser that grades the PRESENCE + well-formedness of the
 * `machine-local-justification: <taxonomy-key>` marker a spec must carry for each
 * machine-local state surface it introduces. It is the cheap deterministic SIGNAL
 * that front-runs the /spec-converge integration reviewer; the reviewer holds the
 * semantic AUTHORITY (is the justification actually TRUE?) that a parser cannot
 * make (§194-202). Neither alone is the enforcement — together they are.
 *
 * ── The contract it checks (bidirectional, §170) ──────────────────────────
 *   A1 — UNDEFENDED machine-local: the spec's `## Multi-machine posture` section
 *        ASSERTS a machine-local posture (contains the token `machine-local`) but
 *        carries NO well-formed `machine-local-justification:` marker. §163: "a
 *        bare 'machine-local BY DESIGN' with no taxonomy-jailed justification is a
 *        MATERIAL FINDING."
 *   A2 — SPURIOUS / MALFORMED marker (the reverse direction, §170): a
 *        `machine-local-justification:` marker whose key is NOT in the closed
 *        taxonomy {physical-credential-locality, hardware-bound-resource,
 *        operator-ratified-exception}; OR an `operator-ratified-exception` marker
 *        that cites no machine-verifiable, existence-checkable ref (a commit SHA,
 *        a dotted registry key, or a URL — §155-162: a bare topic+date fails
 *        DETERMINISTICALLY); OR a well-formed marker that sits OUTSIDE the
 *        `## Multi-machine posture` section (the location contract, §178-181).
 *
 * ── Honest deterministic scope (§194-202, §242-245) ───────────────────────
 * PRESENCE + well-formedness only. It does NOT judge whether a declared posture
 * is the CORRECT one for the surface (that is the reviewer's semantic audit), and
 * it does NOT flag a spec that simply omits a posture section — §168's
 * "absence defaults to unified-required" is a semantic call the reviewer owns, not
 * a deterministic one. A `<placeholder>` marker value (template prose like
 * `machine-local-justification: <taxonomy-key>`) is IGNORED — it is documentation,
 * not a real marker.
 *
 * ── Rollout MODE — REPORT-FIRST (graduated rollout) ───────────────────────
 * Per the spec's honesty / hard-sequencing clause (§197-202, §563-573) and the
 * dark-first Maturation convention: the deterministic marker lint's grade is
 * "inert until the registry ship" — this floor lands as a SIGNAL first, not a new
 * brittle blocking gate. Default run REPORTS findings and exits 0 (never blocks;
 * existing specs predate the marker convention and are swept separately, §242-245).
 * `--strict` makes findings exit non-zero — the FAIL capability the spec describes
 * (§197-199), used by this lint's tests and available for a later CI graduation.
 *
 * Exit codes:
 *   0 — clean, OR findings in report mode (default)
 *   1 — findings in --strict mode, OR a usage error
 *
 * Usage:
 *   node scripts/lint-machine-local-justification.js                 # report, scans docs/specs
 *   node scripts/lint-machine-local-justification.js FILE...         # report specific files
 *   node scripts/lint-machine-local-justification.js --strict FILE   # FAIL on any finding
 *   node scripts/lint-machine-local-justification.js --json FILE     # machine-readable findings
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

// ── The closed taxonomy (§148-162). Widening it is a constitution-bound
//    operator decision, never an author's convenience (§205-219). ──────────
export const TAXONOMY_KEYS = new Set([
  'physical-credential-locality',
  'hardware-bound-resource',
  'operator-ratified-exception',
  // Ratified 2026-08-22 (operator directive, topic 52222 — Amendment 5). The
  // ONLY self-terminating key: it carries a first-declared date, a bounded
  // re-review horizon, and a total-lifetime cap, so it cannot become a resting
  // place. See the A2-migrating-* contracts below.
  'migrating-to-unified',
]);

// ── Finding the posture section (widened 2026-08-21) ──────────────────────
// This gate located its section by matching the heading text EXACTLY. Real spec
// headings carry ordinals and qualifiers, and every such section was INVISIBLE:
// the spec then read as "no posture section", A1/A3 never fired, and it passed
// CLEAN without ever being checked. Measured on this corpus, an exact match saw
// 91 of 149 posture-carrying specs and silently skipped the rest — including the
// replicated-store foundation, the mesh self-heal spec, the secure-pairing spec
// and the standards-registry spec itself. Nobody had to make a mistake; you just
// had to number your heading.
//
// The shapes actually in the corpus, all of which must be seen:
//   `## Multi-machine posture`                              (bare)
//   `## 8. Multi-machine posture` / `## 8.2 …`               (numeric ordinal)
//   `## §4. Multi-machine posture (Phase A)`                 (section-mark ordinal)
//   `#### D. Multi-machine posture — released-no-placement`  (letter ordinal)
//   `## 4. State and multi-machine posture`                  (phrase not leading)
//   `## Cross-Machine Coherence (multi-machine posture)`     (phrase parenthesised)
//
// So the matcher is CONTAINMENT, not a prefix. Over-matching a heading errs
// toward CHECKING a section that may not be the posture one; under-matching
// silently skips the check entirely. For a gate whose whole purpose is to be
// unskippable, and which is report-first (non-blocking without --strict), the
// containment direction is the correct asymmetry.
const POSTURE_HEADING_RE = /^#{1,6}[ \t]+.*multi-machine posture.*$/gim;

// Among containing headings, the CANONICAL one — the phrase leading the title
// after an optional ordinal — is preferred, so a spec carrying both a real
// posture section and an incidental prose heading picks the real one
// deterministically rather than by document order.
const POSTURE_CANONICAL_RE =
  /^#{1,6}[ \t]+(?:(?:§[ \t]*)?(?:[0-9]+(?:\.[0-9]+)*|[A-Z])\.?[ \t]+)?multi-machine posture\b/i;

// A standalone marker line: start-of-line (optional bullet / backtick), the
// label, a colon, then `key rest`. Anchored so a mid-sentence backticked prose
// mention (e.g. "declares it with a `machine-local-justification: <key>` marker")
// does NOT match — only a real declaration line does.
const MARKER_LINE_RE =
  /^[ \t]*(?:[-*+][ \t]+)?`?machine-local-justification`?[ \t]*:[ \t]*`?([^\s`]+)`?[ \t]*(.*?)`?[ \t]*$/gim;

// ── Prose QUOTATION of a marker, not a declaration (2026-08-21) ────────────
// The anchoring claim above holds only while the prose mention is mid-line. A
// correction-heavy spec quotes markers constantly ("an earlier draft declared it
// `machine-local-justification: hardware-bound-resource`. A JSONL audit file is
// not…"), and ordinary paragraph wrapping puts that quotation at line-start,
// where it reads as a live declaration sitting outside the posture section — a
// false A3. Found by running the widened gate on a real 196KB spec; no fixture
// had ever contained a spec that TALKS ABOUT markers.
//
// The discriminator is the closing backtick: a real declaration is the line's
// content (bare label, optional trailing ref — see the corpus fixtures), whereas
// a quotation closes its backtick span and then CONTINUES with sentence prose.
// A fully-backticked marker alone on its line is still a declaration, because
// nothing follows the span.
const MARKER_QUOTATION_RE = /`[^`]*machine-local-justification[^`]*`[ \t]*\S/i;

// A machine-verifiable, existence-checkable ref for operator-ratified-exception
// (§155-162): a commit SHA (7-40 hex), a URL, or a dotted registry key.
const REF_SHA_RE = /\b[0-9a-f]{7,40}\b/i;
const REF_URL_RE = /https?:\/\/\S+/i;
const REF_REGISTRY_KEY_RE = /\b[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+){1,}\b/;

/**
 * Locate the bounds of the `## Multi-machine posture` section in a spec's text.
 * Returns { start, end } character offsets, or null when the section is absent.
 * The section runs from its heading to the next heading of equal-or-higher level
 * (or EOF).
 */
export function findPostureSection(text) {
  POSTURE_HEADING_RE.lastIndex = 0;
  const matches = [];
  let hit;
  while ((hit = POSTURE_HEADING_RE.exec(text)) !== null) {
    matches.push({ text: hit[0], index: hit.index });
  }
  if (matches.length === 0) return null;
  const m = matches.find((c) => POSTURE_CANONICAL_RE.test(c.text)) ?? matches[0];
  if (!m) return null;
  const headingLevel = (m.text.match(/^#+/) || ['#'])[0].length;
  const start = m.index;
  const afterHeading = start + m.text.length;
  // Find the next heading at <= headingLevel after the section starts.
  const rest = text.slice(afterHeading);
  const nextHeadingRe = new RegExp(`^#{1,${headingLevel}}\\s+\\S`, 'im');
  const nm = nextHeadingRe.exec(rest);
  const end = nm ? afterHeading + nm.index : text.length;
  return { start, end };
}

/**
 * Parse every standalone `machine-local-justification:` marker line in the text.
 * `<placeholder>` values (template prose) are skipped. Returns
 * [{ key, rest, index }].
 */
export function parseMarkers(text) {
  const out = [];
  MARKER_LINE_RE.lastIndex = 0;
  let m;
  while ((m = MARKER_LINE_RE.exec(text)) !== null) {
    // A prose quotation of a marker is not a declaration of one.
    if (MARKER_QUOTATION_RE.test(m[0])) continue;
    const key = m[1];
    const rest = (m[2] || '').trim();
    // Skip template placeholders like `<taxonomy-key>` / `<key>` — documentation,
    // not a real declaration.
    if (/^<.*>$/.test(key)) continue;
    out.push({ key, rest, index: m.index });
  }
  return out;
}

/** True if `rest` carries a machine-verifiable, existence-checkable ref. */
export function hasResolvableRef(rest) {
  if (!rest) return false;
  return REF_SHA_RE.test(rest) || REF_URL_RE.test(rest) || REF_REGISTRY_KEY_RE.test(rest);
}

/**
 * Parse `name=value` / `name: value` sub-fields out of a marker's `rest`.
 *
 * Amendments 3 and 5 (ratified 2026-08-22) require a marker to carry NAMED
 * facts rather than free prose — that is what makes them deterministically
 * checkable rather than a reviewer's judgement. A value runs to the next known
 * field name or to end-of-line, and may be quoted.
 *
 * Returns a lowercase-keyed object; a repeated field keeps the FIRST value, so
 * appending a second `permanence=` cannot quietly override the first.
 */
export const MARKER_FIELDS = ['prohibited-by', 'impossible-because', 'permanence', 'exit', 'ratified', 'tracking', 'since', 'expires'];
export function parseMarkerFields(rest) {
  const out = {};
  if (!rest) return out;
  const names = MARKER_FIELDS.map((n) => n.replace(/[-]/g, '\\-')).join('|');
  const re = new RegExp(
    `\\b(${names})\\s*[=:]\\s*(?:"([^"]*)"|'([^']*)'|([^\\s].*?))(?=\\s+(?:${names})\\s*[=:]|\\s*$)`,
    'gi',
  );
  let m;
  while ((m = re.exec(rest)) !== null) {
    const key = m[1].toLowerCase();
    const val = (m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (!(key in out)) out[key] = val;
  }
  return out;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Amendment 5's maximum horizon. Without it the key is RENEWABLE, not
// self-terminating: an author sets a distant expiry, delivers nothing, and is
// never asked again. The first draft's own fixture used the year 2099 and
// passed, which is how the gap was found (external adversarial lens, 2026-08-22).
export const MIGRATION_MAX_HORIZON_DAYS = 180;

// Round 3. The horizon alone bounds ONE declaration; renewing it re-dates the
// expiry and buys unbounded time. `since` (first declaration) plus a TOTAL
// LIFETIME cap is what makes the key actually terminate. A rewritten `since` is
// falsification, not a loophole — the parser cannot see it, and the article says so.
export const MIGRATION_MAX_TOTAL_LIFETIME_DAYS = 360;

/** Shared: an ISO date field that must be present, well-formed, and within `maxDays` of today. */
function gradeHorizonDate(value, { rule, label, maxDays, today, missingMessage }) {
  const findings = [];
  if (!ISO_DATE_RE.test(value || '') || Number.isNaN(Date.parse(value))) {
    findings.push({ rule: `${rule}-missing`, message: missingMessage });
    return { findings, dueMs: null };
  }
  const dueMs = Date.parse(`${value}T23:59:59Z`);
  if (dueMs > today.getTime() + maxDays * 24 * 60 * 60 * 1000) {
    findings.push({
      rule: `${rule}-beyond-horizon`,
      message:
        `${label} ${value} is more than ${maxDays} days out. A distant date makes the ` +
        `posture renewable rather than self-terminating — it must come back in front of ` +
        `a reader on a bounded cadence.`,
    });
  } else if (dueMs < today.getTime()) {
    findings.push({ rule: `${rule}-expired`, message: `${label} ${value} has PASSED. The posture must be re-argued or resolved; it may never lapse silently into a permanent one.` });
  }
  return { findings, dueMs };
}

/**
 * Amendment 3 — `physical-credential-locality` must NAME the prohibiting
 * authority and declare the prohibition PERMANENT or TEMPORARY. Returns a
 * findings array (empty when well-formed).
 *
 * Why named fields rather than prose: the key as previously written let an
 * author assert a physical constraint where a storage habit existed, and no
 * parser could tell the two apart. "Bitwarden could hold this" is the test, and
 * a marker that cannot even name who forbids the move has not met it.
 */
export function gradePhysicalCredentialLocality(rest, today = new Date()) {
  const findings = [];
  const f = parseMarkerFields(rest);
  // The basis may be a PROHIBITION or an IMPOSSIBILITY. Demanding a
  // `prohibited-by` for a purely technical barrier was an inconsistent
  // evidentiary bar — a hardware-bound key has no authority to cite (external
  // adversarial lens, 2026-08-22).
  if (!f['prohibited-by'] && !f['impossible-because']) {
    findings.push({
      rule: 'A2-credential-locality-no-authority',
      message:
        `physical-credential-locality must NAME its basis — either ` +
        `\`prohibited-by="<vendor ToS | legal residency constraint>"\` or ` +
        `\`impossible-because="<what makes relocation technically impossible>"\` ` +
        `(Amendment 3, ratified 2026-08-22). This key covers only a credential whose ` +
        `relocation is PROHIBITED or technically impossible; a credential that merely ` +
        `HAPPENS to sit on one disk is a storage choice, and where a vault can hold it ` +
        `this key does not apply. Marker value: "${rest || '(empty)'}".`,
    });
  }
  const perm = (f.permanence || '').toLowerCase();
  // A TEMPORARY barrier with no tracked way out is a permanent barrier wearing a
  // temporary label — the defect `migrating-to-unified` carries a horizon against,
  // and it applied here identically (external adversarial lens, 2026-08-22).
  if (perm === 'temporary') {
    if (!hasResolvableRef(f.exit || '')) {
      findings.push({
        rule: 'A2-credential-locality-temporary-no-exit',
        message:
          `physical-credential-locality declared \`permanence=temporary\` must record its ` +
          `exit — \`exit=<commit SHA | URL | dotted registry key>\` naming the work or ` +
          `decision that ends the barrier (Amendment 3, ratified 2026-08-22). Marker value: ` +
          `"${rest || '(empty)'}".`,
      });
    }
    // An exit with no deadline is a permanent barrier with paperwork. Same horizon
    // the newer key carries — binding a new key more tightly than an old one for no
    // stated reason is an inconsistency, not a conservative default (round 3).
    // Round 4: a deadline WITHOUT a lifetime cap is renewable every 180 days
    // forever — the exact loophole round 3 closed one key over. Same contract here.
    const tsince = f.since || '';
    if (!ISO_DATE_RE.test(tsince) || Number.isNaN(Date.parse(tsince))) {
      findings.push({
        rule: 'A2-credential-locality-temporary-no-since',
        message:
          `physical-credential-locality declared \`permanence=temporary\` must carry ` +
          `\`since=YYYY-MM-DD\` — the date the barrier was FIRST declared, carried forward ` +
          `across renewals (Amendment 3, round 4). Without it the re-review date is ` +
          `renewable forever. Marker value: "${rest || '(empty)'}".`,
      });
    } else if (ISO_DATE_RE.test(f.expires || '') && !Number.isNaN(Date.parse(f.expires))) {
      const lifetimeDays = (Date.parse(f.expires) - Date.parse(tsince)) / (24 * 60 * 60 * 1000);
      if (lifetimeDays > MIGRATION_MAX_TOTAL_LIFETIME_DAYS) {
        findings.push({
          rule: 'A2-credential-locality-temporary-lifetime-exceeded',
          message:
            `physical-credential-locality has been declared TEMPORARY for a TOTAL of ` +
            `${Math.round(lifetimeDays)} days (since ${tsince} → expires ${f.expires}), over ` +
            `the ${MIGRATION_MAX_TOTAL_LIFETIME_DAYS}-day lifetime cap. Re-argue it in front ` +
            `of the operator, who may rule it PERMANENT — the honest outcome for a barrier ` +
            `that has held for a year.`,
        });
      }
    }
    for (const finding of gradeHorizonDate(f.expires, {
      rule: 'A2-credential-locality-temporary-review',
      label: 'physical-credential-locality TEMPORARY re-review date',
      maxDays: MIGRATION_MAX_HORIZON_DAYS,
      today,
      missingMessage:
        `physical-credential-locality declared \`permanence=temporary\` must carry a ` +
        `re-review date — \`expires=YYYY-MM-DD\`, at most ${MIGRATION_MAX_HORIZON_DAYS} ` +
        `days out (Amendment 3, round 3). Marker value: "${rest || '(empty)'}".`,
    }).findings) findings.push(finding);
  }
  if (perm !== 'permanent' && perm !== 'temporary') {
    findings.push({
      rule: 'A2-credential-locality-no-permanence',
      message:
        `physical-credential-locality must declare \`permanence=permanent\` or ` +
        `\`permanence=temporary\` (Amendment 3, ratified 2026-08-22). A temporary ` +
        `prohibition is a posture with an exit; a permanent one is a standing constraint, ` +
        `and conflating them hides which is which. Marker value: "${rest || '(empty)'}".`,
    });
  }
  return findings;
}

/**
 * Amendment 5 — `migrating-to-unified` is permitted ONLY with (a) the ratified
 * decision establishing unified as the destination, (b) a resolvable tracking
 * ref for the work that delivers it, and (c) an expiry date. On expiry the
 * surface declares `unified` or the exception is re-argued in front of the
 * operator; it may never lapse silently into a permanent posture — so an
 * EXPIRED marker is itself a finding, not a grace period.
 *
 * `today` is injectable so the expiry arm is testable without freezing a clock.
 */
export function gradeMigratingToUnified(rest, today = new Date()) {
  const findings = [];
  const f = parseMarkerFields(rest);
  if (!hasResolvableRef(f.ratified || '')) {
    findings.push({
      rule: 'A2-migrating-no-ratified-decision',
      message:
        `migrating-to-unified must cite the ratified decision establishing \`unified\` as the ` +
        `destination — \`ratified=<commit SHA | URL | dotted registry key>\` (Amendment 5, ` +
        `ratified 2026-08-22). Without it the key asserts a destination nobody approved, which ` +
        `is the false-claim class it exists to prevent. Marker value: "${rest || '(empty)'}".`,
    });
  }
  if (!hasResolvableRef(f.tracking || '')) {
    findings.push({
      rule: 'A2-migrating-no-tracking-ref',
      message:
        `migrating-to-unified must cite a resolvable tracking ref for the work that DELIVERS ` +
        `unified — \`tracking=<commit SHA | URL | dotted registry key>\` (Amendment 5). A ` +
        `migration with no tracked delivery is a permanent posture wearing a temporary label. ` +
        `Marker value: "${rest || '(empty)'}".`,
    });
  }
  // Round 3: the total lifetime, not just this declaration's horizon.
  const since = f.since || '';
  if (!ISO_DATE_RE.test(since) || Number.isNaN(Date.parse(since))) {
    findings.push({
      rule: 'A2-migrating-no-since',
      message:
        `migrating-to-unified must carry \`since=YYYY-MM-DD\` — the date the posture was ` +
        `FIRST declared for this surface, carried forward unchanged across renewals ` +
        `(Amendment 5, round 3). Without it the horizon bounds one declaration and a ` +
        `renewal buys unbounded time. Marker value: "${rest || '(empty)'}".`,
    });
  }
  const expires = f.expires || '';
  if (ISO_DATE_RE.test(since) && ISO_DATE_RE.test(expires) &&
      !Number.isNaN(Date.parse(since)) && !Number.isNaN(Date.parse(expires))) {
    const lifetimeDays = (Date.parse(expires) - Date.parse(since)) / (24 * 60 * 60 * 1000);
    if (lifetimeDays > MIGRATION_MAX_TOTAL_LIFETIME_DAYS) {
      findings.push({
        rule: 'A2-migrating-lifetime-exceeded',
        message:
          `migrating-to-unified has been in force for a TOTAL of ${Math.round(lifetimeDays)} ` +
          `days (since ${since} → expires ${expires}), over the ` +
          `${MIGRATION_MAX_TOTAL_LIFETIME_DAYS}-day lifetime cap. The surface must declare ` +
          `\`unified\` or the exception must be re-argued in front of the operator — a ` +
          `renewal may not carry it further.`,
      });
    }
  }
  if (!ISO_DATE_RE.test(expires) || Number.isNaN(Date.parse(expires))) {
    findings.push({
      rule: 'A2-migrating-no-expiry',
      message:
        `migrating-to-unified must carry \`expires=YYYY-MM-DD\` (Amendment 5). The expiry is ` +
        `what makes this key self-terminating and is the entire reason a fourth key was ` +
        `ratified into a deliberately narrow taxonomy. Marker value: "${rest || '(empty)'}".`,
    });
  } else {
    const due = Date.parse(`${expires}T23:59:59Z`);
    const horizonMs = MIGRATION_MAX_HORIZON_DAYS * 24 * 60 * 60 * 1000;
    if (due > today.getTime() + horizonMs) {
      findings.push({
        rule: 'A2-migrating-expiry-beyond-horizon',
        message:
          `migrating-to-unified expiry ${expires} is more than ` +
          `${MIGRATION_MAX_HORIZON_DAYS} days out (Amendment 5's maximum horizon). A ` +
          `distant expiry makes the key renewable rather than self-terminating — the ` +
          `posture must come back in front of a reader on a bounded cadence.`,
      });
    }
    if (due < today.getTime()) {
      findings.push({
        rule: 'A2-migrating-expired',
        message:
          `migrating-to-unified EXPIRED on ${expires}. The surface must now declare \`unified\` ` +
          `or the exception must be re-argued in front of the operator; it may never lapse ` +
          `silently into a permanent posture (Amendment 5).`,
      });
    }
  }
  return findings;
}

/**
 * Grade one spec's text against Standard A's marker contract. Pure — no I/O.
 * Returns { findings: [{ rule, message }] }.
 */
export function gradeMachineLocalMarkers(text, today = new Date()) {
  const findings = [];
  const markers = parseMarkers(text);
  const posture = findPostureSection(text);

  // ── A2 — spurious / malformed markers (both directions, §170) ──
  for (const marker of markers) {
    if (!TAXONOMY_KEYS.has(marker.key)) {
      findings.push({
        rule: 'A2-invalid-taxonomy-key',
        message:
          `machine-local-justification key "${marker.key}" is not in the closed taxonomy ` +
          `{${[...TAXONOMY_KEYS].join(', ')}}. A key outside the set is a MATERIAL FINDING ` +
          `(a fourth reason is an operator-ratified constitutional decision, §205-219).`,
      });
      continue;
    }
    if (marker.key === 'physical-credential-locality') {
      for (const f of gradePhysicalCredentialLocality(marker.rest, today)) findings.push(f);
    }
    if (marker.key === 'migrating-to-unified') {
      for (const f of gradeMigratingToUnified(marker.rest, today)) findings.push(f);
    }
    if (marker.key === 'operator-ratified-exception' && !hasResolvableRef(marker.rest)) {
      findings.push({
        rule: 'A2-unresolvable-ratification-ref',
        message:
          `operator-ratified-exception must cite a machine-verifiable, existence-checkable ref ` +
          `(a commit SHA, a URL, or a dotted registry key) — a bare topic+date fails ` +
          `deterministically (§155-162). Marker value: "${marker.rest || '(empty)'}".`,
      });
    }
    // Location contract (§178-181): a real marker belongs inside `## Multi-machine posture`.
    if (posture && (marker.index < posture.start || marker.index >= posture.end)) {
      findings.push({
        rule: 'A2-marker-outside-posture-section',
        message:
          `machine-local-justification marker ("${marker.key}") sits OUTSIDE the ` +
          `## Multi-machine posture section — the marker's fixed location is what makes ` +
          `PRESENCE machine-checkable (§178-181).`,
      });
    }
  }

  // ── A1 — undefended machine-local assertion (§163) ──
  // Scope the trigger to the posture section so a mere prose mention of
  // "machine-local" elsewhere in the spec is not a false positive.
  if (posture) {
    const sectionText = text.slice(posture.start, posture.end);
    const assertsMachineLocal = /machine-local/i.test(sectionText);
    // A marker DEFENDS a machine-local posture only when it is well-formed FOR ITS
    // KEY. Amendments 3 and 5 added per-key contracts, so a marker carrying the
    // right key and nothing else must not count as a defence — otherwise the new
    // requirements would be reportable while the posture they govern still passed.
    const hasValidMarker = markers.some((mk) => {
      if (!TAXONOMY_KEYS.has(mk.key)) return false;
      if (mk.index < posture.start || mk.index >= posture.end) return false;
      if (mk.key === 'operator-ratified-exception') return hasResolvableRef(mk.rest);
      if (mk.key === 'physical-credential-locality') {
        return gradePhysicalCredentialLocality(mk.rest, today).length === 0;
      }
      if (mk.key === 'migrating-to-unified') {
        return gradeMigratingToUnified(mk.rest, today).length === 0;
      }
      return true;
    });
    if (assertsMachineLocal && !hasValidMarker) {
      findings.push({
        rule: 'A1-undefended-machine-local',
        message:
          `the ## Multi-machine posture section asserts a machine-local posture but carries no ` +
          `well-formed machine-local-justification: <taxonomy-key> marker. A bare ` +
          `"machine-local BY DESIGN" with no taxonomy-jailed justification is a MATERIAL FINDING ` +
          `(§163). Default posture is unified (§148).`,
      });
    }
  }

  return { findings };
}

// ── CLI ────────────────────────────────────────────────────────────────────

function listSpecFiles() {
  const dir = path.join(ROOT, 'docs', 'specs');
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const strict = argv.includes('--strict');
  const json = argv.includes('--json');
  const files = argv.filter((a) => !a.startsWith('--'));
  const targets = files.length ? files : listSpecFiles();

  // ── The DENOMINATOR, reported beside the verdict (2026-08-23) ──────────
  //
  // WHY. On 2026-08-21 this gate was found to have been matching its section
  // heading EXACTLY while spec authors had begun numbering theirs. It saw 91 of
  // 149 posture-carrying specs and silently skipped 58 — printing "clean" about
  // a corpus it had never read. Nobody made a mistake; the population drifted
  // under the instrument, and there is no diff showing the moment it broke.
  //
  // The matcher was widened, which fixes THAT drift. This fixes the READING,
  // which is the part that generalises: "clean" is a sentence nobody questions,
  // and "clean — 0 findings across 149 spec(s), 91 carrying a posture section"
  // is one somebody does. A shrinking denominator beside a reassuring word is
  // the cheapest thing that would have surfaced the original bug without anyone
  // auditing the matcher, and it costs a line.
  //
  // `unreadable` is counted rather than swallowed for the same reason: a file
  // that could not be read is not a file with no findings.
  const allFindings = [];
  let scanned = 0;
  let withPosture = 0;
  let unreadable = 0;
  for (const file of targets) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      unreadable += 1;
      continue;
    }
    scanned += 1;
    if (findPostureSection(text)) withPosture += 1;
    const { findings } = gradeMachineLocalMarkers(text);
    for (const f of findings) allFindings.push({ file: path.relative(ROOT, path.resolve(file)), ...f });
  }
  const population = { scanned, withPosture, unreadable, findings: allFindings.length };
  const denominator =
    `${scanned} spec(s) scanned, ${withPosture} carrying a posture section` +
    (unreadable > 0 ? `, ${unreadable} UNREADABLE` : '');

  if (json) {
    process.stdout.write(JSON.stringify({ findings: allFindings, population, strict }, null, 2) + '\n');
  } else if (allFindings.length === 0) {
    console.log(`lint-machine-local-justification: clean — no undefended or malformed markers (${denominator}).`);
  } else {
    const header = strict
      ? 'lint-machine-local-justification: FINDINGS (strict — blocking):'
      : 'lint-machine-local-justification: findings (report-first — non-blocking signal):';
    console.error(header);
    for (const f of allFindings) {
      console.error(`  • [${f.rule}] ${f.file}`);
      console.error(`      ${f.message}`);
    }
    console.error(
      `\n  ${allFindings.length} finding(s) — ${denominator}. Standard A: docs/STANDARDS-REGISTRY.md ` +
        `("An Instar Agent Is Always a Multi-Machine Entity").`,
    );
  }

  if (strict && allFindings.length > 0) process.exit(1);
  process.exit(0);
}

// Only run the CLI when invoked directly (not when imported by a test).
const invokedDirectly =
  process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);
if (invokedDirectly) main();
