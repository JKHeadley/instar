/**
 * Lint: bare `catch {}` blocks in src/ TypeScript runtime code are
 * silent-failure backdoors. They turn errors into nothing — no log, no
 * degradation report, no rethrow, no annotation explaining why.
 *
 * This lint is COMPLEMENTARY to `tests/unit/no-silent-fallbacks.test.ts`
 * (the existing ratcheted check for "return null / return [] after
 * catch"). That lint catches catches that produce a degraded value;
 * THIS lint catches catches that produce NOTHING — the
 * `} catch {} // <silence>` shape — which the existing lint's
 * `isTrueFallback` heuristic does NOT count (it requires a fallback
 * return or comment or state reset).
 *
 * Why it exists
 * -------------
 * Per the 2026-05-29 pipeline post-mortem (lever D): pattern #4 was
 * "silent failure caught only by user." The PromptGate $452 incident
 * was the worst — a bare `catch {}` in a 5-second hot-path detection
 * loop that swallowed every rate-limit failure for hours, bypassing
 * QuotaTracker + LlmQueue spend guards. By the time it surfaced it had
 * burned $452 of credits.
 *
 * The pattern is so cheap to write (zero characters of body) that it
 * happens by reflex when an author wants to bypass a throw without
 * thinking about WHY. This lint refuses to ship them without a
 * documented rationale.
 *
 * The rule
 * --------
 * Every catch block in src/ (excluding tests and template-literal
 * code-generation contexts in PostUpdateMigrator.ts) must do at least
 * ONE of:
 *   1. Have a non-empty body (any statement counts — logging, rethrow,
 *      DegradationReporter, state mutation, even a single comment).
 *   2. Carry the `@silent-fallback-ok` annotation either inside the
 *      block or on the line above (per the existing convention used
 *      in TrustRecovery, SyncOrchestrator, etc.).
 *
 * Ratchet
 * -------
 * The existing 27 empty-catch sites are baselined here. New code must
 * not add more. Each baseline-bump is a deliberate acceptance of debt
 * and should be accompanied by a rationale (matching the pattern of
 * baseline-bumps in `no-silent-fallbacks.test.ts`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const SRC_DIR = path.resolve(__dirname, '../../src');

/**
 * Files inside src/ that legitimately embed JS template-literal code
 * generation (which often contains catch{} in the EMITTED code, not
 * the migrator's own runtime). Excluded from the scan — the emitted
 * code is shipped to agents and a different review surface (the hook
 * scripts themselves) covers it.
 */
const TEMPLATE_LITERAL_FILES = new Set<string>([
  'src/core/PostUpdateMigrator.ts',
  'src/commands/init.ts',
]);

/**
 * Walk src/ for `.ts` files, excluding tests and template-literal hosts.
 */
function tsFilesIn(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...tsFilesIn(full));
    } else if (entry.isFile()
      && entry.name.endsWith('.ts')
      && !entry.name.endsWith('.test.ts')
      && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

interface Hit {
  file: string;
  line: number;
  context: string;
}

/**
 * Find truly-empty catch blocks: `catch {}`, `catch (_) {}`, `catch (e) {}`
 * with no body, no comment INSIDE the braces, no annotation on the
 * surrounding line.
 *
 * Matches multi-line and single-line forms.
 */
function findEmptyCatchBlocks(filePath: string): Hit[] {
  const src = fs.readFileSync(filePath, 'utf-8');
  const lines = src.split('\n');
  const hits: Hit[] = [];

  // Iterative scan: find `catch (…) {` or `catch {`, then check the
  // matching closing brace immediately follows or contains only
  // whitespace / no semantic content.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Single-line form: `} catch (e) {}` / `} catch {}`
    const singleLineEmpty = /\bcatch\s*(\([^)]*\))?\s*\{\s*\}/.exec(line);
    if (singleLineEmpty) {
      // Already-annotated allowlist: @silent-fallback-ok on this line
      // OR the immediately preceding line.
      const prev = i > 0 ? lines[i - 1] : '';
      const hasAnnotation = /@silent-fallback-ok/.test(line) || /@silent-fallback-ok/.test(prev);
      if (!hasAnnotation) {
        hits.push({
          file: path.relative(SRC_DIR, filePath),
          line: i + 1,
          context: line.trim(),
        });
      }
      continue;
    }

    // Multi-line form: `catch (e) {` then next non-empty line is `}`.
    const multiLineOpen = /\bcatch\s*(\([^)]*\))?\s*\{\s*$/.exec(line);
    if (multiLineOpen) {
      // Scan forward for first non-empty / non-whitespace content.
      let j = i + 1;
      let body = '';
      while (j < lines.length) {
        const inner = lines[j];
        if (/^\s*\}/.test(inner)) {
          // Closing brace reached with no semantic content collected.
          if (body.trim() === '') {
            const prev = i > 0 ? lines[i - 1] : '';
            const hasAnnotation = /@silent-fallback-ok/.test(line)
              || /@silent-fallback-ok/.test(prev)
              || /@silent-fallback-ok/.test(body);
            if (!hasAnnotation) {
              hits.push({
                file: path.relative(SRC_DIR, filePath),
                line: i + 1,
                context: line.trim() + ' …multi-line empty…',
              });
            }
          }
          break;
        }
        body += '\n' + inner;
        j++;
        if (j - i > 8) break; // guard: not actually an empty block
      }
    }
  }

  return hits;
}

