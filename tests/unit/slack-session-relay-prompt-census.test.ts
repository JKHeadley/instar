import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const producers = [
  'src/commands/server.ts',
  'src/templates/hooks/slack-channel-context.sh',
  'src/templates/hooks/compaction-recovery.sh',
];

describe('Slack session relay prompt census', () => {
  it('uses only the neutral destination-free helper instruction', () => {
    for (const file of producers) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source, file).not.toContain('.claude/scripts/slack-reply.sh');
      for (const line of source.split('\n').filter(l => l.includes('slack-reply.sh'))) {
        if (line.includes('cat <<')) {
          expect(line, `${file}: ${line}`).toContain('.instar/scripts/slack-reply.sh');
          expect(line, `${file}: raw destination leaked`).not.toMatch(/slack-reply\.sh\s+\$?\{?(channel|reply|ch)/i);
        }
      }
    }
  });

  it('checks canonical relay readiness before initial and recovery spawn', () => {
    const server = fs.readFileSync('src/commands/server.ts', 'utf8');
    expect(server.match(/localSlackRelayReadiness\(config\.stateDir\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(server).toContain('slack-relay-not-ready');
  });

  it('keeps existing-session injection ahead of readiness and isolates Slack DMs', () => {
    const server = fs.readFileSync('src/commands/server.ts', 'utf8');
    const inject = server.indexOf('const existingSession = slackAdapter!.getSessionForChannel(routingKey)');
    const readiness = server.indexOf('const relayReadiness = localSlackRelayReadiness(config.stateDir)', inject);
    expect(inject).toBeGreaterThan(-1);
    expect(readiness).toBeGreaterThan(inject);
    expect(server).not.toContain("(isDM && !isThreadSession) ? 'lifeline'");
    expect(server).toContain('Slack DMs are isolated 1:1 bound sessions too');
  });
});
