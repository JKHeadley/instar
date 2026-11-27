/**
 * docs/specs/cos-owner-decision-delivery.md: the protected `owner-decision` category.
 * An offer only the owner can answer (Chief of Staff note and pause ask, machine enrolment) is a
 * decision, not a report: Quiet by Default delivers it, while an ordinary automated report stays quiet.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NotificationSelectivityGate } from '../../src/messaging/NotificationSelectivityGate.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { notificationStamper, withNotificationEnvelope } from '../../src/messaging/notificationStampers.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { CONVERSATION_CATEGORIES, PROTECTED_DELIVERY_CATEGORIES, categoryForProducer, isNotificationCategory } from '../../src/messaging/notificationCategories.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanup.splice(0)) await c(); vi.unstubAllGlobals(); });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-decision-'));
  const gate = new NotificationSelectivityGate(root, 'machine-a', () => ({ enabled: true, dryRun: false }));
  cleanup.push(async () => { await gate.close(); SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/notification-owner-decision-category.test.ts' }); });
  return { root, gate };
}

describe('owner-decision category', () => {
  it('is registered and protected, is not a conversation category, and no producer maps to it', () => {
    expect(isNotificationCategory('owner-decision')).toBe(true);
    expect(PROTECTED_DELIVERY_CATEGORIES.has('owner-decision')).toBe(true);
    expect(CONVERSATION_CATEGORIES.has('owner-decision')).toBe(false);
    for (const producer of ['owner-decision', 'owner-decision-offer', 'chief-of-staff', 'telegram-server']) {
      expect(categoryForProducer(producer)).not.toBe('owner-decision');
      expect(categoryForProducer(producer, 'some-job')).not.toBe('owner-decision');
    }
  });

  it('delivers an owner decision while an uncategorized report on the same topic stays quiet', () => {
    const { gate } = setup();
    expect(gate.decide(141385, { origin: 'automated', category: 'uncategorized', sourceContext: 'telegram-server' })).toMatchObject({ decision: 'record', reason: 'quiet-default' });
    expect(gate.decide(141385, { origin: 'automated', category: 'owner-decision', sourceContext: 'owner-decision-offer' })).toMatchObject({ decision: 'deliver', reason: 'owner-decision' });
  });

  it('the profile confirmation producer gets bounded owner-decision delivery without reply authority', () => {
    const { gate } = setup();
    const envelope = notificationStamper('src/server/routes.ts', 'profile-confirmation')();
    expect(envelope).toMatchObject({ origin: 'automated', category: 'owner-decision' });
    expect(gate.decide(42, envelope)).toMatchObject({ decision: 'deliver', reason: 'owner-decision' });
    expect(() => notificationStamper('src/commands/server.ts', 'profile-confirmation')).toThrow('Unregistered');
  });

  it('caps a looping sender at 10 decisions per topic per 10 minutes, per topic', () => {
    const { gate } = setup();
    const env = { origin: 'automated' as const, category: 'owner-decision' as const, sourceContext: 'owner-decision-offer' };
    for (let i = 0; i < 10; i++) expect(gate.decide(7, env).decision).toBe('deliver');
    expect(gate.decide(7, env)).toMatchObject({ decision: 'record', reason: 'owner-decision-budget' });
    expect(gate.decide(8, env).decision).toBe('deliver');
  });

  it('is not operator-configurable and never redirected to a push destination', () => {
    const { gate } = setup();
    gate.pushDestination = () => ({ chatId: 'c', topicId: 1 });
    expect(gate.destination({ origin: 'automated', category: 'owner-decision', sourceContext: 'x' } as never, 42)).toBeNull();
    const status = gate.status() as { categories: Array<{ id: string; configurable: boolean }> };
    expect(status.categories.find((c) => c.id === 'owner-decision')?.configurable).toBe(false);
  });
});

describe('TelegramAdapter.sendOfferList under Quiet by Default (enforcing)', () => {
  function adapter(root: string, gate: NotificationSelectivityGate) {
    const a = new TelegramAdapter({ token: '123:test', chatId: '-1001' }, root, { suppressLifelineAutoCreate: true });
    a.selectivity = gate;
    return a;
  }

  it('delivers an unstamped offer with buttons, while a plain automated send is still recorded quiet', async () => {
    const { root, gate } = setup();
    const a = adapter(root, gate);
    const wire = vi.fn(async (_url: string, _options?: RequestInit) => new Response(JSON.stringify({ ok: true, result: { message_id: 77 } })));
    vi.stubGlobal('fetch', wire);
    const id = await a.sendOfferList(141385, 'Instar 2.0: you wrote on 2026-11-13: "lets pause …"', [{ text: 'Pause: Instar 2.0', data: 'cos:p:0123456789abcdef' }]);
    expect(id).toBe(77);
    expect(wire).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(wire.mock.calls[0][1]?.body));
    expect(body.reply_markup.inline_keyboard[0][0].callback_data).toBe('cos:p:0123456789abcdef');
    expect(await a.sendToTopic(141385, 'Routine automated report')).toMatchObject({ recorded: true });
    expect(wire).toHaveBeenCalledTimes(1);
  });

  it('keeps a caller-stamped envelope instead of upgrading it to an owner decision', async () => {
    const { root, gate } = setup();
    const a = adapter(root, gate);
    const wire = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 5 } })));
    vi.stubGlobal('fetch', wire);
    const id = await withNotificationEnvelope({ origin: 'automated', category: 'uncategorized', sourceContext: 'recommended-services' },
      () => a.sendOfferList(42, 'Services you might want', [{ text: 'Yes', data: 'svc:yes' }]));
    expect(id).toBeNull();
    expect(wire).not.toHaveBeenCalled();
  });
});
