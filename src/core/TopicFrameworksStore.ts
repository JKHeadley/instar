/**
 * TopicFrameworksStore — persistent per-topic framework selection.
 *
 * Stores the active framework binding for each Telegram topic in a
 * separate state file (NOT config.json). Two reasons for the split:
 *
 *  1. Robustness: config.json is operator-edited; the runtime state
 *     file is agent-edited. Mixing them risks one process trampling
 *     the other's edits. Atomic writes here, manual edits there.
 *  2. Recovery: a corrupt state file at boot falls back to config-
 *     level `topicFrameworks` (the operator-authored defaults). A
 *     corrupt config falls back to global default. Two layers of
 *     graceful degradation.
 *
 * On read, the merged view is: `state file ∪ config defaults`, with
 * the state file winning on conflicts. Writes go only to the state
 * file.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { IntelligenceFramework } from './intelligenceProviderFactory.js';

/**
 * Persisted shape of the topic-frameworks state file. Stored at
 * `.instar/state/topic-frameworks.json`.
 */
export interface TopicFrameworksState {
  /** ISO timestamp of the last update. */
  updatedAt: string;
  /** Map of stringified topic id → selected framework. */
  topics: Record<string, IntelligenceFramework>;
}

export interface TopicFrameworksStoreOptions {
  /** Absolute path to the state file (typically under stateDir/state/). */
  stateFilePath: string;
  /**
   * Config-level defaults (from `InstarConfig.topicFrameworks`).
   * Used when the state file is silent on a given topic.
   */
  configDefaults?: Record<string, IntelligenceFramework>;
}

/**
 * The set of frameworks this store will accept. Codex-cli covers
 * mode (c). Claude-code covers mode (a)+(b) collapsed — per Justin's
 * clarification, the SDK-credit-vs-subscription distinction is
 * handled invisibly by the cost router, not at the topic-framework
 * level.
 */
export const SUPPORTED_FRAMEWORKS: ReadonlyArray<IntelligenceFramework> = [
  'claude-code',
  'codex-cli',
  'gemini-cli',
];

export class TopicFrameworksStore {
  private readonly stateFilePath: string;
  private readonly configDefaults: Record<string, IntelligenceFramework>;
  /** In-memory mirror of the state file. Hydrated from disk on load(). */
  private overrides: Record<string, IntelligenceFramework> = {};

  constructor(options: TopicFrameworksStoreOptions) {
    this.stateFilePath = options.stateFilePath;
    this.configDefaults = { ...(options.configDefaults ?? {}) };
    this.load();
  }

  /**
   * Lookup the framework for a topic. Returns the override from the
   * state file if present, the config default if not, or null when
   * neither layer has an entry (caller falls back to global default).
   */
  get(topicId: number | string): IntelligenceFramework | null {
    const key = String(topicId);
    return this.overrides[key] ?? this.configDefaults[key] ?? null;
  }

  /**
   * Set a topic's framework and persist atomically. The overrides
   * layer always wins on subsequent reads.
   */
  set(topicId: number | string, framework: IntelligenceFramework): void {
    const key = String(topicId);
    this.overrides[key] = framework;
    this.persist();
  }

  /** Remove a topic's override (falls back to config default after). */
  clear(topicId: number | string): void {
    const key = String(topicId);
    if (key in this.overrides) {
      delete this.overrides[key];
      this.persist();
    }
  }

  /** Snapshot of every topic with a known framework (override or default). */
  snapshot(): Record<string, IntelligenceFramework> {
    return { ...this.configDefaults, ...this.overrides };
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.stateFilePath)) return;
      const raw = fs.readFileSync(this.stateFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<TopicFrameworksState>;
      if (parsed && typeof parsed === 'object' && parsed.topics && typeof parsed.topics === 'object') {
        // Validate each value before accepting — silently drop unknowns
        // rather than crashing the boot.
        for (const [k, v] of Object.entries(parsed.topics)) {
          if (typeof v === 'string' && (SUPPORTED_FRAMEWORKS as ReadonlyArray<string>).includes(v)) {
            this.overrides[k] = v as IntelligenceFramework;
          }
        }
      }
    } catch (err) {
      // Corrupt or unreadable state — leave overrides empty so the
      // store transparently falls back to config defaults. Surface
      // the failure to logs but don't throw — boot must succeed.
      console.warn(`[TopicFrameworksStore] Failed to load state from ${this.stateFilePath}: ${err}`);
    }
  }

  private persist(): void {
    const dir = path.dirname(this.stateFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const state: TopicFrameworksState = {
      updatedAt: new Date().toISOString(),
      topics: { ...this.overrides },
    };
    const tmp = `${this.stateFilePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf-8' });
    fs.renameSync(tmp, this.stateFilePath);
  }
}
