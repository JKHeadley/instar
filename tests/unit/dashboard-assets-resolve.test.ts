/**
 * Dashboard asset-resolution floor — F8 of the Dashboard UX Standard
 * (docs/specs/dashboard-ux-standard.md; Structure > Willpower).
 *
 * F8: every referenced image/icon asset resolves to a real target (or is
 * inlined). A broken asset ref renders as a broken-image glyph — the kind of
 * papercut that makes a dashboard feel unfinished. This floor fails, naming the
 * ref, if a static local asset reference has no file on disk.
 *
 * Scope: local `src="/dashboard/…"` and `src="./…"`/`src="…"` relative refs.
 * Data-URIs, absolute http(s) URLs, and dynamically-built (`${…}`) srcs are
 * runtime concerns and are excluded.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = path.resolve(__dirname, '..', '..', 'dashboard');
const DASHBOARD_HTML = path.join(DASHBOARD_DIR, 'index.html');

/** Resolve a `/dashboard/x` or relative `x` ref to a path under the dashboard dir. */
function resolveRef(ref: string): string | null {
  if (ref.startsWith('data:') || /^https?:\/\//.test(ref) || ref.includes('${')) return null;
  const clean = ref.split('?')[0].split('#')[0];
  if (clean.startsWith('/dashboard/')) return path.join(DASHBOARD_DIR, clean.slice('/dashboard/'.length));
  if (clean.startsWith('/')) return null; // other server-mounted roots — not our static dir
  return path.join(DASHBOARD_DIR, clean.replace(/^\.\//, ''));
}

describe('dashboard asset-resolution floor (F8)', () => {
  it('every referenced local asset resolves to a real file', () => {
    const html = fs.readFileSync(DASHBOARD_HTML, 'utf-8');

    const refs = new Set<string>();
    for (const m of html.matchAll(/\bsrc="([^"]+)"/g)) refs.add(m[1]);
    for (const m of html.matchAll(/url\((['"]?)([^)'"]+)\1\)/g)) refs.add(m[2]);

    const missing: string[] = [];
    let checked = 0;
    for (const ref of refs) {
      const resolved = resolveRef(ref);
      if (resolved == null) continue; // excluded (data:/http/dynamic/other-root)
      checked++;
      if (!fs.existsSync(resolved)) missing.push(`${ref} → ${path.relative(DASHBOARD_DIR, resolved)}`);
    }

    // At least the known logo asset must be checked (guards a regressed matcher).
    expect(checked, 'local asset refs checked by the F8 floor').toBeGreaterThanOrEqual(1);

    expect(
      missing,
      `Broken asset references (the F8 bug): ${missing.join(', ')}. ` +
        `Ship the file under dashboard/, inline it as a data: URI, or fix the path.`
    ).toEqual([]);
  });
});
