import { describe, expect, it } from 'vitest';
import { verifiedChannelIdentity, verifiedEntityName } from '../../src/messaging/shared/channelIdentity.js';

describe('verified channel identity', () => {
  it('keeps a real name bound to its platform ID', () => {
    expect(verifiedChannelIdentity('telegram', 127504, 'Instar dashboard makeover')).toEqual({ platform: 'telegram', id: '127504', name: 'Instar dashboard makeover' });
    expect(verifiedChannelIdentity('slack', 'C123', 'project-work')).toEqual({ platform: 'slack', id: 'C123', name: 'project-work' });
  });
  it('rejects generated placeholders and raw identifiers as names', () => {
    expect(verifiedChannelIdentity('telegram', 127504, 'topic-127504')).toBeNull();
    expect(verifiedChannelIdentity('telegram', 127504, 'topic 127504')).toBeNull();
    expect(verifiedChannelIdentity('telegram', 127504, 'Telegram topic 127504')).toBeNull();
    expect(verifiedChannelIdentity('telegram', 127504, '[deleted] topic-127504')).toBeNull();
    expect(verifiedChannelIdentity('telegram', 127504, '127504')).toBeNull();
    expect(verifiedChannelIdentity('telegram', 127504, '4821')).toBeNull();
    expect(verifiedChannelIdentity('slack', 'C123', 'C123 (thread 1.2)')).toBeNull();
    expect(verifiedChannelIdentity('slack', 'C123', '#C123')).toBeNull();
    expect(verifiedEntityName('m_123456789012', 'm_123456789012')).toBeNull();
    expect(verifiedEntityName('peer', '8c7928aa9f04fbda947172a2f9b2d81a')).toBeNull();
    expect(verifiedEntityName('peer', '8c7928aa')).toBeNull();
    expect(verifiedEntityName('peer', '8c7928aa…')).toBeNull();
    expect(verifiedEntityName('peer', '8c7928aa...')).toBeNull();
    expect(verifiedEntityName('peer', '8c7928aa-9f04-fbda-9471-72a2f9b2d81a')).toBeNull();
    expect(verifiedEntityName('peer', 'a2aproof-130200')).toBeNull();
    expect(verifiedEntityName('peer', 'Agent name unavailable')).toBeNull();
    expect(verifiedEntityName('peer', 'Unnamed agent')).toBeNull();
    expect(verifiedEntityName('peer', 'PP')).toBe('PP');
  });
});
