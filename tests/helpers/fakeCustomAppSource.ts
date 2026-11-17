/**
 * In-memory CustomAppSource for the project-apps sandbox tests (docs/specs/project-apps-sandbox.md
 * §3.6-3.7). Storage (§3.2) and approvals (§3.3-3.4) are not built here: a test sets the served
 * version, the epoch and the data directly.
 */
import { createHash } from 'node:crypto';
import type { CustomAppSource, CustomAppMeta, ServedVersion, SourceWriteResult } from '../../src/server/ProjectAppSandbox.js';

interface FakeApp {
  meta: CustomAppMeta;
  served: ServedVersion;
  epoch: number;
  data: { body: unknown; revision: string | null };
  summary: unknown;
  writes: number;
}

export const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

export class FakeCustomAppSource implements CustomAppSource {
  readonly apps = new Map<string, FakeApp>();

  add(appId: string, html: string, meta: Partial<CustomAppMeta> = {}): string {
    const contentSha = sha(html);
    this.apps.set(appId, {
      meta: { title: 'Sales pipeline', project: 'Example: sales pipeline', conversationHref: '/dashboard/console/#/conversations/telegram%3A1', ...meta },
      served: { state: 'served', contentSha, html },
      epoch: 1,
      data: { body: null, revision: null },
      summary: null,
      writes: 0,
    });
    return contentSha;
  }

  /** A new served version bumps the epoch (§3.7). */
  serve(appId: string, html: string): string {
    const a = this.must(appId);
    const contentSha = sha(html);
    a.served = { state: 'served', contentSha, html };
    a.epoch += 1;
    return contentSha;
  }

  disable(appId: string): void { const a = this.must(appId); a.served = { state: 'disabled' }; a.epoch += 1; }
  bumpEpoch(appId: string): void { this.must(appId).epoch += 1; }

  meta(appId: string): CustomAppMeta | null { return this.apps.get(appId)?.meta ?? null; }
  servedVersion(appId: string): ServedVersion { return this.apps.get(appId)?.served ?? { state: 'none' }; }
  epoch(appId: string): number { return this.apps.get(appId)?.epoch ?? 0; }
  readData(appId: string): { body: unknown; revision: string | null } { return this.must(appId).data; }
  writeData(appId: string, body: unknown, base: string | null): SourceWriteResult {
    const a = this.must(appId);
    if (a.data.revision !== base) return { ok: false, status: 409, error: 'conflict', current: a.data.revision };
    a.writes += 1;
    a.data = { body, revision: `rev:${appId}:${a.writes}` };
    return { ok: true, revision: a.data.revision! };
  }
  readSummary(appId: string): unknown { return this.must(appId).summary; }
  writeSummary(appId: string, body: unknown): SourceWriteResult { this.must(appId).summary = body; return { ok: true }; }

  private must(appId: string): FakeApp {
    const a = this.apps.get(appId);
    if (!a) throw new Error(`no app ${appId}`);
    return a;
  }
}
