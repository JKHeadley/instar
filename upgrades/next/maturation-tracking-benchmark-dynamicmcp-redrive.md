# Three switched-off features now keep a record

## What Changed
The benchmark divergence analyzer, Dynamic MCP and collaboration re-drive now write evidence rows when they act, hold back or fail, so the maturation ladder can judge them on what they did. The benchmark row names its data date, machines and models. Routine skips write nothing and repeating conditions write at most once a day, so they cannot hide a real error rate. No feature behaviour, threshold, flag or default changed.

## What to Tell Your User
Nothing changes in how your agent behaves. Three features that are not fully on yet now keep a record of what they do, so their readiness can be judged on evidence.

## Summary of New Capabilities
- The maturation ladder can now measure benchmark divergence, Dynamic MCP and collaboration re-drive once each one runs.

## Evidence
Unit: tests/unit/BenchmarkDivergenceAnalyzer.test.ts, tests/unit/dynamic-mcp-service.test.ts, tests/unit/CollaborationRedriveEngine.test.ts. HTTP: tests/integration/maturation-ladder-route.test.ts. No live run: Dynamic MCP and re-drive are off and the benchmark job is disabled on the development agent.
