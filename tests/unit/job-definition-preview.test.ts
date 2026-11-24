import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { readLocalJobDefinitionPreview } from '../../src/scheduler/JobDefinitionPreview.js';
import { loadJobsDetailed } from '../../src/scheduler/JobLoader.js';

const fsHooks = vi.hoisted(() => ({
  failedRead: null as ((file: string) => boolean) | null,
  afterStat: null as ((file: string) => void) | null,
}));
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      if (fsHooks.failedRead?.(String(args[0]))) {
        handle.read = async () => { throw new Error('fixture read failed'); };
      }
      return handle;
    },
    lstat: async (...args: Parameters<typeof real.lstat>) => {
      try { return await real.lstat(...args); }
      finally { fsHooks.afterStat?.(String(args[0])); }
    },
  };
});

const roots: string[] = [];
const definition = (slug: string, schedule = '0 * * * *') => ({
  slug, schedule, name: 'private job label', description: 'private job description', enabled: true, priority: 'low',
  expectedDurationMinutes: 1, execute: { type: 'prompt', value: 'private prompt' },
});

async function fixture(rows: unknown[]) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'job-migration-preview-'));
  roots.push(root);
  const jobsFile = path.join(root, 'custom-catalog.json');
  await fs.writeFile(jobsFile, JSON.stringify(rows));
  const read = () => readLocalJobDefinitionPreview(jobsFile, new AbortController().signal);
  const schedules = path.join(root, 'jobs', 'schedule');
  const journal = path.join(root, 'state', 'job-portable-import-journal.json');
  return { root, jobsFile, read, schedules, journal };
}

afterEach(() => {
  fsHooks.failedRead = null;
  fsHooks.afterStat = null;
  for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'job-preview-test-cleanup' });
});

