import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

function readJson<T>(relPath: string): T {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf-8')) as T;
}

describe('provider-neutral workflow descriptors', () => {
  const descriptors = [
    {
      relPath: 'skills/robust-development/workflow.descriptor.json',
      id: 'robust-development',
      scope: 'generic-project',
    },
    {
      relPath: 'skills/instar-dev/workflow.descriptor.json',
      id: 'instar-dev',
      scope: 'instar-source',
    },
    {
      relPath: 'skills/spec-converge/workflow.descriptor.json',
      id: 'spec-converge',
      scope: 'instar-source',
    },
  ];

  it('declares the expected provider-neutral workflow surfaces', () => {
    for (const descriptor of descriptors) {
      const json = readJson<Record<string, unknown>>(descriptor.relPath);

      expect(json.schemaVersion).toBe(1);
      expect(json.id).toBe(descriptor.id);
      expect(json.scope).toBe(descriptor.scope);
      expect(Array.isArray(json.phases)).toBe(true);
      expect((json.phases as unknown[]).length).toBeGreaterThan(0);
    }
  });

  it('keeps the drift baseline aligned with descriptor files', () => {
    const baseline = readJson<{
      surfaces: Array<{ id: string; kind: string; path: string; scope: string }>;
    }>('src/data/instar-dev-surface-baseline.json');

    for (const descriptor of descriptors) {
      const baselineEntry = baseline.surfaces.find((surface) => surface.path === descriptor.relPath);
      expect(baselineEntry, `Missing baseline entry for ${descriptor.relPath}`).toBeDefined();
      expect(baselineEntry?.kind).toBe('workflow-descriptor');
      expect(baselineEntry?.scope).toBe(descriptor.scope);
    }
  });

  it('ships the developer-tools drift audit as an off-by-default built-in template', () => {
    const jobRelPath = 'src/scaffold/templates/jobs/instar/developer-tools-drift-audit.md';
    const job = fs.readFileSync(path.join(ROOT, jobRelPath), 'utf-8');

    expect(job).toMatch(/^enabled:\s*false$/m);
    expect(job).toContain('src/data/instar-dev-surface-baseline.json');
    expect(job).toContain('skills/*/workflow.descriptor.json');
  });
});
