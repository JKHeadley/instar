/** Tree-only changelog/history observations; no owner, source or merge authority. */
import { Lexer, type Tokens } from 'marked';
import { readFeedbackRuleIds, feedbackInlineText, inspectFeedbackRuleLinks, type FeedbackEntryDocument, type FeedbackLinkError } from './feedbackRuleLinks.js';
import { parseDesignStandard } from './standardParser.js';
interface Snapshot { standard: string; entries: readonly FeedbackEntryDocument[] }
export interface HistoryError extends FeedbackLinkError { side?: 'base' | 'head' }
export function inspectFeedbackHistory(input: { base: Snapshot; head: Snapshot }) {
  const errors: HistoryError[] = [];
  const base = inspectFeedbackRuleLinks(input.base), head = inspectFeedbackRuleLinks(input.head);
  for (const side of ['base', 'head'] as const) for (const error of (side === 'base' ? base : head).errors) errors.push({ side, ...error });
  const headById = new Map(head.entries.map(entry => [entry.id, entry]));
  for (const before of base.entries) {
    const after = headById.get(before.id);
    if (!after) { errors.push({ code: 'entry-history-removed', entryId: before.id }); continue; }
    for (const ruleId of before.ruleIds) if (!after.ruleIds.includes(ruleId)) errors.push({ code: 'entry-rule-history-removed', entryId: before.id, ruleId });
  }
  const known = new Set(parseDesignStandard(input.head.standard).rules.map(rule => rule.id));
  const changelog: Array<{ entryId: string; ruleIds: string[] }> = [];
  const entryFiles = new Map(head.entries.map(entry => [entry.path.split('/').at(-1)!, entry.id]));
  const mentions = (text: string, entryId: string): string[] => {
    const ids = new Set<string>();
    const expectedRanges = (text.match(/\bDS-[A-Z][A-Z0-9]*-\d+\s+to\s+/g) ?? []).length;
    let ranges = 0;
    if (readFeedbackRuleIds(text).invalid) errors.push({ code: 'changelog-rule-id-invalid', entryId });
    const rest = text.replace(/\bDS-([A-Z][A-Z0-9]*)-(\d+)\s+to\s+(?:DS-([A-Z][A-Z0-9]*)-)?(\d+)\b(?!\.\d|[A-Za-z0-9_-])/g,
      (_range, prefix: string, from: string, toPrefix: string | undefined, to: string) => {
        ranges++;
        const first = Number(from), last = Number(to), size = last - first + 1;
        const width = Math.max(from.startsWith('0') ? from.length : 0, to.startsWith('0') ? to.length : 0);
        // Bound expansion by the actual rule domain, not by a caller's range size.
        if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 0 || last < first || size > known.size || (toPrefix && toPrefix !== prefix)
          || String(first).padStart(width, '0') !== from || String(last).padStart(width, '0') !== to
          || !known.has(`DS-${prefix}-${from}`) || !known.has(`DS-${prefix}-${to}`)) {
          errors.push({ code: 'changelog-range-invalid', entryId }); return ' ';
        }
        for (let number = first; number <= last; number++) {
          const id = `DS-${prefix}-${String(number).padStart(width, '0')}`;
          if (!known.has(id)) { errors.push({ code: 'changelog-range-invalid', entryId, ruleId: id }); return ' '; }
          ids.add(id);
        }
        return ' ';
      });
    if (ranges !== expectedRanges) errors.push({ code: 'changelog-range-invalid', entryId });
    for (const id of readFeedbackRuleIds(rest).ids) ids.add(id);
    return [...ids].sort();
  };
  let inChangelog = false, sections = 0;
  for (const token of Lexer.lex(input.head.standard, { gfm: true, breaks: false, pedantic: false })) {
    if (token.type === 'heading') {
      const heading = token as Tokens.Heading;
      if (heading.depth <= 2) {
        inChangelog = heading.depth === 2 && feedbackInlineText(heading.tokens).trim() === 'Changelog';
        if (inChangelog && ++sections > 1) errors.push({ code: 'changelog-section-duplicate' });
      }
    }
    if (!inChangelog || token.type !== 'table') continue;
    for (const cells of (token as Tokens.Table).rows) {
      if (cells.length !== 3) { errors.push({ code: 'changelog-row-invalid' }); continue; }
      const sourceIds: string[] = [];
      for (const raw of feedbackInlineText(cells[2].tokens).match(/\bDF-\d+[A-Za-z0-9_.-]*(?![@A-Za-z0-9_.-])/g) ?? []) {
        const token = raw.replace(/\.+$/, '');
        const id = /^DF-\d{4,}$/.test(token) ? token : entryFiles.get(token);
        if (!id) errors.push({ code: 'changelog-source-id-invalid' });
        else if (!sourceIds.includes(id)) sourceIds.push(id);
      }
      if (!sourceIds.length) continue; // e.g. the standard's first-version owner-request row
      if (sourceIds.length !== 1) { errors.push({ code: 'changelog-source-ambiguous' }); continue; }
      const entryId = sourceIds[0];
      changelog.push({ entryId, ruleIds: mentions(feedbackInlineText(cells[1].tokens), entryId) });
    }
  }
  const rowsByEntry = new Map<string, typeof changelog>();
  for (const row of changelog) {
    const rows = rowsByEntry.get(row.entryId) ?? []; rows.push(row); rowsByEntry.set(row.entryId, rows);
    if (!headById.has(row.entryId)) errors.push({ code: 'changelog-entry-missing', entryId: row.entryId });
  }
  for (const entry of head.entries) {
    const rows = rowsByEntry.get(entry.id) ?? [];
    if (!entry.ruleIds.length && !rows.length) continue;
    if (!rows.length) { errors.push({ code: 'changelog-entry-missing', entryId: entry.id }); continue; }
    if (rows.length !== 1) { errors.push({ code: 'changelog-entry-duplicate', entryId: entry.id }); continue; }
    if (JSON.stringify(rows[0].ruleIds) !== JSON.stringify([...entry.ruleIds].sort())) errors.push({ code: 'changelog-rules-mismatch', entryId: entry.id });
  }
  return { schemaVersion: 1 as const, scope: 'feedback-changelog-and-history' as const, mergeAuthority: false as const,
    sourceVerification: false as const, publicationPrivacyReview: false as const,
    notEvaluated: ['owner-loosening-presence', 'semantic-wording-reductions', 'gate-miss-fix-links', 'server-feedback-card-binding', 'execution-and-release-evidence'], changelog, errors };
}