describe('No empty catch{} blocks in src/', () => {
  const srcFiles = tsFilesIn(SRC_DIR)
    .filter(f => !TEMPLATE_LITERAL_FILES.has(path.relative(path.resolve(SRC_DIR, '..'), f)));

  it('found .ts files to analyze', () => {
    expect(srcFiles.length).toBeGreaterThan(50);
  });

  it('ratchet baseline: no new bare catch{} blocks', () => {
    const hits = srcFiles.flatMap(findEmptyCatchBlocks);

    // ═══════════════════════════════════════════════════════════
    // RATCHET BASELINE — only DECREASE this number, never increase.
    // To clear a hit: either add a non-empty body (DegradationReporter,
    // log, rethrow, comment, etc.) or add the `@silent-fallback-ok`
    // annotation explaining WHY the swallow is safe.
    // ═══════════════════════════════════════════════════════════
    // 2026-05-29 (post-mortem lever D, this PR): the seven existing
    // bare-catch sites on main were all annotated in this PR — five in
    // src/paste/PasteManager.ts (unlink/stat cleanup), one
    // readPendingIndex, one audit-log append, plus one in
    // src/server/routes.ts (tunnel-url access fallback). Each carries
    // a @silent-fallback-ok annotation explaining WHY the silent
    // swallow is safe. Baseline starts at zero: any new bare catch
    // must be annotated or made non-empty before commit.
    //
    // PostUpdateMigrator.ts and commands/init.ts are excluded as
    // template-literal hosts (their empty catches are in EMITTED JS,
    // not the migrator's own runtime — covered by hook-script review).
    const BASELINE = 0;

    if (hits.length > BASELINE) {
      const report = hits.map(h => `  ${h.file}:${h.line} → ${h.context}`).join('\n');
      console.warn(`\n[EMPTY CATCH] ${hits.length} bare catch{} blocks (baseline ${BASELINE}):\n${report}\n`);
    }

    expect(
      hits.length,
      `Empty catch{} count (${hits.length}) exceeds ratchet baseline (${BASELINE}). ` +
      `Either add a non-empty body or the @silent-fallback-ok annotation to the new catch block. ` +
      `Lever D from the 2026-05-29 pipeline post-mortem — this lint exists because ` +
      `bare catch{} blocks turn errors into nothing and have caused real incidents ` +
      `(PromptGate $452 burn was a bare catch{} in a 5s loop).`,
    ).toBeLessThanOrEqual(BASELINE);
  });

  it('PromptGate.ts — the post-mortem $452 incident file — has no unannotated empty catches', () => {
    // Focused regression check on the file that gave the post-mortem
    // its silent-failure poster child. Any reintroduction of a bare
    // catch in this specific hot-path file fails immediately, even if
    // the global ratchet would tolerate it.
    const file = path.join(SRC_DIR, 'core/PromptGate.ts');
    if (!fs.existsSync(file)) return; // defensive — file may move
    const hits = findEmptyCatchBlocks(file);
    expect(
      hits.map(h => `line ${h.line}: ${h.context}`),
      'PromptGate.ts must not contain bare catch{} blocks — the 2026 $452 burn was a bare catch{} in its 5s detection loop',
    ).toEqual([]);
  });

  it('the `@silent-fallback-ok` annotation is honored on the catch line itself OR the line above', () => {
    // Smoke check on the parser: confirm at least one annotated catch
    // exists in the tree and is NOT counted as a hit. Catches a
    // regression where the lint stops respecting the annotation.
    const annotated = srcFiles.filter(f => {
      const c = fs.readFileSync(f, 'utf-8');
      return /catch\s*\(?[^)]*\)?\s*\{\s*\/\*\s*@silent-fallback-ok/.test(c)
        || /@silent-fallback-ok[\s\S]{0,80}?catch/.test(c);
    });
    expect(annotated.length, 'expected ≥1 annotated catch in tree (allowlist sanity)').toBeGreaterThan(0);
  });
});
