# Comparison protocol corrections

Preparation only. No model calls, source changes, or activation.

The saved development replay protocol is incomplete: its padding control does not satisfy obligation 1 of the approved context-safety article. Before running trials, the runner must implement all of the following.

1. Compare no task-specific context, reduced context, and full context on the same decisions. Keep the task question, raw scenario evidence, clock, model, access route and enforced tool boundary fixed. The no-context arm omits the context being evaluated; it retains mandatory safety and identity. Record exactly what each arm receives and why the control isolates that reduction.
2. Repeat full-context trials to establish ordinary variation. Repeat paired trials; predeclare acceptable loss, critical cases, uncertainty method and stopping criteria before scoring. Padding may be an additional diagnostic, never a replacement for these controls.
3. Do not count a case that no-context solves as reliably as full context as evidence of retained context. Preserve all results, including harm below no-context and full-context failures. Grade critical failures separately.
4. The sixteen visible development cases cannot qualify adoption. Separate unseen cases must be collected and their expected decisions fixed before tuning. Use recorded real inputs where available, with local retention and authorized judge access.
5. A proposed replay runner must expose only an in-memory fixture lookup and a captured final answer. It must structurally deny filesystem access, shell execution, secret reads, network requests and message sends; prompt instructions alone do not establish this boundary. Test attempted forbidden effects before model trials.
6. Resolve the fourteen-day definition and timestamp normalization before labels are treated as authoritative. The existing fixture labels propose elapsed time; the actual relationship manager uses local calendar arithmetic. Daylight-saving and offset cases need explicit treatment.
7. Include context assembly, tool results, checks, repeats, judging, retries and fallback in measured completed-task cost. Keep recurring serving cost and one-time qualification cost separately visible, and report the combined cost over a declared horizon. Record exact model, harness, account route, hashes and evidence age.

The existing development fixture remains unchanged as a record of preparation. This note supersedes its replayProtocol.arms and supplements the readiness gaps. Claude-specific trials still await the applicable usage constraint and release verification. The two source candidates remain frozen in coordinator custody.
