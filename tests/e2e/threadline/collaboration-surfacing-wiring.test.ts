/**
 * Wiring-integrity / feature-alive test — CMT-509 collaboration surfacing.
 *
 * Guards against the dead-code failure mode: the CollaborationSurfacer must be
 * CONSTRUCTED at boot and INVOKED at BOTH inbound seams (the relay funnel and the
 * local /messages/relay-agent route), and the §1 commitment-resolution guard must
 * be present. Proven against the real source.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CollaborationSurfacer } from '../../../src/threadline/CollaborationSurfacer.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), 'utf-8');
const serverSrc = read('../../../src/commands/server.ts');
const routesSrc = read('../../../src/server/routes.ts');
const handlerSrc = read('../../../src/threadline/TopicLinkageHandler.ts');

describe('CMT-509 collaboration surfacing — wiring integrity', () => {
  it('constructs CollaborationSurfacer at boot (guarded on telegram)', () => {
    expect(serverSrc).toMatch(/import\s*\{\s*CollaborationSurfacer\s*\}\s*from\s*['"]\.\.\/threadline\/CollaborationSurfacer\.js['"]/);
    expect(serverSrc).toMatch(/new CollaborationSurfacer\(\{\s*telegram/);
  });

  it('invokes the surfacer at the relay funnel seam (after the gate, parentless only)', () => {
    const idx = serverSrc.indexOf('collaborationSurfacer.surface({');
    expect(idx).toBeGreaterThan(0);
    const block = serverSrc.slice(idx, idx + 400);
    expect(block).toMatch(/hasParentTopic/);
    expect(block).toMatch(/warrants:/);
  });

  it('invokes the surfacer at the local /messages/relay-agent seam', () => {
    const relayAgentIdx = routesSrc.indexOf("router.post('/messages/relay-agent'");
    const surfaceIdx = routesSrc.indexOf('ctx.collaborationSurfacer.surface({');
    expect(surfaceIdx).toBeGreaterThan(relayAgentIdx);
    expect(relayAgentIdx).toBeGreaterThan(0);
  });

  it('§1: commitment resolution is gated on a user-facing surface', () => {
    // The deliver() call must be behind the surfacedToUser guard, not raw mode.
    expect(handlerSrc).toMatch(/const surfacedToUser\s*=/);
    const guardIdx = handlerSrc.indexOf('if (commitment && surfacedToUser)');
    expect(guardIdx).toBeGreaterThan(0);
    expect(handlerSrc.slice(guardIdx, guardIdx + 200)).toMatch(/commitmentTracker\.deliver/);
  });

  it('surfacer operates end-to-end (not just present in source)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'surf-alive-'));
    try {
      const posts: string[] = [];
      const s = new CollaborationSurfacer({
        stateDir: tmp,
        telegram: {
          async findOrCreateForumTopic(name: string) { return { topicId: 42, name, reused: false }; },
          async sendToTopic(_t: number, text: string) { posts.push(text); return {}; },
        },
      });
      const r = await s.surface({ threadId: 'x', senderName: 'codey', text: 'hello', hasParentTopic: false, warrants: true });
      expect(r.surfaced).toBe(true);
      expect(posts).toHaveLength(1);
    } finally {
      SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/e2e/threadline/collaboration-surfacing-wiring.test.ts:cleanup' });
    }
  });
});
