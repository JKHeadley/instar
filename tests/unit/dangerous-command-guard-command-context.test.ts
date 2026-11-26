import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { refreshHooksAndSettings } from '../../src/commands/init.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SQL_COMMAND_CONTEXT_CHECK } from '../../src/core/sqlCommandContext.js';

const SQL = ['DELETE', 'FROM', 'records'].join(' ');
let dir: string;
const scripts: Record<string, string> = {};
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-context-'));
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'guard-context', port: 4343, safety: { level: 1 } }));
  refreshHooksAndSettings(dir, stateDir);
  scripts.init = path.join(stateDir, 'hooks', 'instar', 'dangerous-command-guard.sh');
  const migrator = new PostUpdateMigrator({ stateDir, projectDir: dir, port: 4343, sessions: { claudePath: 'claude' } } as never);
  scripts.updated = path.join(dir, 'updated.sh');
  fs.writeFileSync(scripts.updated, (migrator as unknown as { getDangerousCommandGuard(): string }).getDangerousCommandGuard());
  scripts.template = path.join(dir, 'template.sh');
  fs.copyFileSync(path.resolve(import.meta.dirname, '../../src/templates/hooks/dangerous-command-guard.sh'), scripts.template);
});
afterAll(() => { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'command-context guard fixture cleanup' }); });

function run(writer: string, command: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', [scripts[writer], command], { cwd: dir, encoding: 'utf8', timeout: 10_000, env: { ...process.env, RIPGREP_CONFIG_PATH: '', BASH_ENV: '', ENV: '', CLAUDE_PROJECT_DIR: dir, ...extraEnv } });
}

