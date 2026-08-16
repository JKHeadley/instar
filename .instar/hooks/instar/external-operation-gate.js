#!/usr/bin/env node
// External operation gate — structural safety for external service operations.
// PreToolUse hook. Intercepts MCP tool calls to external services and evaluates
// risk before allowing execution. Structure > Willpower.
//
// Born from the OpenClaw email deletion incident: an agent deleted 200+ emails
// because nothing distinguished safe reads from destructive bulk deletes.
//
// Uses global fetch() (Node.js 18+) — no CommonJS imports needed.

// Read tool input from stdin
let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', async () => {
  try {
    const input = JSON.parse(data);
    const toolName = input.tool_name || '';

    // Only intercept MCP tools (external service calls)
    if (!toolName.startsWith('mcp__')) {
      process.exit(0); // Not an MCP tool — pass through
    }

    // Extract service name from mcp__<service>__<action>
    const parts = toolName.split('__');
    if (parts.length < 3) {
      process.exit(0); // Malformed MCP tool name — pass through
    }

    const service = parts[1];
    const action = parts.slice(2).join('_');

    // Classify mutability from action name
    let mutability = 'read';
    if (/^(delete|remove|trash|purge|destroy|drop|clear)/.test(action)) {
      mutability = 'delete';
    } else if (/^(send|create|post|write|add|insert|new|compose|publish)/.test(action)) {
      mutability = 'write';
    } else if (/^(update|modify|edit|patch|rename|move|change|set|toggle|enable|disable)/.test(action)) {
      mutability = 'modify';
    }
    // Everything else defaults to 'read' (get, list, search, fetch, check, etc.)

    // Read operations are always safe — fast-path
    if (mutability === 'read') {
      process.exit(0);
    }

    // Classify reversibility
    let reversibility = 'reversible';
    if (/^(send|publish|post|destroy|purge|drop)/.test(action)) {
      reversibility = 'irreversible';
    } else if (/^(delete|remove|trash)/.test(action)) {
      reversibility = 'partially-reversible';
    }

    // Estimate item count from tool_input
    const toolInput = input.tool_input || {};
    let itemCount = 1;
    for (const key of Object.keys(toolInput)) {
      const val = toolInput[key];
      if (Array.isArray(val)) {
        itemCount = Math.max(itemCount, val.length);
      }
    }

    // Build description
    const description = action.replace(/_/g, ' ') + ' on ' + service;

    // Read config (port + auth token) via dynamic import to stay ESM-compatible
    let port = 4321;
    let authToken = '';
    try {
      const nodeFs = await import('node:fs');
      const configPath = (process.env.CLAUDE_PROJECT_DIR || '.') + '/.instar/config.json';
      const raw = nodeFs.readFileSync(configPath, 'utf-8');
      const cfg = JSON.parse(raw);
      port = cfg.port || 4321;
      authToken = cfg.authToken || '';
    } catch { /* use defaults */ }

    // Call the gate API using global fetch (Node 18+)
    const postData = JSON.stringify({
      service,
      mutability,
      reversibility,
      description,
      itemCount,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    try {
      const res = await fetch('http://127.0.0.1:' + port + '/operations/evaluate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + authToken,
        },
        body: postData,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const decision = await res.json();

      if (decision.action === 'block') {
        process.stderr.write('BLOCKED: External operation gate denied this action.\n');
        process.stderr.write('Reason: ' + (decision.reason || 'Operation not permitted') + '\n');
        process.stderr.write('Service: ' + service + ', Action: ' + action + '\n');
        process.exit(2);
      }

      if (decision.action === 'show-plan') {
        const ctx = [
          '=== EXTERNAL OPERATION GATE: APPROVAL REQUIRED ===',
          'Operation: ' + description,
          'Risk: ' + (decision.riskLevel || 'unknown'),
          decision.plan ? 'Plan: ' + decision.plan : '',
          decision.checkpoint ? 'Checkpoint: pause after ' + decision.checkpoint.afterCount + ' items' : '',
          '',
          'Show this plan to the user and get explicit approval before proceeding.',
          'If the user has not approved this specific operation, DO NOT PROCEED.',
          '=== END GATE ===',
        ].filter(Boolean).join('\n');

        process.stdout.write(JSON.stringify({
          decision: 'approve',
          additionalContext: ctx,
        }));
        process.exit(0);
      }

      if (decision.action === 'suggest-alternative' && decision.alternative) {
        process.stdout.write(JSON.stringify({
          decision: 'approve',
          additionalContext: 'External Operation Gate suggests: ' + decision.alternative,
        }));
        process.exit(0);
      }

      // Identity grounding for external write/send/publish operations.
      // Dawn pattern (grounding-enforcement): agents must be grounded in
      // identity before any public-facing action. The gate approved the
      // operation — now inject identity context so the agent writes as itself.
      if ((mutability === 'write' || mutability === 'modify') && reversibility === 'irreversible') {
        const nodeFs = await import('node:fs');
        const agentMdPath = (process.env.CLAUDE_PROJECT_DIR || '.') + '/.instar/AGENT.md';
        let identitySnippet = '';
        try {
          const content = nodeFs.readFileSync(agentMdPath, 'utf-8');
          // Extract first 500 chars of identity for context injection
          identitySnippet = content.slice(0, 500).trim();
        } catch { /* AGENT.md not found — skip identity injection */ }

        if (identitySnippet) {
          const groundingCtx = [
            '=== IDENTITY GROUNDING (pre-' + action.replace(/_/g, ' ') + ') ===',
            '',
            identitySnippet,
            identitySnippet.length >= 500 ? '...' : '',
            '',
            'Verify: Does this ' + action.replace(/_/g, ' ') + ' represent who you are?',
            '=== END GROUNDING ===',
          ].filter(Boolean).join('\n');

          process.stdout.write(JSON.stringify({
            decision: 'approve',
            additionalContext: groundingCtx,
          }));
          process.exit(0);
        }
      }

      process.exit(0);
    } catch {
      clearTimeout(timeout);
      process.exit(0); // Server unreachable or timeout — fail open
    }
  } catch {
    process.exit(0); // Parse error — fail open
  }
});
