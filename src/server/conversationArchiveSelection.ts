/** Select only a consumed globally ordered prefix; lookahead never advances the cursor. */
export interface ArchiveCandidatePage<T> { rows: T[]; more: boolean; incomplete?: boolean }
export interface ArchiveSelection<T> { rows: T[]; nextCursor: string | null; moreCandidates: boolean; archiveSelectionComplete: boolean }
export async function selectArchivePage<T>(input: {
  cursor: string | null; limit: number;
  fetch: (cursor: string | null) => Promise<ArchiveCandidatePage<T>>;
  cursorFor: (row: T) => string;
  select: (row: T) => boolean;
  admitted: () => boolean;
}): Promise<ArchiveSelection<T>> {
  const rows: T[] = [];
  let cursor = input.cursor; let complete = true;
  while (input.admitted()) {
    const page = await input.fetch(cursor);
    if (page.incomplete) complete = false;
    if (!page.rows.length) return { rows, nextCursor: page.more ? cursor : null, moreCandidates: page.more, archiveSelectionComplete: complete && !page.more };
    for (let i = 0; i < page.rows.length; i++) {
      const row = page.rows[i];
      cursor = input.cursorFor(row);
      if (input.select(row)) rows.push(row);
      const more = i + 1 < page.rows.length || page.more;
      if (rows.length === input.limit) return { rows, nextCursor: more ? cursor : null, moreCandidates: more, archiveSelectionComplete: complete };
      if (!input.admitted()) return { rows, nextCursor: more ? cursor : null, moreCandidates: more, archiveSelectionComplete: false };
    }
    if (!page.more) return { rows, nextCursor: null, moreCandidates: false, archiveSelectionComplete: complete };
    // Let queued revocation/state work run during a long fully excluded native inventory.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return { rows, nextCursor: cursor, moreCandidates: true, archiveSelectionComplete: false };
}
