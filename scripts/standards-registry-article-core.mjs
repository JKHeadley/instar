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
