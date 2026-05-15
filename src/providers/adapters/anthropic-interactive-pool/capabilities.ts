/**
 * Capability declaration for the anthropic-interactive-pool adapter.
 *
 * Optimized for the warm-pool pattern: WarmSessionInbox is the primary
 * primitive. OneShotCompletion routes through the pool too (allocate,
 * run, release). AgenticSessionHeadless is stubbed because long-running
 * autonomous sessions don't fit the pool model — those should use
 * anthropic-headless.
 */

import { CapabilityFlag, capabilitySet } from '../../capabilities.js';

export const anthropicInteractivePoolCapabilities = capabilitySet([
  // ── TRANSPORT ────────────────────────────────────────────────────────
  CapabilityFlag.OneShotCompletion,             // real — via pool
  CapabilityFlag.StructuredOneShot,             // STUB
  CapabilityFlag.AgenticSessionHeadless,        // STUB — use anthropic-headless for autonomous work
  CapabilityFlag.AgenticSessionInteractive,     // STUB — different use case
  CapabilityFlag.WarmSessionInbox,              // PRIMARY — the pool's main contract
  CapabilityFlag.AgenticSessionRpc,             // STUB

  // ── CAPABILITY ───────────────────────────────────────────────────────
  CapabilityFlag.ToolAccess,
  CapabilityFlag.ToolAllowlist,
  CapabilityFlag.FileSystemAccess,
  CapabilityFlag.PathAllowlist,
  CapabilityFlag.BashExecution,
  CapabilityFlag.WebAccess,

  // ── OBSERVABILITY ────────────────────────────────────────────────────
  CapabilityFlag.LiveOutputStream,
  CapabilityFlag.ConversationLogReader,
  CapabilityFlag.ConversationLogTailer,
  CapabilityFlag.HookEventReceiver,
  CapabilityFlag.SubagentLifecycleObserver,
  CapabilityFlag.SessionId,
  CapabilityFlag.UsageMeterProvider,
  CapabilityFlag.ProcessLifecycle,
  CapabilityFlag.InteractivePromptObserver,

  // ── CONTROL ──────────────────────────────────────────────────────────
  CapabilityFlag.InputInjection,
  CapabilityFlag.HardKill,
  CapabilityFlag.Interrupt,
  CapabilityFlag.StopGateInterceptor,
  CapabilityFlag.TimeoutBound,
  CapabilityFlag.IdleBound,
  CapabilityFlag.AuthCredentialInjection,
  CapabilityFlag.CredentialStorageProvider,
  CapabilityFlag.ContextScopeControl,
  CapabilityFlag.CompactionLifecycle,
  CapabilityFlag.IntelligenceCallQueue,         // STUB

  // ── INTEGRATION ──────────────────────────────────────────────────────
  CapabilityFlag.ProviderScaffolder,
  CapabilityFlag.McpToolRegistry,
  CapabilityFlag.SessionResumeIndex,
  CapabilityFlag.ConversationLogProvider,

  // ── ASYMMETRIC SUB-CAPABILITIES (same as anthropic-headless) ─────────
  CapabilityFlag.PublicUsageApi,
  CapabilityFlag.PreCompactHook,
  CapabilityFlag.SubagentLifecycleHooks,
]);
