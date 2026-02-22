/**
 * Feedback Manager — handles the agent-to-origin feedback loop.
 *
 * Stores feedback locally and forwards it to a configured webhook URL.
 * This is the "phone home" mechanism: agents can report issues, request
 * features, and provide feedback that flows back to the Instar maintainers.
 *
 * Part of the "Rising Tide" system — every user's feedback improves
 * the platform for everyone.
 *
 * Security: Sends proper identification headers (User-Agent, X-Instar-Version)
 * so the receiving endpoint can verify requests come from real Instar agents.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHmac } from 'node:crypto';
import type { FeedbackItem, FeedbackConfig } from './types.js';

/** Maximum number of feedback items stored locally. */
const MAX_FEEDBACK_ITEMS = 1000;

export class FeedbackManager {
  private config: FeedbackConfig;
  private feedbackFile: string;
  private version: string;

  constructor(config: FeedbackConfig) {
    if (config.webhookUrl) {
      FeedbackManager.validateWebhookUrl(config.webhookUrl);
    }
    this.config = config;
    this.feedbackFile = config.feedbackFile;
    this.version = config.version || '0.0.0';
  }

  /** Standard headers that identify this as a legitimate Instar agent. */
  private getWebhookHeaders(body: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': `instar/${this.version} (node/${process.version})`,
      'X-Instar-Version': this.version,
    };

    // HMAC-SHA256 signing if shared secret is configured
    if (this.config.sharedSecret) {
      const timestamp = Date.now().toString();
      const signature = createHmac('sha256', this.config.sharedSecret)
        .update(`${timestamp}.${body}`)
        .digest('hex');
      headers['X-Instar-Signature'] = signature;
      headers['X-Instar-Timestamp'] = timestamp;
    }

    return headers;
  }

  /** Validate webhook URL is HTTPS and not pointing to internal addresses. */
  private static validateWebhookUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`FeedbackManager: invalid webhook URL: ${url}`);
    }
    if (parsed.protocol !== 'https:') {
      throw new Error('FeedbackManager: webhook URL must use HTTPS');
    }
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' ||
        host.startsWith('10.') || host.startsWith('192.168.') || host.endsWith('.local') ||
        host.startsWith('169.254.') || host === '[::1]') {
      throw new Error('FeedbackManager: webhook URL must not point to internal addresses');
    }
  }

  /**
   * Submit feedback — stores locally and forwards to webhook.
   */
  async submit(item: Omit<FeedbackItem, 'id' | 'submittedAt' | 'forwarded'>): Promise<FeedbackItem> {
    const feedback: FeedbackItem = {
      ...item,
      id: `fb-${randomUUID().slice(0, 12)}`,
      submittedAt: new Date().toISOString(),
      forwarded: false,
    };

    // Forward to webhook if enabled (before persisting, so we know result)
    if (this.config.enabled && this.config.webhookUrl) {
      try {
        const payload = {
          feedbackId: feedback.id,
          type: feedback.type,
          title: feedback.title,
          description: feedback.description,
          agentName: feedback.agentName,
          instarVersion: this.version,
          nodeVersion: process.version,
          os: feedback.os,
          context: feedback.context,
          submittedAt: feedback.submittedAt,
        };
        const body = JSON.stringify(payload);
        const response = await fetch(this.config.webhookUrl, {
          method: 'POST',
          headers: this.getWebhookHeaders(body),
          body,
          signal: AbortSignal.timeout(10000), // 10s timeout
        });

        if (response.ok) {
          feedback.forwarded = true;
          console.log(`[feedback] Forwarded to webhook`);
        } else {
          console.error(`[feedback] Webhook returned ${response.status}: ${response.statusText}`);
        }
      } catch (err) {
        // Don't fail on webhook errors — the local record is the receipt
        console.error(`[feedback] Webhook failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Store locally in a single write (eliminates append+update race condition)
    this.appendFeedback(feedback);

    return feedback;
  }

  /**
   * List all stored feedback.
   */
  list(): FeedbackItem[] {
    return this.loadFeedback();
  }

  /**
   * Get a single feedback item by ID.
   */
  get(id: string): FeedbackItem | null {
    const items = this.loadFeedback();
    return items.find(f => f.id === id) ?? null;
  }

  /**
   * Retry forwarding any un-forwarded feedback.
   */
  async retryUnforwarded(): Promise<{ retried: number; succeeded: number }> {
    const items = this.loadFeedback();
    const unforwarded = items.filter(f => !f.forwarded);

    if (!this.config.enabled || !this.config.webhookUrl || unforwarded.length === 0) {
      return { retried: 0, succeeded: 0 };
    }

    let succeeded = 0;
    for (const item of unforwarded) {
      try {
        const payload = {
          feedbackId: item.id,
          type: item.type,
          title: item.title,
          description: item.description,
          agentName: item.agentName,
          instarVersion: this.version,
          nodeVersion: item.nodeVersion,
          os: item.os,
          context: item.context,
          submittedAt: item.submittedAt,
        };
        const body = JSON.stringify(payload);
        const response = await fetch(this.config.webhookUrl, {
          method: 'POST',
          headers: this.getWebhookHeaders(body),
          body,
          signal: AbortSignal.timeout(10000),
        });

        if (response.ok) {
          item.forwarded = true;
          succeeded++;
        }
      } catch {
        // Skip, will retry next time
      }
    }

    if (succeeded > 0) {
      this.saveFeedback(items);
    }

    return { retried: unforwarded.length, succeeded };
  }

  // ── Private helpers ──────────────────────────────────────────────

  private loadFeedback(): FeedbackItem[] {
    if (!fs.existsSync(this.feedbackFile)) return [];
    try {
      return JSON.parse(fs.readFileSync(this.feedbackFile, 'utf-8'));
    } catch {
      return [];
    }
  }

  private saveFeedback(items: FeedbackItem[]): void {
    const dir = path.dirname(this.feedbackFile);
    fs.mkdirSync(dir, { recursive: true });
    // Atomic write: unique temp filename prevents concurrent corruption
    const tmpPath = `${this.feedbackFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(items, null, 2));
      fs.renameSync(tmpPath, this.feedbackFile);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }

  private appendFeedback(item: FeedbackItem): void {
    let items = this.loadFeedback();
    items.push(item);
    // Cap feedback items to prevent unbounded file growth
    if (items.length > MAX_FEEDBACK_ITEMS) {
      items = items.slice(-MAX_FEEDBACK_ITEMS);
    }
    this.saveFeedback(items);
  }

  private updateFeedback(updated: FeedbackItem): void {
    const items = this.loadFeedback();
    const idx = items.findIndex(f => f.id === updated.id);
    if (idx >= 0) {
      items[idx] = updated;
      this.saveFeedback(items);
    }
  }
}
