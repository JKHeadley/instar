/** Build literal FTS5 terms. A dotted name or hyphenated ID is one phrase of
 * adjacent indexed words. User text never becomes an FTS5 operator. */
export function literalFtsTerms(query: string): string[] {
  return query
    .split(/[\s\p{Cc}]+/u)
    .map((token) => token.replace(/^[^\p{L}\p{N}\p{M}]+|[^\p{L}\p{N}\p{M}]+$/gu, ''))
    .filter((token) => !/^(AND|OR|NOT|NEAR)$/i.test(token) && token.length > 0);
}

export function quoteFtsTerm(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}
