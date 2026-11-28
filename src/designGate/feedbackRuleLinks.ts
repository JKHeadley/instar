/** Tree-only entry shape/link observations. Metadata is not source, publication or merge authority. */
import { parseDesignStandard } from './standardParser.js';
import { Lexer, type Token, type Tokens } from 'marked';
export interface FeedbackEntryDocument { path: string; markdown: string }
export interface FeedbackLinkError { code: string; path?: string; entryId?: string; ruleId?: string; problem?: number }
/** Literal symbolic IDs only: never turn a typo or numeric suffix into another issued ID. */
export function readFeedbackRuleIds(text: string): { ids: string[]; invalid: boolean } {
  const ids = new Set<string>(); let invalid = false;
  for (const raw of text.match(/\bDS-[A-Z][A-Z0-9]*-[A-Za-z0-9_.-]+(?![@A-Za-z0-9_.-])/g) ?? []) {
    const id = raw.replace(/\.+$/, ''); // ordinary sentence punctuation is not part of the symbol
    if (/^DS-[A-Z][A-Z0-9]*-\d+$/.test(id)) ids.add(id);
    else invalid = true;
  }
  return { ids: [...ids], invalid };
}

function section(text: string, title: RegExp): string | null {
  const lines = text.split('\n'), start = lines.findIndex(line => title.test(line));
  if (start < 0) return null;
  const rest = lines.slice(start + 1), end = rest.findIndex(line => /^##\s/.test(line));
  return rest.slice(0, end < 0 ? rest.length : end).join('\n');
}
export function feedbackInlineText(tokens: readonly Token[]): string {
  return tokens.map(token => {
    if (token.type === 'html' || token.type === 'code' || token.type === 'image') return '';
    const nested = (token as { tokens?: Token[] }).tokens;
    if (nested) return feedbackInlineText(nested);
    if (token.type === 'br') return ' ';
    return (token as { text?: string }).text ?? '';
  }).join('');
}
function structureText(tokens: readonly Token[]): string {
  return tokens.map(token => {
    switch (token.type) {
      case 'code': case 'html': case 'def': return '';
      case 'heading': {
        const heading = token as Tokens.Heading;
        return '#'.repeat(heading.depth) + ' ' + feedbackInlineText(heading.tokens) + '\n';
      }
      case 'table': {
        const table = token as Tokens.Table;
        return [table.header, ...table.rows].map(row => '| ' + row.map(cell => feedbackInlineText(cell.tokens).replace(/\|/g, '\\|')).join(' | ') + ' |\n').join('');
      }
      case 'list': {
        const list = token as Tokens.List;
        return list.items.map((item, index) => {
          // Preserve written numbers, including duplicates; do not renumber a bad diagnosis.
          const number = /^\s*(\d+)[.)]\s/.exec(item.raw)?.[1] ?? String(Number(list.start) + index);
          const marker = list.ordered ? number + '. ' : '- ';
          const body = structureText(item.tokens).trimEnd();
          return marker + body.split('\n').join('\n    ') + '\n';
        }).join('');
      }
      case 'blockquote': return structureText((token as Tokens.Blockquote).tokens).split('\n').map(line => '> ' + line).join('\n') + '\n';
      case 'paragraph': return feedbackInlineText((token as Tokens.Paragraph).tokens) + '\n';
      case 'text': return feedbackInlineText([token]) + '\n';
      case 'space': case 'hr': return '\n';
      default: return '';
    }
  }).join('');
}
function outsideCode(markdown: string): string {
  // Use the shipped lexer and token children, never a list's raw text: examples
  // nested inside a diagnosis must not supply actual rule citations.
  return structureText(Lexer.lex(markdown, { gfm: true, breaks: false, pedantic: false }));
}

