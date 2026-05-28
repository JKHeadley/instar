/**
 * `instar relocate` — the one consented command that moves a Documents-resident
 * agent's runtime out of the macOS-26 TCC-locked folder into the safe Library
 * runtime root, and rewrites its launchd plist to match.
 *
 * Spec: docs/specs/macos26-launchd-tcc-runtime-relocation.md (Scope A).
 *
 * This is the user's one-time action for an agent that died before the fix
 * shipped (the b2lead case): running it from a normal terminal IS the consented
 * context that can read the locked files and perform the move. It reuses the
 * tested PostUpdateMigrator.migrateRuntimeRoot orchestrator.
 */

import pc from 'picocolors';
import { loadConfig } from '../core/Config.js';
import { PostUpdateMigrator } from '../core/PostUpdateMigrator.js';

export async function relocateCommand(opts: { dir?: string }): Promise<void> {
  let config;
  try {
    config = loadConfig(opts.dir);
  } catch (err) {
    console.error(pc.red(`Could not load config: ${err instanceof Error ? err.message : err}`));
    process.exit(1);
  }

  if (process.platform !== 'darwin') {
    console.log(pc.yellow('Runtime relocation only applies on macOS (TCC). Nothing to do.'));
    return;
  }

  const hasTelegram = config.messaging?.some((m) => m.type === 'telegram') ?? false;
  const migrator = new PostUpdateMigrator({
    projectDir: config.projectDir,
    stateDir: config.stateDir,
    port: config.port,
    hasTelegram,
    projectName: config.projectName,
  });

  console.log(pc.cyan(`Relocating runtime for "${config.projectName}"…`));
  const result = migrator.relocateRuntimeRootNow();

  for (const u of result.upgraded) console.log(pc.green(`  ✓ ${u}`));
  for (const s of result.skipped) console.log(pc.dim(`  – ${s}`));
  for (const e of result.errors) console.error(pc.red(`  ✗ ${e}`));

  if (result.errors.length > 0) {
    process.exit(1);
  }
  if (result.upgraded.length > 0) {
    // Arm the per-agent escalation credential so the watchdog can autonomously
    // page on future outages (the b2lead bootstrap path: one consented run
    // both recovers AND arms — every death AFTER that pages autonomously).
    try {
      const tg = config.messaging?.find((m) => m.type === 'telegram') as
        | { token?: string; chatId?: string }
        | undefined;
      if (tg?.token && tg?.chatId) {
        const { writeCredential } = await import('../core/EscalationCredential.js');
        const armed = writeCredential(`ai.instar.${config.projectName}`, {
          ownerTopicId: tg.chatId,
          botToken: tg.token,
        });
        if (armed === 'written') {
          console.log(pc.green('  ✓ escalation credential armed — future outages will page you autonomously'));
        }
      }
    } catch { /* non-fatal — relocation already succeeded */ }
    console.log(pc.green('\nDone. Your agent now boots from a location macOS lets launchd reach.'));
    console.log(pc.dim('The launchd job has been re-pointed; it will use the new location on its next start.'));
  } else if (result.skipped.some((s) => s.includes('already relocated'))) {
    console.log(pc.dim('\nAlready relocated — nothing to do.'));
  } else if (result.skipped.some((s) => s.includes('not under a TCC-protected folder'))) {
    console.log(pc.dim('\nThis agent already lives outside a TCC-protected folder — no relocation needed.'));
  }
}
