# Memory hygiene startup trial side effects

The disabled setting `jobs.memoryHygieneProjectIntegrationTrial` measures the legacy scheduled memory hygiene skill job only. Normal baseline mode leaves the launch as-is. Treatment can send a strict empty project integration configuration on supported Claude launch paths. The existing Bash and Skill tool access, model selection, prompt, hooks, schedule, and explicit integration policy stay in effect.

No admission or approval decision is added. Under [Signal vs Authority](../../docs/signal-vs-authority.md), measurements are evidence. Missing prerequisites select the normal launch before spawning, including missing local skill, missing measurement ledger, a confined tool policy, explicit integration policy, or unsupported framework. Any existing launch rejection continues through the ordinary failure path. A second copy could repeat work, so the trial never retries a started session on its own.

The authenticated run history shows the variant and initial observed Claude token event via the recorded session-to-transcript binding. If that binding is unavailable or its state has expired, startup usage is unknown. A replacement transcript can change the currently known binding. The view reads current ledger data and never reports absent telemetry as zero. It uses the existing token ledger's cache fields and does not expose the private binding id in the response.

The historical baseline is six normal runs matched by unique initial job marker and launch time. Median first-request input including cache is 80,496.5 tokens, with a range of 80,168 to 81,147. These are usage counts rather than billed cost. The test fixture supplies synthetic startup usage. No live treatment or savings claim is part of this patch.

Remove the setting to stop collecting. Previously recorded history stays readable while the binding and usage remain retained. Existing non-trial runs preserve their history shape.
