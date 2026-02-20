/**
 * File-based state management.
 *
 * All state is stored as JSON files — no database dependency.
 * This is intentional: agent infrastructure should be portable
 * and not require running a DB server.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Session, JobState, ActivityEvent } from './types.js';

export class StateManager {
  private stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }

  /** Validate a key/ID contains only safe characters to prevent path traversal. */
  private validateKey(key: string, label: string = 'key'): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
      throw new Error(`Invalid ${label}: "${key}" — only alphanumeric, hyphens, and underscores allowed`);
    }
  }

  // ── Session State ───────────────────────────────────────────────

  getSession(sessionId: string): Session | null {
    this.validateKey(sessionId, 'sessionId');
    const filePath = path.join(this.stateDir, 'state', 'sessions', `${sessionId}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      console.warn(`[StateManager] Corrupted session file: ${filePath}`);
      return null;
    }
  }

  saveSession(session: Session): void {
    this.validateKey(session.id, 'sessionId');
    const filePath = path.join(this.stateDir, 'state', 'sessions', `${session.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
  }

  listSessions(filter?: { status?: Session['status'] }): Session[] {
    const dir = path.join(this.stateDir, 'state', 'sessions');
    if (!fs.existsSync(dir)) return [];

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const sessions: Session[] = [];
    for (const f of files) {
      try {
        sessions.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')));
      } catch {
        console.warn(`[StateManager] Corrupted session file: ${f}`);
      }
    }

    if (filter?.status) {
      return sessions.filter(s => s.status === filter.status);
    }
    return sessions;
  }

  // ── Job State ─────────────────────────────────────────────────

  getJobState(slug: string): JobState | null {
    this.validateKey(slug, 'job slug');
    const filePath = path.join(this.stateDir, 'state', 'jobs', `${slug}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      console.warn(`[StateManager] Corrupted job state file: ${filePath}`);
      return null;
    }
  }

  saveJobState(state: JobState): void {
    this.validateKey(state.slug, 'job slug');
    const filePath = path.join(this.stateDir, 'state', 'jobs', `${state.slug}.json`);
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  }

  // ── Activity Events ───────────────────────────────────────────

  appendEvent(event: ActivityEvent): void {
    const date = new Date().toISOString().slice(0, 10);
    const filePath = path.join(this.stateDir, 'logs', `activity-${date}.jsonl`);
    fs.appendFileSync(filePath, JSON.stringify(event) + '\n');
  }

  queryEvents(options: {
    since?: Date;
    type?: string;
    limit?: number;
  }): ActivityEvent[] {
    const logDir = path.join(this.stateDir, 'logs');
    if (!fs.existsSync(logDir)) return [];

    const files = fs.readdirSync(logDir)
      .filter(f => f.startsWith('activity-') && f.endsWith('.jsonl'))
      .sort()
      .reverse();

    const events: ActivityEvent[] = [];
    const limit = options.limit || 100;

    for (const file of files) {
      const lines = fs.readFileSync(path.join(logDir, file), 'utf-8')
        .split('\n')
        .filter(Boolean);

      for (const line of lines.reverse()) {
        let event: ActivityEvent;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // Skip corrupted lines
        }

        if (options.since && new Date(event.timestamp) < options.since) {
          return events; // Past the time window
        }

        if (options.type && event.type !== options.type) continue;

        events.push(event);
        if (events.length >= limit) return events;
      }
    }

    return events;
  }

  // ── Generic Key-Value Store ───────────────────────────────────

  get<T>(key: string): T | null {
    this.validateKey(key, 'state key');
    const filePath = path.join(this.stateDir, 'state', `${key}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      console.warn(`[StateManager] Corrupted state file: ${filePath}`);
      return null;
    }
  }

  set<T>(key: string, value: T): void {
    this.validateKey(key, 'state key');
    const filePath = path.join(this.stateDir, 'state', `${key}.json`);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  }
}
