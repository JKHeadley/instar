/**
 * Unit tests for the throwaway-identity helper (scripts/lib/throwaway-identity.mjs).
 * Fully hermetic: HTTP is injected via a fake fetch, the clock + sleep are injected,
 * so no network and no real timers. Covers the pure extractors + the mail.tm flow
 * (mint, poll-until-match, timeout).
 */
import { describe, it, expect } from 'vitest';
import {
  extractCode,
  extractLink,
  matchMessage,
  createInbox,
  listMessages,
  waitForMessage,
} from '../../scripts/lib/throwaway-identity.mjs';

function res(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

describe('extractCode', () => {
  it('pulls a 6-digit code', () => {
    expect(extractCode('Your Slack confirmation code is 482913. Enter it.')).toBe('482913');
  });
  it('honors a custom pattern', () => {
    expect(extractCode('code: ABC-7Y', { pattern: /code:\s*([A-Z0-9-]+)/ })).toBe('ABC-7Y');
  });
  it('returns null when no match / non-string', () => {
    expect(extractCode('no digits here')).toBeNull();
    expect(extractCode(undefined as unknown as string)).toBeNull();
  });
});

describe('extractLink', () => {
  const body = 'Join here https://join.slack.com/t/abc/signup?x=1 or visit https://slack.com/help';
  it('returns the first URL by default', () => {
    expect(extractLink(body)).toBe('https://join.slack.com/t/abc/signup?x=1');
  });
  it('returns the URL matching a substring', () => {
    expect(extractLink(body, { match: 'help' })).toBe('https://slack.com/help');
  });
  it('returns the URL matching a regex', () => {
    expect(extractLink(body, { match: /\/t\/abc\// })).toBe('https://join.slack.com/t/abc/signup?x=1');
  });
  it('returns null when nothing matches', () => {
    expect(extractLink('no links', {})).toBeNull();
  });
});

describe('matchMessage', () => {
  const msg = { subject: 'Confirm your Slack email', from: { address: 'feedback@slack.com' } };
  it('matches on subject substring (case-insensitive) + from', () => {
    expect(matchMessage(msg, { subject: 'confirm', from: 'slack.com' })).toBe(true);
  });
  it('no filter → matches any message', () => {
    expect(matchMessage(msg)).toBe(true);
  });
  it('fails when a filter does not match', () => {
    expect(matchMessage(msg, { subject: 'invoice' })).toBe(false);
  });
});

describe('createInbox (injected fetch)', () => {
  it('picks an active domain, creates the account, returns the token', async () => {
    const calls: string[] = [];
    const fakeFetch = async (url: string, opts?: { method?: string }) => {
      calls.push(`${opts?.method || 'GET'} ${url}`);
      if (url.endsWith('/domains')) return res(200, { 'hydra:member': [{ domain: 'web-library.net', isActive: true }] });
      if (url.endsWith('/accounts')) return res(201, { id: 'acc_123', address: 'x@web-library.net' });
      if (url.endsWith('/token')) return res(200, { token: 'jwt-abc', id: 'acc_123' });
      throw new Error(`unexpected ${url}`);
    };
    const inbox = await createInbox({ fetchImpl: fakeFetch as unknown as typeof fetch, rand: () => 'fixed' });
    expect(inbox.address).toBe('echo-fixed@web-library.net');
    expect(inbox.token).toBe('jwt-abc');
    expect(inbox.accountId).toBe('acc_123');
    expect(calls).toEqual(['GET https://api.mail.tm/domains', 'POST https://api.mail.tm/accounts', 'POST https://api.mail.tm/token']);
  });

  it('throws a descriptive error on a mail.tm failure', async () => {
    const fakeFetch = async (url: string) => {
      if (url.endsWith('/domains')) return res(200, { 'hydra:member': [{ domain: 'd.net' }] });
      if (url.endsWith('/accounts')) return res(422, { 'hydra:description': 'address already used' });
      throw new Error('unexpected');
    };
    await expect(createInbox({ fetchImpl: fakeFetch as unknown as typeof fetch, rand: () => 'z' }))
      .rejects.toThrow(/422.*address already used/);
  });
});

describe('listMessages + waitForMessage (injected fetch + clock)', () => {
  it('returns the matching message body once it appears (polls)', async () => {
    let poll = 0;
    const fakeFetch = async (url: string) => {
      if (url.endsWith('/messages')) {
        poll++;
        // empty on first poll, the Slack message on the second
        return res(200, { 'hydra:member': poll < 2 ? [] : [{ id: 'm1', subject: 'Confirm your Slack email', from: { address: 'feedback@slack.com' } }] });
      }
      if (url.endsWith('/messages/m1')) return res(200, { id: 'm1', subject: 'Confirm your Slack email', text: 'code 992001' });
      throw new Error(`unexpected ${url}`);
    };
    let t = 0;
    const msg = await waitForMessage('jwt', {
      subject: 'confirm',
      fetchImpl: fakeFetch as unknown as typeof fetch,
      sleep: async () => { t += 3000; },
      now: () => t,
      intervalMs: 3000,
      timeoutMs: 60_000,
    });
    expect(msg.text).toContain('992001');
    expect(extractCode(msg.text)).toBe('992001');
    expect(poll).toBe(2);
  });

  it('throws on timeout when no message ever matches', async () => {
    const fakeFetch = async (url: string) => {
      if (url.endsWith('/messages')) return res(200, { 'hydra:member': [] });
      throw new Error('unexpected');
    };
    let t = 0;
    await expect(waitForMessage('jwt', {
      fetchImpl: fakeFetch as unknown as typeof fetch,
      sleep: async () => { t += 5000; },
      now: () => t,
      intervalMs: 5000,
      timeoutMs: 10_000,
    })).rejects.toThrow(/timed out/);
  });

  it('listMessages unwraps the hydra collection', async () => {
    const fakeFetch = async () => res(200, { 'hydra:member': [{ id: 'a' }, { id: 'b' }] });
    const msgs = await listMessages('jwt', { fetchImpl: fakeFetch as unknown as typeof fetch });
    expect(msgs.map((m: { id: string }) => m.id)).toEqual(['a', 'b']);
  });
});
