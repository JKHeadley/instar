/**
 * Asset-only setup for suites that exercise the production registry resolver.
 *
 * E2E deliberately does not compile `dist/`: doing so wakes dist-gated tests that
 * are meant to remain dormant in that shard. The packed constitution is generated
 * build output too, but it is independent of TypeScript compilation, so prepare
 * only that asset here.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseStandardsRegistryDetailed,
  runRegistryCanary,
} from '../../src/core/StandardsRegistryParser.js';
import { buildGuardTreeIndex } from '../../src/core/StandardsEnforcementAuditor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export default function setup(): void {
  ensureRegistryAsset(ROOT);
}

/** Exported so the production-generator parity ratchet can use an isolated root. */
export function ensureRegistryAsset(root: string): void {
  const outputDirs = [path.join(root, 'src', 'data'), path.join(root, 'dist', 'data')];
  const outputs = outputDirs.flatMap(dir => [
    path.join(dir, 'standards-registry.md'),
    path.join(dir, 'standards-registry.meta.json'),
    path.join(dir, 'standards-guard-index.json'),
    path.join(dir, 'standards-guard-index.meta.json'),
  ]);
  if (outputs.every(output => fs.existsSync(output))) return;

  const sourceRelative = 'docs/STANDARDS-REGISTRY.md';
  const bytes = fs.readFileSync(path.join(root, sourceRelative));
  const parsed = parseStandardsRegistryDetailed(bytes.toString('utf-8'));
  const canary = runRegistryCanary(parsed.articles, parsed.diagnostics);
  if (!canary.ok) {
    throw new Error(`refusing to generate the E2E registry asset: ${canary.failures.join('; ')}`);
  }

  const floor = JSON.parse(
    fs.readFileSync(path.join(root, 'docs', 'standards-registry-floor.json'), 'utf-8'),
  ) as { minArticleCount?: unknown };
  const articleCount = parsed.diagnostics.articleHeadings;
  if (
    typeof floor.minArticleCount !== 'number'
    || !Number.isFinite(floor.minArticleCount)
    || articleCount < floor.minArticleCount
  ) {
    throw new Error(
      `refusing to generate the E2E registry asset: ${articleCount} articles is below an unusable or higher committed floor`,
    );
  }

  const packageVersion = (
    JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as { version?: unknown }
  ).version;
  if (typeof packageVersion !== 'string' || packageVersion.length === 0) {
    throw new Error('refusing to generate the E2E registry asset: package version is missing');
  }
  const meta = `${JSON.stringify({
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    articleCount,
    generatedFrom: sourceRelative,
    packageVersion,
  }, null, 2)}\n`;
  const registrySha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const guardIndex = buildGuardTreeIndex(root, bytes.toString('utf-8'), packageVersion);
  const guardIndexBytes = Buffer.from(`${JSON.stringify(guardIndex, null, 2)}\n`, 'utf-8');
  const guardIndexMeta = `${JSON.stringify({
    sha256: crypto.createHash('sha256').update(guardIndexBytes).digest('hex'),
    registrySha256,
    packageVersion,
  }, null, 2)}\n`;

  for (const dir of outputDirs) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'standards-registry.md'), bytes);
    fs.writeFileSync(path.join(dir, 'standards-registry.meta.json'), meta);
    fs.writeFileSync(path.join(dir, 'standards-guard-index.json'), guardIndexBytes);
    fs.writeFileSync(path.join(dir, 'standards-guard-index.meta.json'), guardIndexMeta);
  }
}
