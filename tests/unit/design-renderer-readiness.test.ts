import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { assertLoadedBundledFonts, observeRendererErrors, finalizeRendererReadiness } from '../design/harness/rendererReadiness.mjs';

describe('renderer readiness requires measured font and error facts', () => {
  it('rejects fallback-only successful font checks without matching loaded faces', () => {
    expect(() => assertLoadedBundledFonts({ inter: true, mono: true, faces: [] })).toThrow();
    expect(() => assertLoadedBundledFonts({ inter: true, mono: true, faces: [
      { family: 'Inter', status: 'loaded' }, { family: 'JetBrains Mono', status: 'unloaded' },
    ] })).toThrow();
    expect(() => assertLoadedBundledFonts({ inter: true, mono: true, faces: [
      { family: 'Inter fallback', status: 'loaded' }, { family: 'JetBrains Mono', status: 'loaded' },
    ] })).toThrow();
  });
  it('accepts the actual matching loaded family names with or without CSS quoting', () => {
    expect(() => assertLoadedBundledFonts({ inter: true, mono: true, faces: [
      { family: '"Inter"', status: 'loaded' }, { family: 'JetBrains Mono', status: 'loaded' },
    ] })).not.toThrow();
  });
  it('downgrades a capture when a response job emits console.error after its preliminary success', async () => {
    const page = new EventEmitter(), failures: unknown[] = [];
    observeRendererErrors(page, failures);
    const manifest = { status: 'measured' };
    const jobs = [Promise.resolve().then(() => {
      page.emit('console', { type: () => 'error', text: () => 'Late renderer failure' });
    })];
    await finalizeRendererReadiness(manifest, failures, jobs);
    expect(manifest).toMatchObject({ status: 'unavailable', pageFailures: [{ kind: 'console-error', message: 'Late renderer failure' }] });
  });
  it('preserves errors emitted during close and drains jobs appended by another job', async () => {
    const page = new EventEmitter(), failures: unknown[] = [];
    observeRendererErrors(page, failures);
    const manifest = { status: 'measured' };
    const jobs: Promise<unknown>[] = [];
    jobs.push(Promise.resolve().then(() => {
      jobs.push(Promise.resolve().then(() => page.emit('pageerror', new Error('Error during close'))));
    }));
    await finalizeRendererReadiness(manifest, failures, jobs);
    expect(manifest).toMatchObject({ status: 'unavailable', pageFailures: [{ kind: 'page-error', message: 'Error during close' }] });
  });
  it('keeps warnings distinct and never upgrades a failed or unclosed run', async () => {
    const page = new EventEmitter(), failures: unknown[] = [];
    observeRendererErrors(page, failures);
    page.emit('console', { type: () => 'warning', text: () => 'Warning only' });
    const failed = { status: 'unavailable' };
    await finalizeRendererReadiness(failed, failures, []);
    expect(failed.status).toBe('unavailable');
    const unclosed = { status: 'measured', process: { aliveAfterClose: true } };
    await finalizeRendererReadiness(unclosed, failures, []);
    expect(unclosed.status).toBe('unavailable');
  });
});
