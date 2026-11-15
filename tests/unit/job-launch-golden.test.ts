/**
 * T1 (frozen acceptance list, docs/efforts/engine-optimization/step3/acceptance-tests.md):
 * golden argv/env for BOTH launch builders x every engine with `thinkingMode` ABSENT.
 * Captured from unmodified main 3ae8208a6 (spec job-launch-intent-record, criterion 1).
 * Interactive grok-build goldens are captured with its existing opt-in (grokInteractiveOptIn: true);
 * the refusal without the opt-in is a separate block at the end.
 * Any byte change to the default launch path fails this test. Do not regenerate it to make
 * a change pass: a diff here means the default path moved, which the spec forbids.
 */
import { describe, it, expect } from 'vitest';
import { buildInteractiveLaunch, buildHeadlessLaunch } from '../../src/core/frameworkSessionLaunch.js';

const ENGINES = ['claude-code', 'codex-cli', 'gemini-cli', 'pi-cli', 'grok-build'] as const;
const INTERACTIVE_PROFILES: Record<string, Record<string, unknown>> = {
  minimal: { binaryPath: '/bin/engine' },
  model: { binaryPath: '/bin/engine', model: 'balanced' },
  sandbox: { binaryPath: '/bin/engine', model: 'balanced', codexSandboxMode: 'workspace-write' },
  defaultModel: { binaryPath: '/bin/engine', defaultModel: 'balanced' },
};
// Interactive grok-build is behind its existing opt-in (sessions.grokInteractiveSessions →
// grokInteractiveOptIn). The goldens below are captured WITH the opt-in, so its real argv/env is
// pinned; the refusal without the opt-in is pinned separately (GROK_REFUSAL).
const interactiveOpts = (engine: string, opts: Record<string, unknown>) =>
  engine === 'grok-build' ? { ...opts, grokInteractiveOptIn: true } : opts;
const HEADLESS_PROFILES: Record<string, Record<string, unknown>> = {
  minimal: { binaryPath: '/bin/engine', prompt: 'run the job' },
  model: { binaryPath: '/bin/engine', prompt: 'run the job', model: 'balanced' },
  oss: { binaryPath: '/bin/engine', prompt: 'run the job', codexLocalProvider: 'ollama' },
};

