/**
 * LiveTestSlackCaller — a credential adapter implementing the `SlackCaller` seam that
 * `SlackLiveSender` consumes (see src/core/SlackLiveSender.ts), built for the
 * live-test harness (docs/specs/live-user-channel-proof-standard.md §5.4).
 *
 * THE PROBLEM IT SOLVES: the only DISTINCT non-Echo Slack senders we have captured in
 * the demo workspace are real test-USER identities authenticated the way a browser is —
 * an `xoxc-…` web-client token PLUS the user's `d` session cookie. Those are NOT Bearer
 * (xoxp/xoxb) tokens, so `SlackApiClient` (which only knows `Authorization: Bearer`)
 * cannot post AS one of those users. Without this adapter the harness's Slack arm could
 * never drive a REAL channel as a REAL member — defeating the whole point of the
 * gold-standard live-test (drive real channels as a real user).
 *
 * THE MECHANISM (mirrors .instar/slack-live-test/post-as.mjs):
 *  - `chat.postMessage` (POST AS THE MEMBER) → Slack web-client auth: the `xoxc` token
 *    goes in the x-www-form-urlencoded BODY (`token=<xoxc>`), and the member's `d`
 *    session cookie goes in a `Cookie: d=<value>` header, against the workspace host
 *    `https://<workspaceHost>/api/chat.postMessage`. This is exactly how the real Slack
 *    web client authenticates a message send, so the bot sees a genuine distinct-principal
 *    message over the live adapter.
 *  - every OTHER method (e.g. `conversations.history`) → the normal bot-token path:
 *    `Authorization: Bearer <botToken>` against `https://slack.com/api/<method>`. Reading
 *    history does not need to be done AS the member, and the bot token is a clean Bearer.
 *
 * Pure transport over an injected `fetch` (defaults to the global) so it is fully
 * unit-testable with a fake fetch. No silent fallbacks: a missing credential for the
 * path a call needs throws loudly (the harness records a real driver-error FAIL), never
 * a fabricated reply.
 */

import type { SlackCaller } from './SlackLiveSender.js';

/** The subset of `fetch` this adapter uses (so tests can inject a fake). */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{ json(): Promise<unknown> }>;

export interface LiveTestSlackCallerDeps {
  /** Workspace host for web-client posts, e.g. `sagemindlivetest.slack.com` (no scheme). */
  workspaceHost: string;
  /** The member's `xoxc-…` web-client token (goes in the form body for chat.postMessage). */
  xoxcToken: string;
  /** The member's `d` session cookie VALUE (goes in the `Cookie: d=…` header). */
  dCookie: string;
  /** A clean Bearer bot token used for every non-postMessage method (e.g. history reads). */
  botToken: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  logger?: (m: string) => void;
}

/** The shape SlackCaller.call resolves to. */
type SlackCallResult = Awaited<ReturnType<SlackCaller['call']>>;

export class LiveTestSlackCaller implements SlackCaller {
  private readonly d: LiveTestSlackCallerDeps;

  constructor(deps: LiveTestSlackCallerDeps) {
    // Inline, loud validation (no silent fallbacks). Each credential is required for the
    // path it serves; an empty one is a wiring error, not something to paper over.
    if (!deps.workspaceHost) {
      throw new Error('LiveTestSlackCaller: workspaceHost is required (the demo workspace host for web-client posts)');
    }
    if (!deps.xoxcToken) {
      throw new Error('LiveTestSlackCaller: xoxcToken is required (the member web-client token for chat.postMessage)');
    }
    if (!deps.dCookie) {
      throw new Error('LiveTestSlackCaller: dCookie is required (the member `d` session cookie for chat.postMessage)');
    }
    if (!deps.botToken) {
      throw new Error('LiveTestSlackCaller: botToken is required (the Bearer token for history/other reads)');
    }
    this.d = deps;
  }

  private log(m: string): void {
    this.d.logger?.(`[live-test-slack-caller] ${m}`);
  }

  private fetch(): FetchLike {
    return this.d.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as Promise<{ json(): Promise<unknown> }>);
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<SlackCallResult> {
    if (method === 'chat.postMessage') {
      return this.postAsMember(params);
    }
    return this.callAsBot(method, params);
  }

  /**
   * POST AS THE MEMBER — Slack web-client auth: xoxc token in the form body + `d` cookie
   * in the Cookie header, against the workspace host.
   */
  private async postAsMember(params: Record<string, unknown>): Promise<SlackCallResult> {
    const form = new URLSearchParams();
    form.set('token', this.d.xoxcToken);
    // Slack web-client send envelope (matches post-as.mjs).
    form.set('_x_reason', 'webapp_message_send');
    form.set('_x_mode', 'online');
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue; // skip undefined params (never serialize "undefined")
      form.set(k, typeof v === 'string' ? v : String(v));
    }

    const url = `https://${this.d.workspaceHost}/api/chat.postMessage`;
    const res = await this.fetch()(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `d=${this.d.dCookie}`,
      },
      body: form.toString(),
    });
    const json = (await res.json()) as SlackCallResult;
    this.log(`chat.postMessage AS member → ok=${json.ok} ts=${json.ts ?? ''}`);
    return json;
  }

  /**
   * Every other method goes over the clean Bearer bot-token path at slack.com — a JSON
   * body, `Authorization: Bearer <botToken>`.
   */
  private async callAsBot(method: string, params: Record<string, unknown>): Promise<SlackCallResult> {
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue; // skip undefined params
      body[k] = v;
    }

    const url = `https://slack.com/api/${method}`;
    const res = await this.fetch()(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.d.botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as SlackCallResult;
    this.log(`${method} (bot) → ok=${json.ok}`);
    return json;
  }
}
