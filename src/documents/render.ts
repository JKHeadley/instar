/**
 * Instar Documents — the render tree the page builds its DOM from (spec §3.5, §3.6).
 *
 * The page never parses markdown and never receives HTML. The server walks the same `marked`
 * tokens the projection walks (same blocks, same order, same whitespace rule) and returns each
 * block as typed runs of plain text with marks (strong, em, code, del, link). Concatenating every
 * block's run texts, joined with "\n", is exactly `projectText(markdown).text`, so every character
 * on the page has a known projection offset and a selection maps to `(start, end)` with no
 * guessing. A test pins that equality.
 *
 * Nothing here is ever interpreted as markup: links carry an href that the page checks with
 * `new URL()` and keeps only for http, https and mailto.
 */
import { Lexer, type Token, type Tokens } from 'marked';
import { PROJECTION_VERSION, projectText } from './projection.js';

export type Mark = 'strong' | 'em' | 'code' | 'del' | 'link';
export interface Run { text: string; marks?: Mark[]; href?: string }
export interface Block {
  kind: 'heading' | 'paragraph' | 'code' | 'html' | 'item' | 'row' | 'text';
  level?: number;
  ordered?: boolean;
  header?: boolean;
  quote?: number;
  start: number;
  end: number;
  runs: Run[];
}

interface RawRun { text: string; marks: Mark[]; href?: string }
interface RawBlock { kind: Block['kind']; level?: number; ordered?: boolean; header?: boolean; quote: number; runs: RawRun[] }

const LEXER_OPTIONS_V1 = Object.freeze({ gfm: true, breaks: false, pedantic: false });

/** Inline runs, mirroring projection.ts `inlineText` exactly (same text, now with marks). */
function inlineRuns(tokens: readonly Token[] | undefined, marks: Mark[], href?: string): RawRun[] {
  if (!tokens) return [];
  const out: RawRun[] = [];
  const push = (text: string, m: Mark[] = marks, h: string | undefined = href): void => { if (text) out.push({ text, marks: m, ...(h ? { href: h } : {}) }); };
  for (const t of tokens) {
    switch (t.type) {
      case 'text': {
        const tt = t as Tokens.Text;
        if (tt.tokens) out.push(...inlineRuns(tt.tokens, marks, href)); else push(tt.text);
        break;
      }
      case 'escape': case 'html': push((t as { text: string }).text); break;
      case 'codespan': push((t as { text: string }).text, [...marks, 'code']); break;
      case 'br': push(' '); break;
      case 'image': push((t as Tokens.Image).text); break;
      case 'checkbox': break;
      case 'strong': out.push(...inlineRuns((t as Tokens.Strong).tokens, [...marks, 'strong'], href)); break;
      case 'em': out.push(...inlineRuns((t as Tokens.Em).tokens, [...marks, 'em'], href)); break;
      case 'del': out.push(...inlineRuns((t as Tokens.Del).tokens, [...marks, 'del'], href)); break;
      case 'link': out.push(...inlineRuns((t as Tokens.Link).tokens, [...marks, 'link'], (t as Tokens.Link).href)); break;
      default: {
        const nested = (t as { tokens?: Token[] }).tokens;
        if (nested) out.push(...inlineRuns(nested, marks, href));
        else if (typeof (t as { text?: unknown }).text === 'string') push((t as { text: string }).text);
      }
    }
  }
  return out;
}