describe('local job definition preview evidence', () => {
  it('retains duplicate effective observations without resolving a mapping and emits only the fixed fields', async () => {
    const f = await fixture([definition('same'), definition('same', '30 * * * *'), { slug: 'invalid-secret' }]);
    const preview = await f.read();
    const effective = preview.rows.filter(row => row.disposition === 'loader-effective');
    expect(effective.map(row => row.slug)).toEqual(loadJobsDetailed(f.jobsFile, { quiet: true }).jobs.map(row => row.slug));
    expect(effective).toEqual(Array.from({ length: 2 }, () => ({
      source: 'legacy', disposition: 'loader-effective', slug: 'same', enabled: true, executor: 'prompt', ownership: 'unresolved', mapping: 'unresolved',
    })));
    expect(preview).toMatchObject({ scheduler: 'unknown', pool: 'unchecked' });
    expect(JSON.stringify(preview)).not.toMatch(/private|invalid-secret|custom-catalog|30 \* \* \* \*/);
  });

  it('applies portable ownership without assuming a runnable manifest or falling back to legacy', async () => {
    const f = await fixture([definition('withheld'), definition('usable')]);
    await fs.mkdir(path.dirname(f.journal));
    await fs.writeFile(f.journal, JSON.stringify({ version: 1, jobs: { withheld: { state: 'pending' } } }));
    expect(loadJobsDetailed(f.jobsFile, { quiet: true }).jobs.map(row => row.slug)).toEqual(['usable']);
    expect((await f.read()).rows).toEqual([
      expect.objectContaining({ slug: 'usable', disposition: 'loader-effective' }),
      expect.objectContaining({ slug: 'withheld', disposition: 'suppressed', reason: 'portable-owned' }),
    ]);
    await fs.writeFile(f.journal, '{unreadable');
    expect(loadJobsDetailed(f.jobsFile, { quiet: true }).jobs).toEqual([]);
    expect((await f.read()).rows).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({ disposition: 'suppressed', reason: 'portable-invalid' })));
  });

  it('uses the manifest slug, keeps body and scheduler evidence unknown, and safely proves unrelated legacy rows', async () => {
    const f = await fixture([definition('prior'), definition('unrelated')]);
    await fs.mkdir(f.schedules, { recursive: true });
    await fs.writeFile(path.join(f.schedules, 'different-file.json'), JSON.stringify({
      ...definition('prior'), enabled: false, origin: 'user', execute: { type: 'agentmd' },
    }));
    const loaded = loadJobsDetailed(f.jobsFile, { quiet: true }).jobs;
    expect(loaded.find(row => row.slug === 'prior')?.enabled).toBe(false);
    const preview = await f.read();
    expect(preview.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: 'prior', source: 'manifest', disposition: 'unknown', executor: 'agentmd' }),
      expect.objectContaining({ slug: 'prior', source: 'legacy', disposition: 'unknown' }),
      expect.objectContaining({ slug: 'unrelated', source: 'legacy', disposition: 'loader-effective' }),
    ]));
  });

  it('caps returned observations and releases no partial result after cancellation', async () => {
    const f = await fixture(Array.from({ length: 251 }, (_unused, index) => definition(`job-${index}`)));
    const observed = await f.read();
    expect(observed.rows).toHaveLength(250);
    expect(observed.truncated).toBe(true);
    const cancelled = await readLocalJobDefinitionPreview(f.jobsFile, AbortSignal.abort());
    expect(cancelled).toMatchObject({
      rows: [], coverage: { legacy: 'unchecked', 'portable-journal': 'unchecked', 'manifest-inventory': 'unchecked' },
    });
  });

  it('charges failed reads against the aggregate budget before reaching the next large input', async () => {
    const f = await fixture([definition('prior')]);
    await fs.mkdir(f.schedules, { recursive: true });
    const attempted: string[] = [];
    for (let i = 0; i < 8; i++) {
      await fs.writeFile(path.join(f.schedules, `fail-${i}.json`), Buffer.alloc(1_048_576));
    }
    const later = 'next-large.json';
    const spec = JSON.stringify({ ...definition('pending'), origin: 'user' });
    await fs.writeFile(path.join(f.schedules, later), spec.padEnd(1_048_576));
    fsHooks.failedRead = file => {
      const name = path.basename(file);
      if (!name.startsWith('fail-') && name !== later) return false;
      attempted.push(name);
      return name.startsWith('fail-');
    };
    const preview = await f.read();
    // All candidate files were opened for size checks, but the final one must
    // remain unread. A successful parse of it would emit a manifest row.
    expect(attempted).toContain(later);
    expect(preview.rows).toEqual([expect.objectContaining({ slug: 'prior', disposition: 'unknown' })]);
    expect(preview.coverage['manifest-inventory']).toBe('unchecked');
  });

  it('discards projected rows when cancellation arrives during the final stability stat', async () => {
    const f = await fixture([definition('prior')]);
    const controller = new AbortController();
    let jobsDirectoryStats = 0;
    fsHooks.afterStat = file => {
      if (file === path.join(f.root, 'jobs') && ++jobsDirectoryStats === 2) controller.abort();
    };
    const preview = await readLocalJobDefinitionPreview(f.jobsFile, controller.signal);
    expect(jobsDirectoryStats).toBe(2);
    expect(preview).toMatchObject({
      rows: [], coverage: { legacy: 'unchecked', 'portable-journal': 'unchecked', 'manifest-inventory': 'unchecked' },
    });
  });

  it('withholds selected claims on unread, oversized or symlinked inputs', async () => {
    const f = await fixture([definition('prior')]);
    await fs.mkdir(f.schedules, { recursive: true });
    const target = path.join(f.root, 'sensitive.json');
    await fs.writeFile(target, 'private file bytes');
    const suspect = path.join(f.schedules, 'could-override.json');
    await fs.symlink(target, suspect);
    expect((await f.read()).rows).toEqual([expect.objectContaining({ disposition: 'unknown', reason: 'incomplete' })]);
    const oversized = await fixture([definition('prior')]);
    await fs.mkdir(oversized.schedules, { recursive: true });
    await fs.writeFile(path.join(oversized.schedules, 'could-override.json'), Buffer.alloc(1_048_577));
    expect((await oversized.read()).rows).toEqual([expect.objectContaining({ disposition: 'unknown', reason: 'incomplete' })]);
  });
});
