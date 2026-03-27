import type { AgentRuntimeKind, ModelTier, SessionManagerConfig } from './types.js';

export interface RuntimeCommand {
  binary: string;
  args: string[];
  env: Record<string, string>;
}

function runtimeBinary(config: SessionManagerConfig): string {
  return config.runtimePath || config.claudePath || 'claude';
}

function modelFlag(runtime: AgentRuntimeKind, model?: ModelTier): string[] {
  if (!model) return [];

  if (runtime === 'claude') {
    return ['--model', model];
  }

  const codexModelMap: Record<ModelTier, string> = {
    haiku: 'gpt-5-codex-mini',
    sonnet: 'gpt-5-codex',
    opus: 'gpt-5.4',
  };
  return ['--model', codexModelMap[model]];
}

function runtimeEnv(config: SessionManagerConfig): Record<string, string> {
  if (config.runtime === 'codex' && config.runtimeHome) {
    return { CODEX_HOME: config.runtimeHome };
  }
  return {};
}

export function buildBatchRuntimeCommand(
  config: SessionManagerConfig,
  options: { prompt: string; model?: ModelTier },
): RuntimeCommand {
  if (config.runtime === 'codex') {
    return {
      binary: runtimeBinary(config),
      args: [
        'exec',
        '--ask-for-approval', 'never',
        '--sandbox', 'danger-full-access',
        '--skip-git-repo-check',
        ...modelFlag(config.runtime, options.model),
        options.prompt,
      ],
      env: runtimeEnv(config),
    };
  }

  return {
    binary: runtimeBinary(config),
    args: [
      '--dangerously-skip-permissions',
      ...modelFlag(config.runtime, options.model),
      '-p',
      options.prompt,
    ],
    env: runtimeEnv(config),
  };
}

export function buildInteractiveRuntimeCommand(
  config: SessionManagerConfig,
  options?: { resumeSessionId?: string },
): RuntimeCommand {
  if (config.runtime === 'codex') {
    const args = options?.resumeSessionId
      ? ['resume', options.resumeSessionId]
      : [];
    args.push(
      '--ask-for-approval', 'never',
      '--sandbox', 'danger-full-access',
    );

    return {
      binary: runtimeBinary(config),
      args,
      env: runtimeEnv(config),
    };
  }

  const args = ['--dangerously-skip-permissions'];
  if (options?.resumeSessionId) {
    args.push('--resume', options.resumeSessionId);
  }

  return {
    binary: runtimeBinary(config),
    args,
    env: runtimeEnv(config),
  };
}

export function buildTriageRuntimeCommand(
  config: SessionManagerConfig,
  options: { allowedTools: string[]; permissionMode: string; resumeSessionId?: string },
): RuntimeCommand {
  if (config.runtime === 'codex') {
    const args = options.resumeSessionId
      ? ['resume', options.resumeSessionId]
      : [];
    args.push(
      '--ask-for-approval', options.permissionMode === 'never' ? 'never' : 'on-request',
      '--sandbox', 'workspace-write',
    );

    return {
      binary: runtimeBinary(config),
      args,
      env: runtimeEnv(config),
    };
  }

  const args = [
    '--allowedTools', options.allowedTools.join(','),
    '--permission-mode', options.permissionMode,
  ];

  if (options.resumeSessionId) {
    args.push('--resume', options.resumeSessionId);
  }

  return {
    binary: runtimeBinary(config),
    args,
    env: runtimeEnv(config),
  };
}

export function isRuntimeReady(config: SessionManagerConfig, output: string): boolean {
  const trimmed = output.trim();
  if (config.runtime === 'codex') {
    // Codex: Look for actual prompt indicators rather than any output.
    // Codex uses '>' as its primary prompt, and may show status messages.
    // Avoid false positives from startup banners or version strings.
    const lines = trimmed.split('\n');
    const lastLine = lines[lines.length - 1] || '';

    // Check for Codex prompt (>), not just any output
    if (lastLine.match(/^\s*>\s*$/) || lastLine.endsWith('> ')) {
      return true;
    }

    // Also accept output that ends with a newline followed by nothing
    // (indicates prompt is waiting), but require at least some output
    // to avoid triggering on initial startup
    if (trimmed.length > 10 && trimmed.endsWith('\n')) {
      return true;
    }

    return false;
  }

  return trimmed.includes('❯') || trimmed.includes('bypass permissions');
}

export function idlePromptPatterns(config: SessionManagerConfig): string[] {
  if (config.runtime === 'codex') {
    // Codex idle patterns: at the Codex prompt waiting for input
    // The '> ' pattern indicates Codex is waiting at its prompt
    return ['> '];
  }

  return [
    'bypass permissions on',
    'shift+tab to cycle',
    'auto-accept edits',
  ];
}

export function runtimeProcessNames(config: SessionManagerConfig): string[] {
  if (config.runtime === 'codex') {
    return ['codex', 'node'];
  }

  return ['claude', 'node'];
}
