/**
 * EmbeddingProvider — Shared local embedding service using Transformers.js (ONNX).
 *
 * Loads all-MiniLM-L6-v2 (384-dim) once and provides embeddings to any memory
 * system (SemanticMemory, MemoryIndex, TopicMemory). Also handles loading the
 * sqlite-vec extension into better-sqlite3 connections.
 *
 * Design decisions:
 *   - Singleton: Model (~80MB) is loaded once, shared across all consumers
 *   - Lazy init: Model downloads on first embed() call, not on construction
 *   - Graceful degradation: If model fails to load, embed() throws but callers
 *     can catch and fall back to FTS5-only search
 *   - Batch support: embedBatch() is more efficient than sequential embed() calls
 */

type Database = import('better-sqlite3').Database;

/**
 * ONNX Runtime session options for the embedding pipeline. Caps the intra/inter-op
 * thread pools to 1: all-MiniLM-L6 is tiny and memory embeds are sporadic, so one
 * thread is plenty — and it stops the multi-thread ORT pool from busy-spinning
 * ~50% of a core while the model sits RESIDENT between embeds. This is the
 * fleet-wide idle-CPU root (task #17): profiled on a live agent server, the
 * default (unbounded) pool kept ~6 extra threads busy-spinning; verified via a
 * thread-count probe that this cap drops the resident pool (18→12 threads) with
 * identical 384-dim output. The existing idle-unload only helps a truly-idle
 * agent; this fixes the resident case (semantic-search queries re-arm the timer).
 */
export const ONNX_SESSION_OPTIONS = { intraOpNumThreads: 1, interOpNumThreads: 1 } as const;

export interface EmbeddingProviderConfig {
  /** Model name for @huggingface/transformers (default: 'Xenova/all-MiniLM-L6-v2') */
  modelName?: string;
  /** Embedding dimension (default: 384 for all-MiniLM-L6-v2) */
  dimensions?: number;
  /** Maximum text length to embed in characters (default: 8192) */
  maxTextLength?: number;
  /**
   * Idle-unload window in ms. After this long with no embed() call, the loaded
   * ONNX pipeline is disposed to free its thread pool, which busy-spins even
   * when idle (measured: ~3.6% of a core on a quiet box, up to ~44% on a
   * contended one — pure waste while an agent isn't doing memory work). The
   * next embed() lazily reloads (~1-3s, verified-identical output). Default
   * 300000 (5 min). Set 0 to disable (keep the model resident forever — the
   * prior behavior).
   */
  idleUnloadMs?: number;
  /**
   * Test/advanced seam: factory that produces the feature-extraction pipeline.
   * Defaults to the real `@huggingface/transformers` import. Tests inject a mock
   * (a callable with a `dispose()`) to exercise the idle-unload lifecycle
   * without loading the 80MB model.
   */
  pipelineFactory?: (modelName: string) => Promise<any>;
}

export class EmbeddingProvider {
  private pipeline: any = null;
  private loading: Promise<void> | null = null;
  private readonly modelName: string;
  readonly dimensions: number;
  private readonly maxTextLength: number;
  private readonly idleUnloadMs: number;
  private readonly pipelineFactory?: (modelName: string) => Promise<any>;
  private vecExtensionLoaded = new WeakSet<object>();

