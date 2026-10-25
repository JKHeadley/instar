# Codex light checks move to gpt-6-luna — ELI16

Instar runs a lot of small background checks: is a session stuck, does an
outgoing message read well, what is this conversation about. On agents that use
Codex, each check is a quick call to an OpenAI model, and the code decides which
model by "tier": light, medium or heavy. Until now the light and medium tiers both
pointed at gpt-5.6-sol, the cheapest model that still worked after OpenAI retired
the older ones in September. The operator asked for the light work to run on
gpt-6-luna, the small model of the newer GPT-6 family, and for nothing to stay on
the 5.6 generation where a GPT-6 model can do the job.

What changes: light becomes gpt-6-luna, medium becomes gpt-6-sol, heavy stays
gpt-6-astra. That is the whole behavior change. About sixty of the background
checks ask for the light tier, so they all move together.

What already exists and is reused: a safety net. When OpenAI refuses a model on
a ChatGPT account, Codex answers with one specific error, and Instar already
catches that error and retries once on a known-good "floor" model. That matters
here because the new models need a recent Codex program: version 0.153 refuses
both gpt-6-luna and gpt-6-sol with exactly that error. So the floor is kept on
gpt-5.6-sol on purpose. An agent whose Codex is out of date keeps running its
background checks on the old model instead of failing, and moves to luna by
itself once Codex is updated. A new test feeds that exact refusal text through
the error check and confirms it triggers the retry.

What does not have a safety net: full Codex sessions (a chat or a scheduled job
running inside Codex). Those launch with the model named up front and cannot
retry. On an old Codex they will say the model is unsupported, and the fix is to
update Codex. The release note says this plainly.

What the reader needs to decide: nothing beyond the operator's direction already
given. The risk is limited to agents with an outdated Codex program, and even
there the background checks keep working.
