/**
 * Reading a store's JSON file without ever losing it (Echo's review of #2195).
 *
 * - No file: start empty.
 * - A file that is not valid JSON: move it aside (`<file>.unreadable-<time>`), report it, start
 *   empty. The next save writes a fresh file, and the bad one is still there to inspect.
 * - Any other read error (permissions, I/O): throw. Starting empty here would let the next save
 *   overwrite pins that are still on disk, so the store refuses to start instead.
 */

import fs from 'node:fs';

export type StoreProblemReporter = (message: string) => void;

export const defaultReporter: StoreProblemReporter = (m) => { process.stderr.write(`[threadline-core] ${m}\n`); };

export function readStoreJson(file: string, now: () => Date, report: StoreProblemReporter): unknown | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`cannot read ${file} (${(err as NodeJS.ErrnoException).code ?? String(err)}); refusing to start rather than overwrite it`);
  }
  try {
    return JSON.parse(text);
  } catch {
    const aside = `${file}.unreadable-${now().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(file, aside);
    report(`${file} was not valid JSON. It was moved to ${aside} and this store started empty; nothing in it was deleted.`);
    return null;
  }
}