export function inspectFeedbackRuleLinks(input: { standard: string; entries: readonly FeedbackEntryDocument[] }) {
  const parsed = parseDesignStandard(input.standard);
  const errors: FeedbackLinkError[] = parsed.errors.map(error => ({ code: `standard:${error.code}`, ruleId: error.ruleId }));
  if (!parsed.rules.length) errors.push({ code: 'standard-empty' });
  const rules = new Map(parsed.rules.map(rule => [rule.id, rule]));
  const entries: Array<{ id: string; path: string; cardId: string | null; sourcePresent: boolean; problemCount: number; ruleIds: string[] }> = [];
  const numbers = new Set<number>();
  for (const document of input.entries) {
    const path = document.path;
    const match = /^docs\/design-feedback\/(DF-\d{4,})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.exec(path);
    const number = match ? Number(match[1].slice(3)) : NaN;
    if (!match || !Number.isSafeInteger(number) || number < 1 || `DF-${String(number).padStart(4, '0')}` !== match[1]) {
      errors.push({ code: 'entry-path-invalid', path }); continue;
    }
    const id = match[1], at = { path, entryId: id };
    if (numbers.has(number)) errors.push({ code: 'entry-number-duplicate', ...at });
    numbers.add(number);
    const visible = outsideCode(document.markdown.replace(/\r\n/g, '\n'));
    const header = visible.split(/^##\s/m)[0];
    const fields = new Map<string, string>();
    for (const line of header.split('\n')) {
      const row = /^\|\s*(Entry|Card|Source message)\s*\|\s*(.*?)\s*\|$/.exec(line);
      if (!row) continue;
      if (fields.has(row[1])) errors.push({ code: 'entry-metadata-duplicate', ...at });
      fields.set(row[1], row[2]);
    }
    if (fields.get('Entry') !== id) errors.push({ code: 'entry-id-mismatch', ...at });
    const cardId = fields.get('Card')?.match(/\bwc_[a-f0-9]{16}\b/)?.[0] ?? null;
    if (!cardId) errors.push({ code: 'entry-card-missing', ...at });
    const source = fields.get('Source message')?.trim() || null;
    if (!source) errors.push({ code: 'entry-source-missing', ...at });
    for (const email of document.markdown.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []) {
      if (!email.toLowerCase().endsWith('@example.com')) errors.push({ code: 'entry-email-not-synthetic', ...at });
    }
    const diagnosis = section(visible, /^## Diagnosis\b/);
    const problems = new Map<number, string[]>();
    if (diagnosis === null) errors.push({ code: 'entry-diagnosis-missing', ...at });
    else {
      const starts = [...diagnosis.matchAll(/^(\d+)\.\s+/gm)];
      for (let i = 0; i < starts.length; i++) {
        const problem = Number(starts[i][1]);
        if (!Number.isSafeInteger(problem) || problem < 1 || problems.has(problem)) errors.push({ code: 'entry-problem-number-invalid', ...at, problem });
        const references = readFeedbackRuleIds(diagnosis.slice(starts[i].index!, starts[i + 1]?.index ?? diagnosis.length));
        const ids = references.ids;
        if (references.invalid) errors.push({ code: 'entry-problem-rule-id-invalid', ...at, problem });
        problems.set(problem, ids);
        if (!ids.length) errors.push({ code: 'entry-problem-rule-missing', ...at, problem });
        for (const ruleId of ids) if (!rules.has(ruleId)) errors.push({ code: 'entry-problem-rule-unknown', ...at, problem, ruleId });
      }
      if (!problems.size) errors.push({ code: 'entry-problems-empty', ...at });
    }
    const table = section(visible, /^## Rules this entry added or sharpened\s*$/);
    const linked = new Set<string>();
    if (table === null) errors.push({ code: 'entry-rules-table-missing', ...at });
    else for (const line of table.split('\n')) {
      const row = /^\|\s*`?(DS-[A-Z][A-Z0-9]*-\d+)`?\s*\|\s*([^|]+)\|\s*([^|]+)\|$/.exec(line);
      if (!row) continue;
      const ruleId = row[1];
      if (linked.has(ruleId)) errors.push({ code: 'entry-rule-duplicate', ...at, ruleId });
      linked.add(ruleId);
      const rule = rules.get(ruleId);
      if (!rule) errors.push({ code: 'entry-rule-unknown', ...at, ruleId });
      else if (!rule.earnedFrom.includes(id)) errors.push({ code: 'entry-rule-provenance-missing', ...at, ruleId });
      const refs = row[3].trim().split(/\s*,\s*/);
      for (const ref of refs) {
        const problem = Number(ref);
        if (!/^\d+$/.test(ref) || !problems.has(problem)) errors.push({ code: 'entry-problem-reference-invalid', ...at, ruleId });
        else if (!problems.get(problem)!.includes(ruleId)) errors.push({ code: 'entry-problem-rule-mismatch', ...at, ruleId, problem });
      }
    }
    for (const rule of parsed.rules) if (rule.earnedFrom.includes(id) && !linked.has(rule.id)) errors.push({ code: 'entry-earned-rule-missing', ...at, ruleId: rule.id });
    entries.push({ id, path, cardId, sourcePresent: source !== null, problemCount: problems.size, ruleIds: [...linked].sort() });
  }
  const ids = new Set(entries.map(entry => entry.id));
  for (const rule of parsed.rules) for (const entryId of rule.earnedFrom) if (!ids.has(entryId)) errors.push({ code: 'earned-entry-missing', entryId, ruleId: rule.id });
  return { schemaVersion: 1 as const, scope: 'feedback-entry-structure' as const, mergeAuthority: false as const,
    sourceVerification: false as const, publicationPrivacyReview: false as const,
    notEvaluated: ['changelog-exactness', 'base-entry-history', 'gate-miss-fix-links', 'owner-quote-redaction-review', 'server-feedback-card-binding'], entries, errors };
}
