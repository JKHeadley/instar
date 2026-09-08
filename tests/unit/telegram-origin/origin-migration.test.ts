import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { migrateTelegramOriginDisplay, originOutageNoticeEnabled, originDetectorCanaryInterval } from '../../../src/messaging/telegram-origin/OriginConfig.js';
import { telegramOriginAwareness } from '../../../src/messaging/telegram-origin/OriginAwareness.js';
import { generateClaudeMd } from '../../../src/scaffold/templates.js';
import { resolveOriginDisplay } from '../../../src/messaging/telegram-origin/OriginPresentation.js';

describe('Telegram origin installation parity', () => {
  it('adds every default without overwriting explicit hidden-field choices and is idempotent', () => {
    const config = { messaging: [{ type: 'telegram', config: { messageOrigin: { display: { enabled: false, model: false } } } },
      { type: 'slack', config: {} }] };
    expect(migrateTelegramOriginDisplay(config)).toBe(true);
    expect(config.messaging[0].config.messageOrigin?.display).toEqual({ enabled: false, machine: true, harness: true, model: false });
    expect(config.messaging[1].config).toEqual({});
    expect(migrateTelegramOriginDisplay(config)).toBe(false);
  });
  it('fresh effective defaults equal migration defaults without adding an audit-off switch', () => {
    const config = { messaging: [{ type: 'telegram', config: {} as Record<string, unknown> }] };
    migrateTelegramOriginDisplay(config);
    const origin = config.messaging[0].config.messageOrigin as { display: Record<string, boolean> };
    expect(origin.display).toEqual({ enabled: true, machine: true, harness: true, model: true });
    expect(resolveOriginDisplay()).toMatchObject(origin.display);
    expect(Object.keys(origin).sort()).toEqual(['detectorCanary', 'display', 'outageNotice']);
    expect(originOutageNoticeEnabled(origin)).toBe(true);
    expect(originOutageNoticeEnabled(undefined)).toBe(true);
  });
  it('migrates the required hourly canary without overwriting a valid chosen interval', () => {
    const config = { messaging: [{ type: 'telegram', config: { messageOrigin: { detectorCanary: { intervalMs: 60_000 } } } }] };
    migrateTelegramOriginDisplay(config);
    expect(originDetectorCanaryInterval(config.messaging[0].config.messageOrigin)).toBe(60_000);
    expect(originDetectorCanaryInterval(undefined)).toBe(3_600_000);
    expect(migrateTelegramOriginDisplay(config)).toBe(false);
  });
  it.each([0, 59_999, 604_800_001, -1, '3600000', null, Infinity])('rejects invalid canary interval %s', intervalMs => {
    expect(() => originDetectorCanaryInterval({ detectorCanary: { intervalMs } })).toThrow();
  });
  it('does not accept a disabling switch', () => {
    expect(() => originDetectorCanaryInterval({ detectorCanary: { enabled: false } })).toThrow();
  });
  it('preserves an explicit outage-notice opt-out across migration', () => {
    const config = { messaging: [{ type: 'telegram', config: { messageOrigin: { outageNotice: { enabled: false } } } }] };
    expect(migrateTelegramOriginDisplay(config)).toBe(true);
    expect(originOutageNoticeEnabled(config.messaging[0].config.messageOrigin)).toBe(false);
    expect(migrateTelegramOriginDisplay(config)).toBe(false);
  });
  it('the fresh template contains the same awareness section as the migrator', () => {
    expect(generateClaudeMd('echo', 'Echo', 4042, true)).toContain(telegramOriginAwareness(4042));
    const migrator = readFileSync('src/core/PostUpdateMigrator.ts', 'utf8');
    expect(migrator).toContain('content += telegramOriginAwareness(port)');
    expect(migrator).toContain('migrateTelegramOriginDisplay(config)');
  });
  it('the installed script forwards exactly the credential name emitted by session startup', () => {
    const script = readFileSync('src/templates/scripts/telegram-reply.sh', 'utf8');
    expect(script).toContain('X-Instar-Origin-Session: ${INSTAR_ORIGIN_TOKEN}');
    expect(readFileSync('src/core/SessionManager.ts', 'utf8')).toContain('INSTAR_ORIGIN_TOKEN=${token}');
  });
});