const GOLDEN: Record<string, { argv?: string[]; env?: Record<string, string>; throws?: string }> = {
  "interactive|claude-code|minimal": {
    "argv": [
      "/bin/engine",
      "--dangerously-skip-permissions"
    ],
    "env": {
      "CLAUDECODE": ""
    }
  },
  "interactive|claude-code|model": {
    "argv": [
      "/bin/engine",
      "--dangerously-skip-permissions"
    ],
    "env": {
      "CLAUDECODE": ""
    }
  },
  "interactive|claude-code|sandbox": {
    "argv": [
      "/bin/engine",
      "--dangerously-skip-permissions"
    ],
    "env": {
      "CLAUDECODE": ""
    }
  },
  "interactive|claude-code|defaultModel": {
    "argv": [
      "/bin/engine",
      "--dangerously-skip-permissions",
      "--model",
      "sonnet"
    ],
    "env": {
      "CLAUDECODE": ""
    }
  },
  "headless|claude-code|minimal": {
    "argv": [
      "/bin/engine",
      "--dangerously-skip-permissions",
      "-p",
      "run the job"
    ],
    "env": {
      "CLAUDECODE": ""
    }
  },
  "headless|claude-code|model": {
    "argv": [
      "/bin/engine",
      "--dangerously-skip-permissions",
      "--model",
      "sonnet",
      "-p",
      "run the job"
    ],
    "env": {
      "CLAUDECODE": ""
    }
  },
  "headless|claude-code|oss": {
    "argv": [
      "/bin/engine",
      "--dangerously-skip-permissions",
      "-p",
      "run the job"
    ],
    "env": {
      "CLAUDECODE": ""
    }
  },
  "interactive|codex-cli|minimal": {
    "argv": [
      "/bin/engine",
      "--model",
      "gpt-6-sol",
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      "check_for_update_on_startup=false"
    ],
    "env": {
      "CLAUDECODE": ""
    }
  },
  "interactive|codex-cli|model": {
    "argv": [
      "/bin/engine",
      "--model",
      "gpt-6-sol",
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      "check_for_update_on_startup=false"
    ],
    "env": {
      "CLAUDECODE": ""
    }
  },
  "interactive|codex-cli|sandbox": {
    "argv": [
      "/bin/engine",
      "--model",
      "gpt-6-sol",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "-c",
      "check_for_update_on_startup=false"
    ],
    "env": {
      "CLAUDECODE": ""
    }
  },
  "interactive|codex-cli|defaultModel": {
    "argv": [
      "/bin/engine",
      "--model",
      "gpt-6-sol",
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      "check_for_update_on_startup=false"
    ],
    "env": {
      "CLAUDECODE": ""
    }
  },
  "headless|codex-cli|minimal": {
    "argv": [
      "/bin/engine",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-s",
      "workspace-write",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "-m",
      "gpt-6-sol",
      "run the job"
    ],
    "env": {
      "CLAUDECODE": ""
    }
  },
  "headless|codex-cli|model": {
    "argv": [
      "/bin/engine",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-s",
      "workspace-write",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "-m",
      "gpt-6-sol",
      "run the job"
    ],
    "env": {
      "CLAUDECODE": ""
    }
  },
  "headless|codex-cli|oss": {
    "argv": [
      "/bin/engine",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--oss",
      "--local-provider",
      "ollama",
      "-s",
      "workspace-write",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "-m",
      "llama3.2:latest",
      "run the job"
    ],
    "env": {
      "CLAUDECODE": ""
    }
  },
  "interactive|gemini-cli|minimal": {
    "argv": [
      "/bin/engine",
      "-m",
      "gemini-2.5-flash",
      "--yolo"
    ],
    "env": {
      "CLAUDECODE": ""
    }
  },
  "interactive|gemini-cli|model": {
    "argv": [
      "/bin/engine",
      "-m",
      "gemini-2.5-flash",
      "--yolo"
    ],
    "env": {
      "CLAUDECODE": ""
    }
  },
  "interactive|gemini-cli|sandbox": {
    "argv": [
      "/bin/engine",
      "-m",
      "gemini-2.5-flash",
      "--yolo"
    ],
    "env": {
      "CLAUDECODE": ""
    }
  },
  "interactive|gemini-cli|defaultModel": {
    "argv": [
      "/bin/engine",
      "-m",
      "gemini-2.5-flash",
      "--yolo"
    ],
    "env": {
      "CLAUDECODE": ""
    }
  },
  "headless|gemini-cli|minimal": {
    "argv": [
      "/bin/engine",
      "-m",
      "gemini-2.5-flash",
      "--approval-mode",
      "default",
      "-p",
      "run the job"
    ],
    "env": {
      "CLAUDECODE": ""
    }
  },
  "headless|gemini-cli|model": {
    "argv": [
      "/bin/engine",
      "-m",
      "gemini-2.5-flash",
      "--approval-mode",
      "default",
      "-p",
      "run the job"
    ],
    "env": {
      "CLAUDECODE": ""
    }
  },
  "headless|gemini-cli|oss": {
    "argv": [
      "/bin/engine",
      "-m",
      "gemini-2.5-flash",
      "--approval-mode",
      "default",
      "-p",
      "run the job"
    ],
    "env": {
      "CLAUDECODE": ""
    }
  },
  "interactive|pi-cli|minimal": {
    "argv": [
      "/bin/engine"
    ],
    "env": {
      "CLAUDECODE": ""
    }
  },
  "interactive|pi-cli|model": {
    "argv": [
      "/bin/engine"
    ],
    "env": {
      "CLAUDECODE": ""
    }
  },
  "interactive|pi-cli|sandbox": {
    "argv": [
      "/bin/engine"
    ],
    "env": {
      "CLAUDECODE": ""
    }
  },
  "interactive|pi-cli|defaultModel": {
    "argv": [
      "/bin/engine",
      "--model",
      "balanced"
    ],
    "env": {
      "CLAUDECODE": ""
    }
  },
  "headless|pi-cli|minimal": {
    "argv": [
      "/bin/engine",
      "-p",
      "--mode",
      "json",
      "--no-session",
      "--offline",
      "run the job"
    ],
    "env": {
      "CLAUDECODE": ""
    }
  },
  "headless|pi-cli|model": {
    "argv": [
      "/bin/engine",
      "-p",
      "--mode",
      "json",
      "--no-session",
      "--offline",
      "--model",
      "balanced",
      "run the job"
    ],
    "env": {
      "CLAUDECODE": ""
    }
  },
  "headless|pi-cli|oss": {
    "argv": [
      "/bin/engine",
      "-p",
      "--mode",
      "json",
      "--no-session",
      "--offline",
      "run the job"
    ],
    "env": {
      "CLAUDECODE": ""
    }
  },
  "interactive|grok-build|minimal": {
    "argv": [
      "/bin/engine"
    ],
    "env": {
      "CLAUDECODE": "",
      "GROK_DISABLE_API_KEY_AUTH": "1",
      "XAI_API_KEY": "",
      "GROK_DEPLOYMENT_KEY": ""
    }
  },
  "interactive|grok-build|model": {
    "argv": [
      "/bin/engine"
    ],
    "env": {
      "CLAUDECODE": "",
      "GROK_DISABLE_API_KEY_AUTH": "1",
      "XAI_API_KEY": "",
      "GROK_DEPLOYMENT_KEY": ""
    }
  },
  "interactive|grok-build|sandbox": {
    "argv": [
      "/bin/engine"
    ],
    "env": {
      "CLAUDECODE": "",
      "GROK_DISABLE_API_KEY_AUTH": "1",
      "XAI_API_KEY": "",
      "GROK_DEPLOYMENT_KEY": ""
    }
  },
  "interactive|grok-build|defaultModel": {
    "argv": [
      "/bin/engine",
      "-m",
      "grok-4.6"
    ],
    "env": {
      "CLAUDECODE": "",
      "GROK_DISABLE_API_KEY_AUTH": "1",
      "XAI_API_KEY": "",
      "GROK_DEPLOYMENT_KEY": ""
    }
  },
  "headless|grok-build|minimal": {
    "argv": [
      "/bin/engine",
      "--permission-mode",
      "bypassPermissions",
      "--prompt-file",
      "<grok-scratch>/prompt.txt"
    ],
    "env": {
      "GROK_DISABLE_API_KEY_AUTH": "1",
      "XAI_API_KEY": "",
      "GROK_API_KEY": ""
    }
  },
  "headless|grok-build|model": {
    "argv": [
      "/bin/engine",
      "--model",
      "grok-4.6",
      "--permission-mode",
      "bypassPermissions",
      "--prompt-file",
      "<grok-scratch>/prompt.txt"
    ],
    "env": {
      "GROK_DISABLE_API_KEY_AUTH": "1",
      "XAI_API_KEY": "",
      "GROK_API_KEY": ""
    }
  },
  "headless|grok-build|oss": {
    "argv": [
      "/bin/engine",
      "--permission-mode",
      "bypassPermissions",
      "--prompt-file",
      "<grok-scratch>/prompt.txt"
    ],
    "env": {
      "GROK_DISABLE_API_KEY_AUTH": "1",
      "XAI_API_KEY": "",
      "GROK_API_KEY": ""
    }
  }
};

