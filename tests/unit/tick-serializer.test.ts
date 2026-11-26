import { describe, expect, it } from 'vitest';
import { TickSerializer } from '../../src/core/TickSerializer.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('TickSerializer', () => {
  it('runs a single evaluation directly', async () => {
    const serializer = new TickSerializer<number>();
    await expect(serializer.run(async () => 7)).resolves.toBe(7);
  });

  it('gives an overlapping caller a fresh evaluation that starts after the in-flight one finishes', async () => {
    const serializer = new TickSerializer<number>();
    const gate = deferred();
    const order: string[] = [];
    let evaluations = 0;
    const first = serializer.run(async () => { order.push('first-start'); await gate.promise; order.push('first-end'); return ++evaluations; });
    const second = serializer.run(async () => { order.push('second-start'); return ++evaluations; });
    await Promise.resolve();
    expect(order).toEqual(['first-start']);
    gate.resolve();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('coalesces callers that arrive while an evaluation is already queued (bounded to one running + one queued)', async () => {
    const serializer = new TickSerializer<number>();
    const gate = deferred();
    let evaluations = 0;
    const first = serializer.run(async () => { await gate.promise; return ++evaluations; });
    const second = serializer.run(async () => ++evaluations);
    const third = serializer.run(async () => ++evaluations);
    expect(third).toBe(second);
    gate.resolve();
    await first;
    await expect(Promise.all([second, third])).resolves.toEqual([2, 2]);
    expect(evaluations).toBe(2);
  });

  it('does not propagate an in-flight failure to the queued caller, and recovers for later calls', async () => {
    const serializer = new TickSerializer<string>();
    const gate = deferred();
    const first = serializer.run(async () => { await gate.promise; throw new Error('boom'); });
    const second = serializer.run(async () => 'ok');
    gate.resolve();
    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe('ok');
    await expect(serializer.run(async () => 'later')).resolves.toBe('later');
  });

  it('treats a synchronous throw from the evaluator as a rejected evaluation without wedging', async () => {
    const serializer = new TickSerializer<string>();
    await expect(serializer.run(() => { throw new Error('sync'); })).rejects.toThrow('sync');
    await expect(serializer.run(async () => 'after')).resolves.toBe('after');
  });
});
