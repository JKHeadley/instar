import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const template = path.resolve('src/templates/scripts/slack-reply.sh');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'slack-no-temp:test-cleanup' });
});

describe('Slack relay without temporary-file access', () => {
  for (const bound of [false, true]) {
    it(`sends exact JSON and credentials with regular file writes denied (${bound ? 'bound' : 'channel'} reply)`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-no-temp-'));
      dirs.push(dir);
      const message = 'Hello "owner"\\friend\nsecond line\n';
      // Transport only is replaced. Real Bash and Python must build the request
      // while macOS denies every file write, including Bash's here-string temp file.
      fs.writeFileSync(path.join(dir, 'curl'), `#!/usr/bin/env python3
import json,os,sys
args=sys.argv[1:]
body=json.loads(args[args.index('-d')+1])
assert body['text']==os.environ['EXPECTED_TEXT']+'\\n',repr(body)
assert 'Authorization: Bearer test-auth' in args
assert 'X-Instar-AgentId: privacy-test' in args
assert any(a.startswith('X-Instar-DeliveryId: ') for a in args)
if os.environ['BOUND']=='yes':
 assert body['conversationId']==-123
 assert 'X-Instar-Bind-Token: test-bind' in args
 assert any(a.endswith('/slack/session-reply') for a in args),args
else:
 assert any('/slack/reply/C1234567890' in a for a in args),args
print('{"ok":true}\\n200',end='')
`, { mode: 0o755 });
      const args = [template, ...(bound ? [] : ['C1234567890']), message];
      const mac = process.platform === 'darwin';
      const output = execFileSync(mac ? '/usr/bin/sandbox-exec' : '/bin/bash', mac
        ? ['-p', '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))', '/bin/bash', ...args]
        : args, {
        cwd: dir, encoding: 'utf8', timeout: 15_000,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, EXPECTED_TEXT: message,
          BOUND: bound ? 'yes' : 'no', INSTAR_PORT: '4198', INSTAR_SERVER_URL: 'http://127.0.0.1:4198',
          INSTAR_AUTH_TOKEN: 'test-auth', INSTAR_AGENT_ID: 'privacy-test', INSTAR_SESSION_NAME: '',
          INSTAR_CONVERSATION_ID: bound ? '-123' : '', INSTAR_BIND_TOKEN: bound ? 'test-bind' : '',
          INSTAR_ORIGIN_TOKEN: '', INSTAR_DELIVERY_ID: '',
        },
      });
      expect(output).toContain('Sent');
    });
  }
});
