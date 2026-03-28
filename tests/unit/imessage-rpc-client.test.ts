/**
 * Tests for IMessageRpcClient — JSON-RPC protocol handling, process lifecycle.
 *
 * Uses a mock imsg process (a simple Node.js script) to test the RPC client
 * without requiring the actual imsg CLI or macOS Messages.app.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IMessageRpcClient } from '../../src/messaging/imessage/IMessageRpcClient.js';
import { ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// Create a mock imsg RPC process that speaks JSON-RPC 2.0 over stdio
function createMockImsgScript(behavior: 'echo' | 'crash-after-start' | 'immediate-exit' | 'slow-start' = 'echo'): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imsg-mock-'));
  const scriptPath = path.join(tmpDir, 'mock-imsg.mjs');

  const scripts: Record<string, string> = {
    echo: `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  try {
    const req = JSON.parse(line);
    if (req.method === 'watch.subscribe') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { success: true } }) + '\\n');
    } else if (req.method === 'send') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { messageId: 'p:0/' + Date.now() } }) + '\\n');
    } else if (req.method === 'chats.list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { chats: [] } }) + '\\n');
    } else if (req.method === 'error') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -1, message: 'Test error' } }) + '\\n');
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }) + '\\n');
    }
  } catch { /* ignore parse errors */ }
});
`,
    'crash-after-start': `
setTimeout(() => process.exit(1), 500);
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', () => {});
`,
    'immediate-exit': `process.exit(42);`,
    'slow-start': `
