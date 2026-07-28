/**
 * loadCapturedFixture — the SINGLE sanctioned load path for captured parser
 * fixtures (tests/fixtures/captured/<slug>/<name>.txt).
 *
 * Captured fixtures are real-world-messy parser input whose STRUCTURAL bytes
 * (wrapping/ANSI/spacing/line-breaks) are sacrosanct (see
 * tests/fixtures/captured/README.md and the Scrape/Parser Fixture Realness
 * standard). The realness lint (scripts/lint-scrape-fixture-realness.js) keys
 * on calls to THIS helper to verify a registered parser is actually fed a real
 * captured fixture — so tests under realness enforcement must load via this fn,
 * not by hand-rolling fs.readFileSync.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// tests/helpers/ -> tests/fixtures/captured/
const CAPTURED_DIR = path.resolve(__dirname, '..', 'fixtures', 'captured');

/**
 * Read a captured fixture's `.txt` content verbatim (no trimming, no
 * normalization — the structural bytes are the point).
 *
 * @param slug  the capture-set directory under tests/fixtures/captured/
 * @param name  the basename of the `.txt` (without extension)
 * @returns the file content as a string
 * @throws a clear error if the fixture does not exist
 */
export function loadCapturedFixture(slug: string, name: string): string {
  const file = path.join(CAPTURED_DIR, slug, `${name}.txt`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `loadCapturedFixture: captured fixture not found at ${path.relative(
        path.resolve(__dirname, '..', '..'),
        file,
      )} — expected tests/fixtures/captured/${slug}/${name}.txt`,
    );
  }
  return fs.readFileSync(file, 'utf-8');
}
