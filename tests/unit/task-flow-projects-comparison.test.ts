import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { InitiativeTracker, INITIATIVE_TASKFLOW_CONTROLLER_ID } from '../../src/core/InitiativeTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TaskFlowRegistry } from '../../src/tasks/TaskFlowRegistry.js';
import { TaskFlowStore } from '../../src/tasks/task-flow-registry.store.sqlite.js';
import { createTaskFlowProjectsComparisonSource } from '../../src/tasks/taskFlowProjectsComparison.js';

const homes: string[] = [];
const stores: TaskFlowStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const home of homes.splice(0)) {
    SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'projects-comparison-fixture-cleanup' });
  }
});

async function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-projects-comparison-'));
  homes.push(home);
  const databasePath = path.join(home, 'task-flows.db');
  const store = new TaskFlowStore({ dbPath: databasePath });
  stores.push(store);
  await store.open();
  const tracker = new InitiativeTracker(home);
  const registry = new TaskFlowRegistry({ store });
  tracker.setTaskFlowRegistry(registry, 'project-comparison-owner');
  const makeItem = (id: string, title: string, kind: 'project' | 'task' = 'project') =>
    tracker.create({ id, title, kind, description: 'Private description', phases: [{ id: 'start', name: 'Start' }] });
  const compiled = ts.transpileModule(fs.readFileSync(fileURLToPath(
    new URL('../../src/tasks/taskFlowProjectsComparison.worker.ts', import.meta.url)), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  });
  const workerPath = path.join(home, 'comparison.worker.mjs');
  fs.writeFileSync(workerPath, compiled.outputText);
  let ownerCurrent = true;
  // This disposable database and its controller share one verified local
  // owner and a single writer. A production shared catalog cannot assume
  // that changes to a raw database revision are audience independent.
  const proveAuthority = () => tracker.proveWholeTaskFlowProjectsComparison(() => ownerCurrent);
  const source = createTaskFlowProjectsComparisonSource({ proveAuthority, workerUrl: pathToFileURL(workerPath) });
  return { home, store, registry, tracker, source, makeItem, databasePath, revoke: () => { ownerCurrent = false; } };
}

describe('TaskFlow Projects comparison source', () => {
  it('projects the two current project memberships from the real TaskFlow writer without changing durable bytes', async () => {
    const f = await fixture();
    await f.makeItem('active', 'Active Project');
    await f.makeItem('terminal', 'Finished Project');
    await f.tracker.update('terminal', { status: 'completed' });
    await f.makeItem('removed', 'Removed Project');
    expect(await f.tracker.remove('removed')).toBe(true);
    await f.makeItem('task', 'A Task', 'task');
    expect(f.tracker.list({ kind: 'project' }).map(item => item.id).sort()).toEqual(['active', 'terminal']);
    const files = fs.readdirSync(f.home).sort();
    const main = fs.readFileSync(f.databasePath);
    const wal = fs.readFileSync(f.databasePath + '-wal');

    const result = await f.source.read(new AbortController().signal);
    expect(result?.snapshot).toMatchObject({ coverage: 'complete', relationsComplete: false });
    expect(result?.snapshot.items.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'active', title: 'Active Project' },
      { id: 'terminal', title: 'Finished Project' },
    ]);
    expect(result?.release()).toBe(true);
    expect(fs.readdirSync(f.home).sort()).toEqual(files);
    expect(fs.readFileSync(f.databasePath)).toEqual(main);
    expect(fs.readFileSync(f.databasePath + '-wal')).toEqual(wal);

    await f.tracker.update('active', { title: 'Later title' });
    expect(result?.release()).toBe(false);
  });

  it('declines without owner proof, refuses a revoked release and declines after the native store closes', async () => {
    const f = await fixture();
    await f.makeItem('active', 'One project');
    const signal = new AbortController().signal;
    const result = await f.source.read(signal);
    expect(result?.release()).toBe(true);
    f.revoke();
    expect(result?.release()).toBe(false);
    expect(await f.source.read(signal)).toBeNull();

    const neverProve = vi.fn(() => null);
    const unproven = createTaskFlowProjectsComparisonSource({ proveAuthority: neverProve });
    expect(await unproven.read(signal)).toBeNull();
    const aborted = new AbortController();
    aborted.abort();
    expect(await unproven.read(aborted.signal)).toBeNull();
    expect(neverProve).toHaveBeenCalledTimes(1);

    f.store.close();
    const missingSidecars = createTaskFlowProjectsComparisonSource({
      proveAuthority: () => ({ databasePath: f.databasePath, isCurrent: () => true }),
      workerUrl: pathToFileURL(path.join(f.home, 'comparison.worker.mjs')),
    });
    expect(await missingSidecars.read(signal)).toBeNull();
  });
  it('withholds the entire projection on an incompatible native privacy scope and cancels a worker without a result', async () => {
    const f = await fixture();
    await f.makeItem('visible', 'Visible project');
    await f.registry.createFlow({
      controllerId: INITIATIVE_TASKFLOW_CONTROLLER_ID,
      controllerInstanceId: 'project-comparison-owner',
      ownerKey: 'initiative:private',
      goal: 'Restricted record',
      idempotencyKey: 'fixture-private',
      stateJson: { initiative: { id: 'private', kind: 'project', title: 'Restricted project title' } },
      privacyScope: 'shared-topic',
    });
    expect(await f.source.read(new AbortController().signal)).toBeNull();

    const abort = new AbortController();
    const pending = f.source.read(abort.signal);
    abort.abort();
    expect(await pending).toBeNull();
  });

});
