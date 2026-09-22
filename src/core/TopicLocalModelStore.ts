/**
 * TopicLocalModelStore — persistent per-topic local-model selection.
 *
 * Sibling of TopicFrameworksStore. Stores which local-model provider
 * (ollama / lmstudio) and which model id a topic should use when its
 * framework is codex-cli AND the operator has flipped the topic to a
 * local model via `/local-model ollama [model]` in Telegram.
 *
 * Why this is separate from TopicFrameworksStore:
 *   - Concern separation: framework (claude vs codex) is independent
 *     of provider (cloud-codex vs local-ollama). A topic can be on
 *     Codex with cloud OR Codex with local; the framework store can't
 *     express that.
 *   - Validation surface: local-model selection has different
 *     pre-conditions (provider must be reachable, model must be
 *     pulled) than framework selection.
 *
 * On read, the merged view is: `state file ∪ config defaults`, with
 * the state file winning. Writes go only to the state file. Same
 * persistence pattern as TopicFrameworksStore.
 */

import fs from 'node:fs';
import path from 'node:path';
import { mergeDefaults } from './mergeDefaults.js';

export type LocalProvider = 'ollama' | 'lmstudio';

export const SUPPORTED_LOCAL_PROVIDERS: ReadonlyArray<LocalProvider> = ['ollama', 'lmstudio'];

export interface TopicLocalModelEntry {
  provider: LocalProvider;
  /** Model id, e.g. "llama3.2:latest". Empty/absent means "Codex picks default". */
  model?: string;
}

export interface TopicLocalModelState {
  updatedAt: string;
  topics: Record<string, TopicLocalModelEntry>;
}

export interface TopicLocalModelStoreOptions {
  stateFilePath: string;
  /**
   * Config defaults sourced from
   *   `InstarConfig.topicCodexLocalProvider` (map of topic→provider)
   * combined with
   *   `InstarConfig.topicCodexLocalModel` (map of topic→model).
   */
  configDefaults?: Record<string, TopicLocalModelEntry>;
}

export class TopicLocalModelStore {
  private readonly stateFilePath: string;
  private readonly configDefaults: Record<string, TopicLocalModelEntry>;
  private overrides: Record<string, TopicLocalModelEntry> = {};

  constructor(options: TopicLocalModelStoreOptions) {
    this.stateFilePath = options.stateFilePath;
    this.configDefaults = { ...(options.configDefaults ?? {}) };
    this.load();
  }

  get(topicId: number | string): TopicLocalModelEntry | null {
    const key = String(topicId);
    return this.overrides[key] ?? this.configDefaults[key] ?? null;
  }

  set(topicId: number | string, entry: TopicLocalModelEntry): void {
    const key = String(topicId);
    this.overrides[key] = { ...entry };
    this.persist();
  }

  clear(topicId: number | string): boolean {
    const key = String(topicId);
    if (key in this.overrides) {
      delete this.overrides[key];
      this.persist();
      return true;
    }
    return false;
  }

  snapshot(): Record<string, TopicLocalModelEntry> {
    return mergeDefaults(this.configDefaults, this.overrides);
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.stateFilePath)) return;
      const raw = fs.readFileSync(this.stateFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<TopicLocalModelState>;
      if (parsed && typeof parsed === 'object' && parsed.topics && typeof parsed.topics === 'object') {
        for (const [k, v] of Object.entries(parsed.topics)) {
          if (
            v && typeof v === 'object'
            && typeof (v as TopicLocalModelEntry).provider === 'string'
            && (SUPPORTED_LOCAL_PROVIDERS as ReadonlyArray<string>).includes((v as TopicLocalModelEntry).provider)
          ) {
            this.overrides[k] = {
              provider: (v as TopicLocalModelEntry).provider,
              ...(typeof (v as TopicLocalModelEntry).model === 'string' ? { model: (v as TopicLocalModelEntry).model } : {}),
            };
          }
        }
      }
    } catch (err) {
      console.warn(`[TopicLocalModelStore] Failed to load state from ${this.stateFilePath}: ${err}`);
    }
  }

  private persist(): void {
    const dir = path.dirname(this.stateFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const state: TopicLocalModelState = {
      updatedAt: new Date().toISOString(),
      topics: { ...this.overrides },
    };
    const tmp = `${this.stateFilePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf-8' });
    fs.renameSync(tmp, this.stateFilePath);
  }
}
