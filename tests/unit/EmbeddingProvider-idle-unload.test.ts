/**
 * Idle-unload lifecycle for the shared ONNX EmbeddingProvider.
 *
 * The loaded feature-extraction pipeline's onnxruntime thread pool busy-spins
 * even when no embedding is happening (measured live: ~3.6% of a core on a quiet
 * box, ~44% on a contended one). For a "paused" agent that isn't doing memory
 * work, that's pure wasted CPU — a real contributor to fleet load. These tests
 * pin the fix: after `idleUnloadMs` of no embed() the pipeline is disposed (its
 * thread pool freed), and the next embed() lazily reloads. A mock pipeline +
 * fake timers exercise the lifecycle without loading the 80MB model (the real
 * dispose→reload→identical-output behavior was verified live).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmbeddingProvider, ONNX_SESSION_OPTIONS } from '../../src/memory/EmbeddingProvider.js';

describe('ONNX_SESSION_OPTIONS (resident-spin cap, task #17)', () => {
  it('caps the ORT intra/inter-op thread pools to 1', () => {
    // Guards the fleet-wide idle-CPU fix: a resident embedding model with the
    // default (unbounded) ORT pool busy-spins ~6 extra threads. Runtime-verified
    // via a thread-count probe (resident pool 18→12, identical 384-dim output).
    expect(ONNX_SESSION_OPTIONS.intraOpNumThreads).toBe(1);
    expect(ONNX_SESSION_OPTIONS.interOpNumThreads).toBe(1);
  });
});

function makeMockPipeline() {
  const dispose = vi.fn().mockResolvedValue(undefined);
  const fn: any = vi.fn(async () => ({ data: new Float32Array(384) }));
  fn.dispose = dispose;
  return fn;
}

describe('EmbeddingProvider idle-unload', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('disposes the pipeline after idleUnloadMs of no embed, then lazily reloads', async () => {
    let created = 0;
    const pipes: any[] = [];
    const provider = new EmbeddingProvider({
      idleUnloadMs: 1000,
      pipelineFactory: async () => { created++; const p = makeMockPipeline(); pipes.push(p); return p; },
    });

    await provider.embed('hello');
    expect(created).toBe(1);
    expect(provider.isReady).toBe(true);

    // Idle window elapses → unload fires, thread pool freed.
    await vi.advanceTimersByTimeAsync(1001);
    expect(pipes[0].dispose).toHaveBeenCalledOnce();
    expect(provider.isReady).toBe(false);

    // Next embed reloads a fresh pipeline (lazy).
    const out = await provider.embed('again');
    expect(out).toBeInstanceOf(Float32Array);
    expect(created).toBe(2);
    expect(provider.isReady).toBe(true);
  });

  it('stays resident while embeds keep coming (timer resets each call)', async () => {
    let created = 0;
    const provider = new EmbeddingProvider({
      idleUnloadMs: 1000,
      pipelineFactory: async () => { created++; return makeMockPipeline(); },
    });
    await provider.embed('a');
    await vi.advanceTimersByTimeAsync(800); // < window
    await provider.embed('b');              // resets the timer
    await vi.advanceTimersByTimeAsync(800); // 800ms since last embed, < window
    expect(provider.isReady).toBe(true);
    expect(created).toBe(1); // never reloaded
  });

  it('idleUnloadMs:0 disables unloading (model stays resident forever)', async () => {
    const pipes: any[] = [];
    const provider = new EmbeddingProvider({
      idleUnloadMs: 0,
      pipelineFactory: async () => { const p = makeMockPipeline(); pipes.push(p); return p; },
    });
    await provider.embed('x');
    await vi.advanceTimersByTimeAsync(10_000_000);
    expect(provider.isReady).toBe(true);
    expect(pipes[0].dispose).not.toHaveBeenCalled();
  });

  it('never disposes while an embed is in flight (inFlight guard), then disposes once idle', async () => {
    // Flush enough microtask turns for the embed chain (inFlight++ →
    // initialize → loadModel → factory → pipe()) to reach the pipe() call.
    const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
    const dispose = vi.fn().mockResolvedValue(undefined);
    const resolvers: Array<(v: any) => void> = [];
    const pipe: any = vi.fn(() => new Promise((r) => { resolvers.push(r); }));
    pipe.dispose = dispose;
    const provider = new EmbeddingProvider({
      idleUnloadMs: 500,
      pipelineFactory: async () => pipe,
    });

    // First embed completes → arms the idle timer.
    const a = provider.embed('a');
    await flush();
    resolvers[0]({ data: new Float32Array(384) });
    await a;

    // Second embed is now in flight (hangs unresolved → inFlight = 1).
    const b = provider.embed('b');
    await flush();
    expect(resolvers).toHaveLength(2);
    // The timer armed by embed A fires while B is in flight → must NOT dispose.
    await vi.advanceTimersByTimeAsync(600);
    expect(dispose).not.toHaveBeenCalled();
    expect(provider.isReady).toBe(true);

    // Release B → it completes and re-arms the timer; now idle → dispose.
    resolvers[1]({ data: new Float32Array(384) });
    await b;
    await vi.advanceTimersByTimeAsync(600);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('explicit dispose() releases the model + cancels the idle timer', async () => {
    const pipes: any[] = [];
    const provider = new EmbeddingProvider({
      idleUnloadMs: 1000,
      pipelineFactory: async () => { const p = makeMockPipeline(); pipes.push(p); return p; },
    });
    await provider.embed('y');
    await provider.dispose();
    expect(pipes[0].dispose).toHaveBeenCalledOnce();
    expect(provider.isReady).toBe(false);
    // The idle timer was cancelled — advancing can't double-dispose.
    await vi.advanceTimersByTimeAsync(5000);
    expect(pipes[0].dispose).toHaveBeenCalledOnce();
  });
});
