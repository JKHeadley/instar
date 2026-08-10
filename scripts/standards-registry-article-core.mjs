/**
 * Dependency-free structural core for the constrained Standards Registry
 * Markdown dialect. Runtime, prebuild coverage, and audit-convergence tooling
 * consume this one heading/block grammar.
 */

const H2_RE = /^##\s+(.+?)\s*$/;
const H3_RE = /^###\s+(.+?)\s*$/;
export const ARTICLE_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

function visibleRegistryLines(markdown) {
  const rawLines = markdown.split('\n');
  const visible = [];
  let fence = null;
  let inComment = false;

  for (const raw of rawLines) {
    // Preserve `rawLines` byte-for-byte for span evidence while giving every
    // structural consumer an LF-equivalent visible line on CRLF checkouts.
    const decodedLine = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const trimmed = decodedLine.trimStart();
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
    if (fence === null && fenceMatch) {
      fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
      visible.push(null);
      continue;
    }
    if (fence !== null) {
      const closing = new RegExp(`^${fence.marker}{${fence.length},}\\s*$`);
      if (closing.test(trimmed)) fence = null;
      visible.push(null);
      continue;
    }
    if (/^\s*>/.test(decodedLine)) {
      visible.push(null);
      continue;
    }

    let line = decodedLine;
    let out = '';
    let cursor = 0;
    while (cursor < line.length) {
      if (inComment) {
        const end = line.indexOf('-->', cursor);
        if (end === -1) { cursor = line.length; break; }
        inComment = false;
        cursor = end + 3;
        continue;
      }
      const start = line.indexOf('<!--', cursor);
      if (start === -1) { out += line.slice(cursor); break; }
      out += line.slice(cursor, start);
      inComment = true;
      cursor = start + 4;
    }
    visible.push(out);
  }
  return { rawLines, visible };
}

/**
 * Refuse an INDENTED `##`/`###` heading — out of this registry's constrained dialect.
 *
 * Found by external review pass 11, which appended `   ### Indented New Standard` (three spaces —
 * also reproduced with one) and watched a brand-new constitutional standard become invisible to
 * EVERY guard at once: the fingerprint requirement, the duplicate-definitions check, the gap sweep
 * and the self-counts check all reported clean, and `standards-coverage --json` still said
 * `total=88` with `unrecognized-sections=0`. CommonMark allows up to three leading spaces, and
 * `marked` — this repository's own renderer — emits `<h3>`. So the heading is REAL to every reader
 * and absent from every parser, because each one keys on `^###`. One space evades the entire change.
 *
 * This is the same collision family as `GAP-name-keyed-population-collision`, one level lower: the
 * article never joins the population at all, so the partition identity is trivially satisfied and
 * the arithmetic that catches a duplicate cannot see it. A guard cannot count what it never parsed.
 *
 * The fix is a REFUSAL, not a widened matcher, and the choice is deliberate. Teaching nine separate
 * regexes to accept `^ {0,3}###` would mean nine chances to disagree, in a repository whose recurring
 * defect is exactly two definitions of one thing drifting apart. Refusing the ambiguous form keeps a
 * single grammar: a heading either starts at column zero and is seen by everything, or the build
 * fails and says why. This file's own header already calls the dialect "constrained" — this is what
 * constrained means, enforced rather than assumed.
 *
 * Scope, stated because pass 11 punished exactly this kind of unstated scope: it inspects lines
 * OUTSIDE fenced blocks only (a fenced example may show anything), and it says nothing about whether
 * the headings it does admit are correct.
 */
export function findIndentedHeadings(markdown) {
  const { visible } = visibleRegistryLines(markdown);
  const out = [];
  for (let i = 0; i < visible.length; i += 1) {
    const line = visible[i];
    if (line === null) continue; // inside a fence or an HTML comment — not structural
    const m = line.match(/^( {1,3})(#{2,3})\s+(.+?)\s*$/);
    if (m) out.push({ lineNo: i + 1, indent: m[1].length, level: m[2].length, text: m[3].trim() });
  }
  return out;
}

export function parseRegistryStructure(markdown) {
  const { rawLines, visible } = visibleRegistryLines(markdown);
  const sections = [];
  let section = null;
  let block = null;

  const closeBlock = (endLine) => {
    if (!block) return;
    block.endLine = endLine;
    block.raw = rawLines.slice(block.startLine, endLine).join('\n');
    block.visibleLines = visible.slice(block.startLine + 1, endLine);
    block = null;
  };
  const closeSection = (endLine) => {
    if (!section) return;
    section.endLine = endLine;
    section.raw = rawLines.slice(section.startLine, endLine).join('\n');
  };

  for (let i = 0; i < visible.length; i++) {
    const line = visible[i];
    if (line === null) continue;
    const h2 = line.match(H2_RE);
    if (h2) {
      closeBlock(i);
      closeSection(i);
      section = {
        heading: h2[1].trim(),
        startLine: i,
        endLine: visible.length,
        raw: '',
        blocks: [],
      };
      sections.push(section);
      continue;
    }
    const h3 = line.match(H3_RE);
    if (h3 && section) {
      closeBlock(i);
      block = {
        name: h3[1].trim(),
        startLine: i,
        endLine: visible.length,
        raw: '',
        visibleLines: [],
      };
      section.blocks.push(block);
    }
  }
  closeBlock(visible.length);
  closeSection(visible.length);
  return sections;
}

export function articleIds(block) {
  const ids = [];
  for (const line of block.visibleLines) {
    if (line === null) continue;
    const m = line.match(/^\*\*Article ID\.\*\*\s*`?([^`\s]+)`?\s*$/);
    if (m) ids.push(m[1]);
  }
  return ids;
}
