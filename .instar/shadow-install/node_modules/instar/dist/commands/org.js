/**
 * `instar intent org-init` — Create ORG-INTENT.md for organizational intent.
 *
 * Generates a template ORG-INTENT.md in the project's .instar/ directory
 * following the three-rule contract:
 *   1. Constraints (mandatory — agents cannot override)
 *   2. Goals (defaults — agents can specialize)
 *   3. Agent identity fills the rest
 */
import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { loadConfig } from '../core/Config.js';
function generateTemplate(orgName) {
    return `# Organizational Intent: ${orgName}

> Shared purpose that all agents in this organization inherit.

## Constraints (Mandatory — agents cannot override)

<!-- Hard boundaries that no agent may cross, regardless of role. -->
<!-- Example: Never share internal data with external parties. -->

## Goals (Defaults — agents can specialize)

<!-- Organizational objectives that agents should pursue unless their role requires specialization. -->
<!-- Example: Prefer thoroughness over speed when quality is measurable. -->

## Values

<!-- Principles that shape how agents represent the organization. -->
<!-- Example: Be transparent about limitations. -->

## Tradeoff Hierarchy

<!-- When goals conflict, this ordering guides resolution. -->
<!-- Example: Safety > Correctness > User Experience > Speed -->
`;
}
export async function orgInit(options) {
    let config;
    try {
        config = loadConfig(options.dir);
    }
    catch (err) {
        console.log(pc.red(`Not initialized: ${err instanceof Error ? err.message : String(err)}`));
        console.log(`Run ${pc.cyan('instar init')} first.`);
        process.exit(1);
        return;
    }
    const orgIntentPath = path.join(config.stateDir, 'ORG-INTENT.md');
    const orgName = options.name || config.projectName;
    if (fs.existsSync(orgIntentPath)) {
        console.log(pc.yellow(`ORG-INTENT.md already exists at ${orgIntentPath}`));
        console.log(pc.dim('To recreate, remove the existing file first.'));
        return;
    }
    // Ensure the state directory exists
    if (!fs.existsSync(config.stateDir)) {
        fs.mkdirSync(config.stateDir, { recursive: true });
    }
    const content = generateTemplate(orgName);
    fs.writeFileSync(orgIntentPath, content);
    console.log(pc.green(`Created ORG-INTENT.md at ${orgIntentPath}`));
    console.log();
    console.log(pc.dim('Edit this file to define organizational constraints, goals, and values.'));
    console.log(pc.dim('Then run `instar intent validate` to check agent alignment.'));
}
//# sourceMappingURL=org.js.map