/** Blocks, mirroring projection.ts `walkBlocks` exactly. */
function walk(tokens: readonly Token[], emit: (b: RawBlock) => void, quote: number, item: { ordered: boolean; level: number } | null): void {
  let run: RawRun[] = [];
  const flush = (): void => { if (run.length) { emit({ kind: item ? 'item' : 'text', ordered: item?.ordered, level: item?.level, quote, runs: run }); run = []; } };
  for (const t of tokens) {
    switch (t.type) {
      case 'space': case 'hr': case 'def': case 'checkbox': flush(); break;
      case 'heading': flush(); emit({ kind: 'heading', level: (t as Tokens.Heading).depth, quote, runs: inlineRuns((t as Tokens.Heading).tokens, []) }); break;
      case 'paragraph': flush(); emit({ kind: item ? 'item' : 'paragraph', ordered: item?.ordered, level: item?.level, quote, runs: inlineRuns((t as Tokens.Paragraph).tokens, []) }); break;
      case 'code': flush(); emit({ kind: 'code', quote, runs: [{ text: (t as Tokens.Code).text, marks: ['code'] }] }); break;
      case 'html': flush(); emit({ kind: 'html', quote, runs: [{ text: (t as Tokens.HTML).text, marks: [] }] }); break;
      case 'blockquote': flush(); walk((t as Tokens.Blockquote).tokens, emit, quote + 1, item); break;
      case 'list': {
        flush();
        const list = t as Tokens.List;
        for (const it of list.items) walk(it.tokens, emit, quote, { ordered: list.ordered, level: (item?.level ?? 0) + 1 });
        break;
      }
      case 'table': {
        flush();
        const table = t as Tokens.Table;
        const row = (cells: Tokens.TableCell[], header: boolean): void => {
          const runs: RawRun[] = [];
          cells.forEach((c, i) => {
            if (i > 0) runs.push({ text: ' | ', marks: [] });
            // Cells are collapsed individually by the projection: do the same here.
            runs.push(...collapseRuns(inlineRuns(c.tokens, [])));
          });
          emit({ kind: 'row', header, quote, runs });
        };
        row(table.header, true);
        for (const r of table.rows) row(r, false);
        break;
      }
      case 'text': run.push(...inlineRuns([t], [])); break;
      default: {
        const nested = (t as { tokens?: Token[] }).tokens;
        flush();
        if (nested) walk(nested, emit, quote, item);
        else if (typeof (t as { text?: unknown }).text === 'string') emit({ kind: 'paragraph', quote, runs: [{ text: (t as { text: string }).text, marks: [] }] });
      }
    }
  }
  flush();
}

/** Collapse whitespace across runs exactly as `collapse(joinedText)` would, keeping run boundaries. */
function collapseRuns(runs: RawRun[]): RawRun[] {
  const chars: Array<{ c: string; r: number }> = [];
  runs.forEach((run, r) => { for (const c of run.text) chars.push({ c, r }); });
  const out: Array<{ c: string; r: number }> = [];
  let pendingSpace: number | null = null;
  for (const ch of chars) {
    if (/\s/.test(ch.c)) { if (out.length && pendingSpace === null) pendingSpace = ch.r; continue; }
    if (pendingSpace !== null) { out.push({ c: ' ', r: pendingSpace }); pendingSpace = null; }
    out.push(ch);
  }
  const merged: RawRun[] = [];
  for (const ch of out) {
    const last = merged[merged.length - 1];
    if (last && (last as RawRun & { _r?: number })._r === ch.r) last.text += ch.c;
    else merged.push({ ...runs[ch.r], text: ch.c, _r: ch.r } as RawRun & { _r: number });
  }
  return merged.map(({ text, marks, href }) => ({ text, marks, ...(href ? { href } : {}) }));
}

/**
 * The render tree for a version. Throws if, against all expectation, its text ever differs from the
 * projection (the page would then misplace comments): the route turns that into a 500, never a
 * silently misaligned page.
 */
export function renderTree(markdown: string, projectionVersion: number = PROJECTION_VERSION): Block[] {
  if (projectionVersion !== 1) throw new Error(`unknown projectionVersion ${projectionVersion}`);
  const raw: RawBlock[] = [];
  walk(Lexer.lex(markdown, { ...LEXER_OPTIONS_V1 }), (b) => raw.push(b), 0, null);
  const blocks: Block[] = [];
  let offset = 0;
  for (const b of raw) {
    const runs = collapseRuns(b.runs);
    const text = runs.map((r) => r.text).join('');
    if (!text) continue;
    if (blocks.length) offset += 1; // the "\n" between blocks
    const start = offset;
    offset += text.length;
    blocks.push({
      kind: b.kind, start, end: offset, quote: b.quote || undefined,
      ...(b.level !== undefined ? { level: b.level } : {}), ...(b.ordered !== undefined ? { ordered: b.ordered } : {}), ...(b.header !== undefined ? { header: b.header } : {}),
      runs: runs.map((r) => ({ text: r.text, ...(r.marks.length ? { marks: r.marks } : {}), ...(r.href ? { href: r.href } : {}) })),
    });
  }
  const joined = blocks.map((b) => b.runs.map((r) => r.text).join('')).join('\n');
  if (joined !== projectText(markdown, projectionVersion).text) throw new Error('render tree does not match the projection');
  return blocks;
}
