import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

describe('installed governing context lifecycle', () => {
  it('compiled production resolver receives both exact source documents and their metadata', async () => {
    const module = await import(pathToFileURL(path.join(process.cwd(), 'dist/core/standardsRegistryPath.js')).href);
    const context = module.resolveGoverningConstitution();
    expect(context.usable).toBe(true);
    const source = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src/data/constitution/sources.json'), 'utf8'));
    expect(context.source).toEqual(source);
    for (const file of ['purpose.md', 'rules.md', 'sources.json']) {
      expect(fs.readFileSync(path.join(process.cwd(), 'dist/data/constitution', file))).toEqual(fs.readFileSync(path.join(process.cwd(), 'src/data/constitution', file)));
    }
  });
});