function capture(fn: () => { argv: string[]; envOverrides: Record<string, string> }) {
  try {
    const s = fn();
    return {
      argv: s.argv.map((a) => a.replace(/.*\/grok-scratch-[^/]+\/prompt\.txt$/, '<grok-scratch>/prompt.txt')),
      env: s.envOverrides,
    };
  } catch (err) {
    return { throws: String((err as Error).message).split(':')[0] };
  }
}

describe('T1 golden default launch (thinkingMode absent)', () => {
  for (const engine of ENGINES) {
    for (const [profile, opts] of Object.entries(INTERACTIVE_PROFILES)) {
      it(`interactive ${engine} ${profile}`, () => {
        const got = capture(() => buildInteractiveLaunch(engine as never, interactiveOpts(engine, opts) as never));
        const want = GOLDEN[`interactive|${engine}|${profile}`];
        expect(want, `no golden for interactive|${engine}|${profile}`).toBeDefined();
        expect(got.throws, 'the default interactive launch must build').toBeUndefined();
        expect({ argv: got.argv, env: got.env, throws: got.throws }).toEqual({ argv: want.argv, env: want.env, throws: want.throws });
      });
    }
    for (const [profile, opts] of Object.entries(HEADLESS_PROFILES)) {
      it(`headless ${engine} ${profile}`, () => {
        const got = capture(() => buildHeadlessLaunch(engine as never, opts as never));
        const want = GOLDEN[`headless|${engine}|${profile}`];
        expect(want, `no golden for headless|${engine}|${profile}`).toBeDefined();
        expect({ argv: got.argv, env: got.env, throws: got.throws }).toEqual({ argv: want.argv, env: want.env, throws: want.throws });
      });
    }
  }
});

// The opt-in gate itself, pinned apart from the goldens: without the opt-in, interactive
// grok-build still refuses (absent and explicit false), for every profile.
describe('T1 interactive grok-build refusal without its opt-in', () => {
  for (const [profile, opts] of Object.entries(INTERACTIVE_PROFILES)) {
    for (const optIn of [undefined, false]) {
      it(`${profile} with grokInteractiveOptIn=${String(optIn)} refuses`, () => {
        const o = optIn === undefined ? opts : { ...opts, grokInteractiveOptIn: optIn };
        expect(capture(() => buildInteractiveLaunch('grok-build' as never, o as never))).toEqual({ throws: 'grok-interactive-ungated' });
      });
    }
  }
});
