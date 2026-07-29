/** The shipped MigrationPerEntryAction closed enum from MigrationLedger.ts. */
export const MIGRATION_LEDGER_ACTION_VALUES = Object.freeze([
  'migrated',
  'forked',
  'renamed',
  'skipped',
  'failed',
  'deferred-in-flight',
]);

/**
 * Return true only when a candidate range is a reference to the shipped
 * MigrationPerEntryAction enum: it must sit inside an inline-code span whose
 * complete value is in the closed enum, and the same line must enumerate at
 * least one other closed-enum member in its own inline-code span.
 *
 * A lone `deferred-in-flight` may still be an authorial disposition and remains
 * visible to the caller. Fenced blocks, headings, blockquotes, indented text,
 * standalone inline-code words, escaped backticks, and unknown identifiers also
 * remain visible. This validates already-structured input against a fixed enum;
 * it does not infer intent from identifier shape.
 */
export function isKnownInlineCodeEnumReference(markdown, candidateStart, candidateEnd) {
  if (
    typeof markdown !== 'string'
    || !Number.isInteger(candidateStart)
    || !Number.isInteger(candidateEnd)
    || candidateStart < 0
    || candidateEnd <= candidateStart
    || candidateEnd > markdown.length
  ) {
    return false;
  }

  const isEscaped = (index) => {
    let slashes = 0;
    for (let i = index - 1; i >= 0 && markdown[i] === '\\'; i -= 1) slashes += 1;
    return slashes % 2 === 1;
  };

  const fencedRanges = [];
  let fence = null;
  let lineStart = 0;
  while (lineStart < markdown.length) {
    const newline = markdown.indexOf('\n', lineStart);
    const lineEnd = newline >= 0 ? newline + 1 : markdown.length;
    const line = markdown.slice(lineStart, newline >= 0 ? newline : markdown.length).replace(/\r$/, '');
    let fenceLine = line;
    // CommonMark permits fences inside blockquote and list containers. Strip
    // only the structural prefix used to introduce a fence; the recorded byte
    // range still covers the untouched source.
    for (;;) {
      const quote = fenceLine.match(/^ {0,3}>[ \t]?/);
      if (quote) {
        fenceLine = fenceLine.slice(quote[0].length);
        continue;
      }
      const list = fenceLine.match(/^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/);
      if (list) {
        fenceLine = fenceLine.slice(list[0].length);
        continue;
      }
      break;
    }
    if (!fence) {
      const open = fenceLine.match(/^ {0,3}(`{3,}|~{3,})/);
      if (open) fence = { char: open[1][0], length: open[1].length, start: lineStart };
    } else {
      const close = fenceLine.match(/^ {0,3}(`+|~+)[ \t]*$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        fencedRanges.push({ start: fence.start, end: lineEnd });
        fence = null;
      }
    }
    lineStart = lineEnd;
  }
  if (fence) fencedRanges.push({ start: fence.start, end: markdown.length });

  const spans = [];
  for (let i = 0; i < markdown.length;) {
    const fenced = fencedRanges.find((range) => i >= range.start && i < range.end);
    if (fenced) {
      i = fenced.end;
      continue;
    }
    if (markdown[i] !== '`' || isEscaped(i)) {
      i += 1;
      continue;
    }

    let runLength = 1;
    while (markdown[i + runLength] === '`') runLength += 1;
    const lineStart = markdown.lastIndexOf('\n', i - 1) + 1;

    const contentStart = i + runLength;
    let close = contentStart;
    while (close < markdown.length) {
      if (markdown[close] !== '`' || isEscaped(close)) {
        close += 1;
        continue;
      }
      let closeLength = 1;
      while (markdown[close + closeLength] === '`') closeLength += 1;
      if (closeLength === runLength) break;
      close += closeLength;
    }

    if (close >= markdown.length) break;
    const lineEndIndex = markdown.indexOf('\n', close);
    spans.push({
      start: contentStart,
      end: close,
      value: markdown.slice(contentStart, close).trim(),
      lineStart,
      lineEnd: lineEndIndex >= 0 ? lineEndIndex : markdown.length,
    });
    i = close + runLength;
  }

  const target = spans.find((span) => candidateStart >= span.start && candidateEnd <= span.end);
  if (!target || !MIGRATION_LEDGER_ACTION_VALUES.includes(target.value)) return false;

  const referencedValues = new Set(
    spans
      .filter((span) => span.lineStart === target.lineStart && span.lineEnd === target.lineEnd)
      .map((span) => span.value)
      .filter((value) => MIGRATION_LEDGER_ACTION_VALUES.includes(value)),
  );
  return referencedValues.size >= 2;
}