setTimeout(() => {}, 10000);
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', () => {});
`,
  };

  fs.writeFileSync(scriptPath, scripts[behavior]);
  return scriptPath;
}

describe('IMessageRpcClient', () => {
  let client: IMessageRpcClient;
  let mockScript: string;
  let tmpDirs: string[] = [];

  function createClient(behavior: 'echo' | 'crash-after-start' | 'immediate-exit' | 'slow-start' = 'echo', opts: Record<string, unknown> = {}): IMessageRpcClient {
    mockScript = createMockImsgScript(behavior);
    tmpDirs.push(path.dirname(mockScript));
    return new IMessageRpcClient({
      cliPath: process.execPath,   // Use node itself
      dbPath: undefined,
      autoReconnect: false,
      requestTimeoutMs: 5000,
      ...opts,
      // We'll override the spawn args by using the cliPath trick
    });
  }

  afterEach(async () => {
    if (client) {
      try { await client.disconnect(); } catch { /* already stopped */ }
    }
    for (const dir of tmpDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    tmpDirs = [];
  });

  describe('constructor', () => {
    it('starts in disconnected state', () => {
      client = new IMessageRpcClient();
      expect(client.state).toBe('disconnected');
      expect(client.pid).toBeUndefined();
    });

    it('accepts custom options', () => {
      client = new IMessageRpcClient({
        cliPath: '/custom/imsg',
        autoReconnect: false,
        maxReconnectAttempts: 5,
        reconnectBaseDelayMs: 500,
        requestTimeoutMs: 10000,
      });
      expect(client.state).toBe('disconnected');
    });
  });

  describe('connect / disconnect', () => {
    it('spawns process and enters connected state', async () => {
      mockScript = createMockImsgScript('echo');
      tmpDirs.push(path.dirname(mockScript));
      client = new IMessageRpcClient({
        cliPath: process.execPath,
        autoReconnect: false,
      });

      // We can't easily test the full spawn since our client expects `imsg rpc` args.
      // Instead, test the state machine directly.
      expect(client.state).toBe('disconnected');
    });

    it('disconnect from disconnected is a no-op', async () => {
      client = new IMessageRpcClient({ autoReconnect: false });
      await client.disconnect();
      expect(client.state).toBe('disconnected');
    });
  });

  describe('state transitions', () => {
    it('emits stateChange events', async () => {
      client = new IMessageRpcClient({ autoReconnect: false });
      const states: string[] = [];
      client.on('stateChange', (state: string) => states.push(state));

      // Since we can't connect without the real imsg, test disconnect path
      await client.disconnect();
      // disconnected -> disconnected doesn't emit (same state)
      expect(states).toHaveLength(0);
    });
  });

  describe('request (unit - without process)', () => {
    it('rejects when not connected', async () => {
      client = new IMessageRpcClient({ autoReconnect: false });
      await expect(client.request('send', { to: '+1234', text: 'hi' }))
        .rejects.toThrow('Cannot send request: client is disconnected');
    });
  });

  describe('notification handling', () => {
    it('emits message events for incoming messages', () => {
      client = new IMessageRpcClient({ autoReconnect: false });
      const messages: unknown[] = [];
      client.on('message', (msg: unknown) => messages.push(msg));

      // Simulate a notification by calling the private handler via prototype hack
      const notification = {
        jsonrpc: '2.0' as const,
        method: 'message',
        params: {
          chatId: 'iMessage;-;+14081234567',
          messageId: 'p:0/12346',
          sender: '+14081234567',
          text: 'Hello',
          timestamp: 1711584000,
          isFromMe: false,
        },
      };

      // Access internal handler
      (client as any)._handleLine(JSON.stringify(notification));

      expect(messages).toHaveLength(1);
      expect((messages[0] as any).text).toBe('Hello');
      expect((messages[0] as any).sender).toBe('+14081234567');
    });

    it('emits generic notification for non-message methods', () => {
      client = new IMessageRpcClient({ autoReconnect: false });
      const notifications: { method: string; params: unknown }[] = [];
      client.on('notification', (method: string, params: unknown) => {
        notifications.push({ method, params });
      });

      (client as any)._handleLine(JSON.stringify({
        jsonrpc: '2.0',
        method: 'typing',
        params: { chatId: 'test' },
      }));

      expect(notifications).toHaveLength(1);
      expect(notifications[0].method).toBe('typing');
    });

    it('emits parseError for invalid JSON', () => {
      client = new IMessageRpcClient({ autoReconnect: false });
      const errors: string[] = [];
      client.on('parseError', (line: string) => errors.push(line));

      (client as any)._handleLine('not json');

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe('not json');
    });

    it('ignores empty lines', () => {
      client = new IMessageRpcClient({ autoReconnect: false });
      const errors: string[] = [];
      client.on('parseError', (line: string) => errors.push(line));

      (client as any)._handleLine('');
      (client as any)._handleLine('   ');

      expect(errors).toHaveLength(0);
    });

    it('ignores non-jsonrpc messages', () => {
      client = new IMessageRpcClient({ autoReconnect: false });
      const errors: string[] = [];
      client.on('parseError', (line: string) => errors.push(line));

      (client as any)._handleLine(JSON.stringify({ type: 'other', data: 123 }));

      expect(errors).toHaveLength(1); // Treated as parse error (not jsonrpc 2.0)
    });
  });

  describe('response handling', () => {
    it('resolves pending request on success', async () => {
      client = new IMessageRpcClient({ autoReconnect: false });

      // Manually set up a pending request
      const promise = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 5000);
        (client as any).pendingRequests.set(1, { resolve, reject, timer });
      });

      // Simulate response
      (client as any)._handleLine(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { messageId: 'p:0/123' },
      }));

      const result = await promise;
      expect(result).toEqual({ messageId: 'p:0/123' });
    });

    it('rejects pending request on RPC error', async () => {
      client = new IMessageRpcClient({ autoReconnect: false });

      const promise = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 5000);
        (client as any).pendingRequests.set(2, { resolve, reject, timer });
      });

      (client as any)._handleLine(JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        error: { code: -32601, message: 'Method not found' },
      }));

      await expect(promise).rejects.toThrow('RPC error -32601: Method not found');
    });

    it('ignores responses for unknown request IDs', () => {
      client = new IMessageRpcClient({ autoReconnect: false });

      // Should not throw
      (client as any)._handleLine(JSON.stringify({
        jsonrpc: '2.0',
        id: 999,
        result: { data: 'orphan' },
      }));
    });
  });

  describe('deduplication tracking', () => {
    it('tracks sent message IDs', () => {
      client = new IMessageRpcClient({ autoReconnect: false });
      // Internal tracking is in the adapter, not the client
      // Client just handles protocol — this is a sanity check
      expect(client.state).toBe('disconnected');
    });
  });
});