  /** In-flight embed() calls — the idle-unload timer never disposes while > 0. */
  private inFlight = 0;
  /** Rolling idle-unload timer (reset on every embed); unref'd so it can't keep the process alive. */
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config?: EmbeddingProviderConfig) {
    this.modelName = config?.modelName ?? 'Xenova/all-MiniLM-L6-v2';
    this.dimensions = config?.dimensions ?? 384;
    this.maxTextLength = config?.maxTextLength ?? 8192;
    this.idleUnloadMs = config?.idleUnloadMs ?? 300_000;
    this.pipelineFactory = config?.pipelineFactory;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────

  /**
   * Ensure the model is loaded. Safe to call multiple times — only loads once.
   */
  async initialize(): Promise<void> {
    if (this.pipeline) return;
    if (this.loading) {
      await this.loading;
      return;
    }

    this.loading = this.loadModel();
    await this.loading;
  }

  private async loadModel(): Promise<void> {
    if (this.pipelineFactory) {
      this.pipeline = await this.pipelineFactory(this.modelName);
      return;
    }
    const { pipeline: createPipeline } = await import('@huggingface/transformers');
    this.pipeline = await createPipeline('feature-extraction', this.modelName, {
      dtype: 'fp32',
      session_options: ONNX_SESSION_OPTIONS,
    } as Parameters<typeof createPipeline>[2]);
  }

  /**
   * Whether the model is loaded and ready for embedding.
   */
  get isReady(): boolean {
    return this.pipeline !== null;
  }

  /**
   * Arm (or re-arm) the rolling idle-unload timer. Called after every embed so
   * the window restarts on each use — an actively-embedding agent keeps the
   * model resident; one that goes quiet for `idleUnloadMs` unloads it.
   */
  private scheduleIdleUnload(): void {
    if (this.idleUnloadMs <= 0) return; // disabled — keep resident
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.maybeUnload();
    }, this.idleUnloadMs);
    // Never let the idle timer hold the process open on its own.
    this.idleTimer.unref?.();
  }

  /**
   * Dispose the loaded pipeline if it's idle — frees the ONNX thread pool that
   * busy-spins even when no embedding is happening. Guarded on inFlight so a
   * long-running batch that outlasts the window is never disposed mid-flight;
   * its completion re-arms the timer.
   */
  private async maybeUnload(): Promise<void> {
    if (this.inFlight > 0 || !this.pipeline) return;
    const p = this.pipeline;
    this.pipeline = null;
    this.loading = null;
    try {
      await p?.dispose?.();
    } catch {
      // @silent-fallback-ok — dispose is best-effort cleanup; failing to free
      // the session is not fatal (the next embed reloads a fresh pipeline).
    }
  }

  /**
   * Explicitly release the model + cancel the idle timer (shutdown / tests).
   * Idempotent.
   */
  async dispose(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.pipeline) {
      const p = this.pipeline;
      this.pipeline = null;
      this.loading = null;
      try {
        await p?.dispose?.();
      } catch { /* @silent-fallback-ok — best-effort cleanup */ }
    }
  }

  // ─── Embedding ──────────────────────────────────────────────────

  /**
   * Generate a normalized embedding for a single text string.
   * Lazy-initializes the model on first call.
   */
  async embed(text: string): Promise<Float32Array> {
    this.inFlight++;
    try {
      await this.initialize();

      const truncated = text.slice(0, this.maxTextLength);
      const output = await this.pipeline(truncated, {
        pooling: 'mean',
        normalize: true,
      });

      // output.data is a Float32Array from the ONNX model
      return new Float32Array(output.data);
    } finally {
      this.inFlight--;
      this.scheduleIdleUnload();
    }
  }

  /**
   * Generate normalized embeddings for multiple texts.
   * More efficient than sequential embed() calls for large batches.
   */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    // Single-text delegates to embed(), which owns its own inFlight + idle-timer
    // bookkeeping — don't double-count here.
    if (texts.length === 1) return [await this.embed(texts[0])];

    this.inFlight++;
    try {
      await this.initialize();

      const truncated = texts.map(t => t.slice(0, this.maxTextLength));
      const results: Float32Array[] = [];

      // Process in batches of 32 to avoid memory pressure
      const batchSize = 32;
      for (let i = 0; i < truncated.length; i += batchSize) {
        const batch = truncated.slice(i, i + batchSize);
        for (const text of batch) {
          const output = await this.pipeline(text, {
            pooling: 'mean',
            normalize: true,
          });
          results.push(new Float32Array(output.data));
        }
      }

      return results;
    } finally {
      this.inFlight--;
      this.scheduleIdleUnload();
    }
  }

  // ─── sqlite-vec Extension ───────────────────────────────────────

  /**
   * Load the sqlite-vec extension into a better-sqlite3 database connection.
   * Safe to call multiple times on the same connection — tracks loaded state.
   *
   * @returns true if loaded successfully, false if sqlite-vec unavailable
   */
  loadVecExtension(db: Database): boolean {
    // Use db object identity to track whether extension is already loaded
    if (this.vecExtensionLoaded.has(db as any)) return true;

    // sqlite-vec must be pre-loaded via loadVecExtensionAsync() first
    if (!this._sqliteVecModule) return false;

    try {
      this._sqliteVecModule.load(db);
      this.vecExtensionLoaded.add(db as any);
      return true;
    } catch { // @silent-fallback-ok: graceful degradation to FTS5-only when sqlite-vec fails
      return false;
    }
  }

  private _sqliteVecModule: { load: (db: any) => void } | null = null;

  /**
   * Pre-load the sqlite-vec module. Must be called before loadVecExtension().
   * Safe to call multiple times — only loads once.
   *
   * @returns true if sqlite-vec is available, false if not installed
   */
  async loadVecModule(): Promise<boolean> {
    if (this._sqliteVecModule) return true;

    try {
      const mod = await import('sqlite-vec');
      this._sqliteVecModule = mod;
      return true;
    } catch { // @silent-fallback-ok: sqlite-vec is optional dependency, FTS5-only when not installed
      return false;
    }
  }

  // ─── Utilities ──────────────────────────────────────────────────

  /**
   * Serialize a Float32Array to a Buffer for sqlite-vec storage.
   * sqlite-vec expects embeddings as raw binary blobs.
   */
  static toBuffer(embedding: Float32Array): Buffer {
    return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  }

  /**
   * Deserialize a Buffer back to a Float32Array.
   */
  static fromBuffer(buffer: Buffer): Float32Array {
    const copy = new ArrayBuffer(buffer.length);
    const view = new Uint8Array(copy);
    view.set(buffer);
    return new Float32Array(copy);
  }

  /**
   * Compute cosine similarity between two embeddings.
   * Assumes both are already L2-normalized (as produced by embed()).
   */
  static cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
      throw new Error(`Dimension mismatch: ${a.length} vs ${b.length}`);
    }
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
    }
    return dot;
  }
}
