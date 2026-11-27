# Test results from a helper machine are signed, and cannot keep "main is fine" going on their own (ELI16)

Before code is merged, the agent runs the full test suite on its own machines ("Local Verify"). The machine in charge can hand a test run to a helper machine and then collect the answer. When the shared main branch passes, the machine in charge treats main as healthy, and merges continue. If main ever fails, merges stop until it is fixed.

The answer from the helper was trusted on its word. Anything that could answer at the helper's network address could send back "passed", and a broken or compromised helper could say "passed" without running anything. A fake pass on main could keep merges flowing onto broken code, and it could also list test files as "flaky", which loosens how failures in other changes are judged.

Two changes. First, the helper signs its answer with its own machine key, and the machine in charge checks that signature against the key it already knows for that helper. An unsigned or wrongly signed answer is thrown away and the tests run locally instead. Second, a helper's pass on main is allowed to do less: it never sets the "flaky" list, and it can only keep main counted as healthy for a limited time after the machine in charge last ran main itself. Before that time runs out, the machine in charge runs main on its own. If its own run fails where a helper said "passed", that helper stops getting main runs and the owner is told.

This feature is off by default, so most agents see no change.