describe.each(['init', 'updated', 'template'])('%s SQL command context', (writer) => {
  it.each([
    `rg -n '${SQL}' src`,
    `grep -R "${SQL}" src`,
    `printf '%s\\n' '${SQL}' > source.ts`,
    `cat <<'SOURCE' > source.ts\nconst query = "${SQL}";\nSOURCE`,
    `python3 -c 'from pathlib import Path; Path("source.ts").write_text("${SQL}")'`,
    `python3 <<'PY'\nfrom pathlib import Path\nPath("source.ts").write_text("${SQL}")\nPY`,
    `rg '${SQL}' src && printf '%s' done`,
    `sh -c "rg '${SQL}' src"`,
    `rg '${SQL}' src | head`,
    `python3 -c 'from pathlib import Path; p = Path("source.ts"); text = "${SQL}"; p.write_text(text)'`,
    `rg '$(sqlite3 fixture.db "${SQL}")' src`,
    `'rg' -n '${SQL}' src`,
    `'r''g' -n '${SQL}' src`,
  ])('allows literal data arguments: %s', (command) => {
    const result = run(writer, command);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('BLOCKED');
    // The guard inspects the command; it must never execute its contents.
    expect(fs.existsSync(path.join(dir, 'source.ts'))).toBe(false);
  });

  it.each([
    `sqlite3 fixture.db '${SQL}'`,
    `printf '%s' '${SQL}' | psql fixture`,
    `sh -c "sqlite3 fixture.db '${SQL}'"`,
    `rg "$(sqlite3 fixture.db '${SQL}')" src`,
    `rg --pre "sqlite3 fixture.db '${SQL}'" src`,
    `rg '${SQL}' src; sqlite3 fixture.db '${SQL}'`,
    `cat <<'SOURCE'\nliteral text\nSOURCE\nsqlite3 fixture.db '${SQL}'`,
    `python3 -c 'import sqlite3; sqlite3.connect("fixture.db").execute("${SQL}")'`,
    `rg --hostname-bin "sqlite3 fixture.db '${SQL}'" src`,
    `rg --pre="sqlite3 fixture.db '${SQL}'" src`,
    `rg pattern <(sqlite3 fixture.db '${SQL}')`,
    `python3 -c 'from pathlib import Path; import sqlite3; Path = sqlite3.connect("fixture.db"); Path.execute("${SQL}")'`,
    `python3 -c 'from pathlib import Path; Path = other; Path("source.ts").write_text("${SQL}")'`,
    `python3 -c 'from somewhere import Path; Path("source.ts").write_text("${SQL}")'`,
    `rg "${SQL}`,
    `RIPGREP_CONFIG_PATH=config rg '${SQL}' src`,
    `rg $FLAGS '${SQL}' src`,
    `rg "$FLAGS" '${SQL}' src`,
    `rg --pre$EMPTY '${SQL}' src`,
    `rg * '${SQL}' src`,
    `rg '${SQL}' src # note\nsqlite3 fixture.db '${SQL}'`,
    `rg '${SQL}' src |& sqlite3 fixture.db '${SQL}'`,
    `cat <<'EOF'${String.fromCharCode(11)}\nliteral\nEOF${String.fromCharCode(11)}\nsqlite3 fixture.db '${SQL}'\nEOF`,
    `cat <<'EOF'foo\nliteral\nEOFfoo\nsqlite3 fixture.db '${SQL}'\nEOF`,
    `'rg'evil '${SQL}' src`,
    `"|" rg '${SQL}' src`,
    `printf -v RIPGREP_CONFIG_PATH '%s' config; rg '${SQL}' src`,
    `zsh -c "rg '${SQL}' src"`,
  ])('retains SQL protection for execution or unknown programs: %s', (command) => {
    const result = run(writer, command);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('BLOCKED');
    expect(fs.existsSync(path.join(dir, 'fixture.db'))).toBe(false);
  });

  it('uses executable fields in positional JSON rather than description text', () => {
    expect(run(writer, JSON.stringify({ command: `rg '${SQL}' src` })).status).toBe(0);
    expect(run(writer, JSON.stringify({ cmd: `sqlite3 fixture.db '${SQL}'` })).status).toBe(2);
    expect(run(writer, JSON.stringify({ description: `sqlite3 fixture.db '${SQL}'` })).status).toBe(0);
    expect(run(writer, JSON.stringify({ command: `rg '${SQL}' src`, cmd: `sqlite3 fixture.db '${SQL}'` })).status).toBe(2);
    expect(run(writer, JSON.stringify({ command: `rg '${SQL}' src`, tool_input: { cmd: `sqlite3 fixture.db '${SQL}'` } })).status).toBe(2);
  });

  it('retains the original SQL protection when the context classifier fails', () => {
    const shimDir = path.join(dir, `failed-python-${writer}`);
    fs.mkdirSync(shimDir);
    const python = spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim();
    expect(python).not.toBe('');
    fs.writeFileSync(path.join(shimDir, 'python3'), `#!/bin/sh\nif [ "$1" = "-" ]; then exit 7; fi\nexec '${python.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
    expect(run(writer, `rg '${SQL}' src`, { PATH: `${shimDir}${path.delimiter}${process.env.PATH}` }).status).toBe(2);
  });

  it('installs the byte-identical context classifier', () => {
    expect(fs.readFileSync(scripts[writer], 'utf8')).toContain(SQL_COMMAND_CONTEXT_CHECK);
  });

  it('retains matching when tool or shell startup configuration is inherited', () => {
    expect(run(writer, `rg '${SQL}' src`, { RIPGREP_CONFIG_PATH: 'fixture-config' }).status).toBe(2);
    const startup = path.join(dir, `startup-${writer}.sh`);
    fs.writeFileSync(startup, '# safe fixture startup\n');
    expect(run(writer, `sh -c "rg '${SQL}' src"`, { BASH_ENV: startup }).status).toBe(2);
  });

  it('preserves level-two self-verification for executable SQL', () => {
    const configPath = path.join(dir, '.instar', 'config.json');
    const original = fs.readFileSync(configPath, 'utf8');
    try {
      const config = JSON.parse(original);
      config.safety = { level: 2 };
      fs.writeFileSync(configPath, JSON.stringify(config));
      const search = run(writer, `rg '${SQL}' src`);
      expect(search.status).toBe(0);
      expect(search.stdout).not.toContain('SELF-VERIFICATION');
      const execute = run(writer, `sqlite3 fixture.db '${SQL}'`);
      expect(execute.status).toBe(0);
      expect(execute.stdout).toContain('SELF-VERIFICATION');
    } finally { fs.writeFileSync(configPath, original); }
  });
});
