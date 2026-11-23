/**
 * SlackLifeline — Minimal persistent process that owns the Slack Socket Mode connection.
 *
 * Survives server crashes. When the main server is down:
 * - Keeps the Socket Mode WebSocket alive
 * - Queues incoming messages to disk
 * - Replays queued messages when server recovers
 *
 * Modeled after TelegramLifeline but simpler because Socket Mode
 * handles reconnection internally (no offset tracking needed).
 */

import { maskInbound } from '../messaging/inboundCredentialMask.js';
import { credentialScrubEnabledReader } from '../core/outputCredentialScrub.js';
import fs from 'node:fs';
import path from 'node:path';
import { SlackApiClient } from '../messaging/slack/SlackApiClient.js';

export interface SlackLifelineConfig {
  botToken: string;
  appToken: string;
  stateDir: string;
  serverPort: number;
  authToken?: string;
}

interface QueuedSlackMessage {
  channelId: string;
  userId: string;
  text: string;
  ts: string;
  threadTs?: string;
  timestamp: string;
}

export class SlackLifeline {
  private config: SlackLifelineConfig;
  private apiClient: SlackApiClient;
  private queuePath: string;
  private queue: QueuedSlackMessage[] = [];
  private ws: WebSocket | null = null;
  private started = false;
  private serverHealthy = false;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: SlackLifelineConfig) {
    this.config = config;
    this.apiClient = new SlackApiClient(config.botToken, config.appToken);
    this.queuePath = path.join(config.stateDir, 'slack-lifeline-queue.json');
    this.loadQueue();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    console.log('[slack-lifeline] Starting...');

    // Start Socket Mode connection
    await this.connectSocketMode();

    // Start health checking the main server
    this.startHealthCheck();

    console.log('[slack-lifeline] Running. Socket Mode active, health checking server.');
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'lifeline stopping');
      this.ws = null;
    }
  }

  private async connectSocketMode(): Promise<void> {
    try {
      const response = await this.apiClient.call(
        'apps.connections.open',
        {},
        { useAppToken: true },
      );

      const url = (response as unknown as { url: string }).url;
      if (!url) throw new Error('No WebSocket URL');

      this.ws = new WebSocket(url);

      this.ws.addEventListener('open', () => {
        console.log('[slack-lifeline] Socket Mode connected');
      });

      this.ws.addEventListener('message', (event: MessageEvent) => {
        const raw = typeof event.data === 'string' ? event.data : String(event.data);
        this.handleMessage(raw);
      });

      this.ws.addEventListener('close', () => {
        console.log('[slack-lifeline] Socket Mode disconnected');
        this.ws = null;
        if (this.started) {
          // Reconnect with backoff
          this.reconnectTimer = setTimeout(() => {
            this.connectSocketMode().catch(err => {
              console.error('[slack-lifeline] Reconnect failed:', err.message);
            });
          }, 5000);
        }
      });

      this.ws.addEventListener('error', () => {
        // Close handler will trigger reconnect
      });

    } catch (err) {
      console.error('[slack-lifeline] Connection failed:', (err as Error).message);
      if (this.started) {
        this.reconnectTimer = setTimeout(() => {
          this.connectSocketMode().catch(() => {});
        }, 10000);
      }
    }
  }

  private handleMessage(raw: string): void {
    try {
      const envelope = JSON.parse(raw);

      // Acknowledge immediately
      if (envelope.envelope_id && this.ws) {
        this.ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      }

      // Handle disconnect events
      if (envelope.type === 'disconnect') {
        const reason = envelope.reason || envelope.payload?.reason || 'unknown';
        console.log(`[slack-lifeline] Disconnect event: ${reason}`);
        return;
      }

      // Extract message events
      if (envelope.type === 'events_api') {
        const event = envelope.payload?.event;
        if (event?.type === 'message' && event.user && event.text && !event.bot_id && !event.subtype) {
          this.routeMessage({
            channelId: event.channel,
            userId: event.user,
            text: event.text,
            ts: event.ts,
            threadTs: event.thread_ts,
            timestamp: new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      console.error('[slack-lifeline] Message parse error:', (err as Error).message);
    }
  }

  private routeMessage(msg: QueuedSlackMessage): void {
    if (this.serverHealthy) {
      // Forward to server
      this.forwardToServer(msg).catch(() => {
        // Server might have just died — queue it
        console.log('[slack-lifeline] Forward failed, queuing message');
        this.enqueue(msg);
      });
    } else {
      // Server is down — queue to disk
      console.log(`[slack-lifeline] Server down, queuing message from ${msg.userId}`);
      this.enqueue(msg);
    }
  }

  private async forwardToServer(msg: QueuedSlackMessage): Promise<void> {
    const url = `http://localhost:${this.config.serverPort}/internal/slack-forward`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.authToken) {
      headers['Authorization'] = `Bearer ${this.config.authToken}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        channelId: msg.channelId,
        text: `[slack:${msg.channelId}] ${msg.text}`,
        userId: msg.userId,
      }),
    });

    if (!response.ok) {
      throw new Error(`Forward failed: ${response.status}`);
    }
  }

  private startHealthCheck(): void {
    this.healthCheckTimer = setInterval(async () => {
      try {
        const response = await fetch(
          `http://localhost:${this.config.serverPort}/health`,
          { signal: AbortSignal.timeout(3000) },
        );
        const data = await response.json() as { status: string };
        const wasHealthy = this.serverHealthy;
        this.serverHealthy = data.status === 'ok';

        // Server just recovered — replay queued messages
        if (!wasHealthy && this.serverHealthy) {
          console.log('[slack-lifeline] Server recovered! Replaying queued messages...');
          await this.replayQueue();
        }
      } catch {
        if (this.serverHealthy) {
          console.log('[slack-lifeline] Server unreachable — queuing messages');
        }
        this.serverHealthy = false;
      }
    }, 5000); // Check every 5 seconds
  }

  private async replayQueue(): Promise<void> {
    const messages = this.drain();
    console.log(`[slack-lifeline] Replaying ${messages.length} queued messages`);

    for (const msg of messages) {
      try {
        await this.forwardToServer(msg);
      } catch (err) {
        console.error('[slack-lifeline] Replay failed, re-queuing:', (err as Error).message);
        this.enqueue(msg);
        break; // Server might be down again
      }
    }
  }

  // ── Simple disk-persisted queue ──

  private loadQueue(): void {
    try {
      if (fs.existsSync(this.queuePath)) {
        this.queue = JSON.parse(fs.readFileSync(this.queuePath, 'utf-8'));
      }
    } catch { this.queue = []; }
  }

  private saveQueue(): void {
    try {
      fs.writeFileSync(this.queuePath, JSON.stringify(this.queue));
    } catch { /* non-fatal */ }
  }

  private enqueue(msg: QueuedSlackMessage): void {
    // SEC-164 §3.5 (the lifeline rule): the raw text never reaches the queue file. The switch is read
    // fresh for each message, because the lifeline loads its settings only once at start.
    let enabled = false;
    try { enabled = credentialScrubEnabledReader(path.join(path.dirname(this.queuePath), '..'))(); } catch { enabled = false; } // @silent-fallback-ok — unreadable switch is off
    if (enabled && typeof msg.text === 'string' && msg.text) msg = { ...msg, text: maskInbound(msg.text, { enabled }).text };
    this.queue.push(msg);
    this.saveQueue();
  }

  private drain(): QueuedSlackMessage[] {
    const msgs = [...this.queue];
    this.queue = [];
    this.saveQueue();
    return msgs;
  }
}
