# Side-effects review for public context replay capture

A manual diagnostic starts a single model turn at a time using the operator-selected stored subscription login. Input is limited to the checked-in public fixture and exact example instructions. Reference answers stay outside the capture interface. No endpoint, job or startup trigger invokes the script.

1. **Over-block.** Unverified stream setup, failed authentication, model action evidence and mismatched plan data halt capture. This is a manual evaluation and can be retried with a known valid route.
2. **Under-block.** Native startup selects zero tools, empty MCP, no settings or hooks, no slash commands, one turn and no session persistence. A positive public denial probe is required before sending trial inputs.
3. **Abstraction.** The existing replay module validates the grid and final answer shape. The adapter collects bounded native results and measured usage for review. Each captured answer also records a parse outcome: valid, json-parse-failed, or schema-invalid with the validator's own fixed short reason, capped at 120 characters. The outcome never copies answer text. The grader reads only the id and actions fields, so the extra field cannot change a score.
4. **Signal and authority.** Capture cannot qualify or activate a model. Its checks control only this explicit manual invocation.
5. **Interactions.** Captures use a fresh scratch directory and bounded sequential turns. An existing receipt is preserved by exclusive file creation. A partial capture is not a complete comparison.
6. **External surfaces.** An explicit invocation uses Anthropic inference on the selected authorized subscription and may consume quota. The fixed fixture is public. No bearer token or raw CLI response is written to the report.
7. **Multiple machines.** Login resolution happens on the machine hosting the account, and data remains in the caller-selected local receipt.
8. **Rollback.** Remove the script or revert the commit. There is no activation or state migration.
