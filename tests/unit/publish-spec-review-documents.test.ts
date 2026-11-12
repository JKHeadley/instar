import { afterEach, describe, expect, it, vi } from 'vitest';
import { createView } from '../../skills/spec-converge/scripts/publish-spec-review.mjs';

/**
 * Where documents serve, POST /view answers 409 documents-replace-views (instar-document-viewer
 * §3.9b). The spec-review publisher then makes the overview a document instead, so a design
 * handoff never dead-ends on the guarantee.
 */
describe('publish-spec-review createView', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; delete process.env.INSTAR_AUTH_TOKEN; });

  function stub(responses: Array<{ status: number; body: unknown }>) {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      const r = responses.shift()!;
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    return calls;
  }

  it('falls back to a document when pages are replaced', async () => {
    process.env.INSTAR_AUTH_TOKEN = 't';
    const calls = stub([
      { status: 409, body: { error: 'documents-replace-views', use: '/docs' } },
      { status: 201, body: { id: 'd1', url: 'https://agent.example.dev/docs/d1' } },
      { status: 200, body: { title: 'Spec — ELI16', markdown: '# Overview' } },
    ]);
    const out = await createView({ title: 'Spec — ELI16', markdown: '# Overview' });
    expect(out).toMatchObject({ tunnelUrl: 'https://agent.example.dev/docs/d1', kind: 'document' });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/view', '/docs', '/docs/d1/data']);
    expect(calls[1].body).toEqual({ title: 'Spec — ELI16', markdown: '# Overview' });
  });

  it('still uses a page where documents do not replace pages', async () => {
    process.env.INSTAR_AUTH_TOKEN = 't';
    stub([{ status: 201, body: { id: 'v1', tunnelUrl: 'https://agent.example.dev/view/v1?sig=x', localUrl: '/view/v1' } }]);
    expect((await createView({ title: 'T', markdown: 'M' })).tunnelUrl).toContain('/view/v1');
  });

  it('a document that does not read back is never sent', async () => {
    process.env.INSTAR_AUTH_TOKEN = 't';
    stub([
      { status: 409, body: { error: 'documents-replace-views' } },
      { status: 201, body: { id: 'd2', url: 'https://agent.example.dev/docs/d2' } },
      { status: 404, body: { error: 'unknown-document' } },
    ]);
    await expect(createView({ title: 'T', markdown: 'M' })).rejects.toThrow(/did not read back/);
  });

  it('a different 409 is reported, not swallowed', async () => {
    process.env.INSTAR_AUTH_TOKEN = 't';
    stub([{ status: 409, body: { error: 'something-else' } }]);
    await expect(createView({ title: 'T', markdown: 'M' })).rejects.toThrow(/409/);
  });
});
