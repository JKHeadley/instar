/**
 * Instar Documents — the plain-text projection (spec docs/specs/instar-document-viewer.md §3.5).
 *
 * Comments anchor on this string, so every machine and the page must compute exactly the same
 * text for the same markdown. The core (`projectTextWith`) is pure: it uses only the `marked`
 * lexer (never the renderer) with explicit options, plus an injected sha256 — no Node-only API —
 * so the same module can be served to the page.
 *
 * Projection version 1:
 * - Tokens are walked in document order; only text content is emitted.
 * - One block per: heading, paragraph, code block, block html, list item (its own inline text;
 *   a nested list contributes its own blocks), table row (cells joined with " | "), and a
 *   top-level inline run.
 * - Inline: text/escape/codespan emit their text, emphasis/links recurse, images emit alt text,
 *   inline html emits its raw text, a line break is a space. Task checkboxes and rules emit nothing.
 * - Inside a block every whitespace run becomes one space, the block is trimmed, empty blocks
 *   are dropped, and blocks are joined with "\n".
 * - `hint` = first 16 hex of sha256(JSON [headingPath, ordinal]), where headingPath is the texts
 *   of the enclosing headings (outermost first) and ordinal counts blocks under that path
 *   (a heading itself is ordinal 0 of its own path).
 */
import { createHash } from 'node:crypto';
import { Lexer, type Token, type Tokens } from 'marked';

export const PROJECTION_VERSION = 1 as const;

export interface ProjectionBlock { start: number; end: number; hint: string }
export interface Projection { text: string; blocks: ProjectionBlock[] }

/** Lexer options pinned for projection version 1 (never the shared global defaults). */
const LEXER_OPTIONS_V1 = Object.freeze({ gfm: true, breaks: false, pedantic: false });

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

function inlineText(tokens: readonly Token[] | undefined): string {
  if (!tokens) return '';
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'text':
        out += (t as Tokens.Text).tokens ? inlineText((t as Tokens.Text).tokens) : (t as Tokens.Text).text;
        break;
      case 'escape':
      case 'codespan':
      case 'html':
        out += (t as { text: string }).text;
        break;
      case 'br':
        out += ' ';
        break;
      case 'image':
        out += (t as Tokens.Image).text;
        break;
      case 'checkbox':
        break;
      default: {
        const nested = (t as { tokens?: Token[] }).tokens;
        if (nested) out += inlineText(nested);
        else if (typeof (t as { text?: unknown }).text === 'string') out += (t as { text: string }).text;
      }
    }
  }
  return out;
}

interface RawBlock { text: string; path: readonly string[] }

function walkBlocks(tokens: readonly Token[], emit: (text: string) => void, onHeading: (depth: number, text: string) => void): void {
  let inlineRun = '';
  const flushRun = (): void => { if (inlineRun) { emit(inlineRun); inlineRun = ''; } };
  for (const t of tokens) {
    switch (t.type) {
      case 'space':
      case 'hr':
      case 'def':
      case 'checkbox':
        flushRun();
        break;
      case 'heading': {
        flushRun();
        const text = inlineText((t as Tokens.Heading).tokens);
        onHeading((t as Tokens.Heading).depth, collapse(text));
        emit(text);
        break;
      }
      case 'paragraph':
        flushRun();
        emit(inlineText((t as Tokens.Paragraph).tokens));
        break;
      case 'code':
        flushRun();
        emit((t as Tokens.Code).text);
        break;
      case 'html':
        flushRun();
        emit((t as Tokens.HTML).text);
        break;
      case 'blockquote':
        flushRun();
        walkBlocks((t as Tokens.Blockquote).tokens, emit, onHeading);
        break;
      case 'list':
        flushRun();
        for (const item of (t as Tokens.List).items) walkBlocks(item.tokens, emit, onHeading);
        break;
      case 'table': {
        flushRun();
        const table = t as Tokens.Table;
        const row = (cells: Tokens.TableCell[]): string => cells.map((c) => collapse(inlineText(c.tokens))).join(' | ');
        emit(row(table.header));
        for (const r of table.rows) emit(row(r));
        break;
      }
      case 'text':
        // A block-level text token (tight list items): inline content of the current item.
        inlineRun += inlineText([t]);
        break;
      default: {
        const nested = (t as { tokens?: Token[] }).tokens;
        flushRun();
        if (nested) walkBlocks(nested, emit, onHeading);
        else if (typeof (t as { text?: unknown }).text === 'string') emit((t as { text: string }).text);
      }
    }
  }
  flushRun();
}

/** The pure projection: no Node API; the caller supplies sha256 (hex). */
export function projectTextWith(markdown: string, sha256hex: (s: string) => string, projectionVersion: number = PROJECTION_VERSION): Projection {
  if (projectionVersion !== 1) throw new Error(`unknown projectionVersion ${projectionVersion}`);
  const tokens = Lexer.lex(markdown, { ...LEXER_OPTIONS_V1 });
  const headingStack: Array<{ depth: number; text: string }> = [];
  const raw: RawBlock[] = [];
  walkBlocks(
    tokens,
    (text) => {
      const c = collapse(text);
      if (c) raw.push({ text: c, path: headingStack.map((h) => h.text) });
    },
    (depth, text) => {
      while (headingStack.length && headingStack[headingStack.length - 1].depth >= depth) headingStack.pop();
      headingStack.push({ depth, text });
    },
  );
  const ordinals = new Map<string, number>();
  const blocks: ProjectionBlock[] = [];
  let text = '';
  for (const b of raw) {
    const key = JSON.stringify(b.path);
    const ordinal = ordinals.get(key) ?? 0;
    ordinals.set(key, ordinal + 1);
    if (blocks.length) text += '\n';
    const start = text.length;
    text += b.text;
    blocks.push({ start, end: text.length, hint: sha256hex(JSON.stringify([b.path, ordinal])).slice(0, 16) });
  }
  return { text, blocks };
}

const nodeSha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export function projectText(markdown: string, projectionVersion: number = PROJECTION_VERSION): Projection {
  return projectTextWith(markdown, nodeSha256, projectionVersion);
}
