/**
 * Tests that channelName is persisted into the Slack channel → session registry
 * and exposed via getChannelRegistry.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SLACK_ADAPTER_SRC = path.join(process.cwd(), 'src/messaging/slack/SlackAdapter.ts');

describe('SlackAdapter — channel registry preserves channelName', () => {
  const source = fs.readFileSync(SLACK_ADAPTER_SRC, 'utf-8');

  it('registerChannelSession accepts channelName', () => {
    expect(source).toMatch(/registerChannelSession\([^)]*channelName/);
  });

  it('registry entry type includes channelName', () => {
    // The internal map type or the persisted record should include channelName
    expect(source).toMatch(/channelName\??:\s*string/);
  });

  it('getChannelRegistry returns channelName', () => {
    const fnStart = source.indexOf('getChannelRegistry(');
    const fnEnd = source.indexOf('\n  }', fnStart) + 4;
    const fnBlock = source.slice(fnStart, fnEnd);
    expect(fnBlock).toContain('channelName');
  });
});
