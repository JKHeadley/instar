# Dashboard Headless Gemini Framework — ELI16

The short version: the dashboard already had a way to start headless sessions, and the core session launcher already knew how to start Gemini, but the dashboard route still had an older two-framework checklist that rejected Gemini before the request reached the working launcher.

This change lines those two pieces up. If the dashboard asks for a headless Gemini session, the request is now treated as a valid request and passed to the same session manager path that already handles framework-specific launching. Claude and Codex behavior is not changed; their accepted framework names and model names stay the same.

There is one important boundary here. The dashboard route is allowed to reject malformed request shapes, but it should not have its own outdated idea of which frameworks exist. The deeper session launcher is the place that owns how each framework actually starts. So the route now recognizes Gemini as one of the supported framework names and uses the Gemini adapter's known model list when it validates a Gemini request.

The safeguard is that this does not turn the route into a free-form model passthrough. Generic model tiers still work, and known Gemini model ids work, but random Gemini-looking strings are still rejected at the route boundary. That keeps the fix narrow: it repairs the false rejection that blocked real dashboard Gemini usage without widening the API beyond the models Instar currently knows how to reason about.

The tests prove the route-level behavior directly. One test sends a dashboard-style Gemini spawn request and checks that the session manager receives the Gemini framework and model. Another checks that a bad framework is still rejected and that the error text now names Gemini as a valid framework. A third checks that the Gemini model id used by the adapter is accepted for Gemini requests.

What reviewers need to decide is whether this route should now match the shipped framework set rather than continuing to reject Gemini at the dashboard boundary. The implementation keeps that decision small and reversible.
