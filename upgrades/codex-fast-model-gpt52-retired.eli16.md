# Codex fast-model fix (gpt-5.2 retired) — ELI16

Viewable private artifact:
https://echo.dawn-tunnel.dev/view/7bc3a2fc-512a-4d1a-b038-725e253145e9?sig=80a2a9cad2adf1d5871bf3611dd6a3b298c07997b7927a730faae64d09193745

Every Codex-powered agent makes lots of small, cheap behind-the-scenes AI calls — spotting a
promise it made, keeping its tone plain, sorting a message. To keep those cheap, they all ran
on a lightweight model called **gpt-5.2**.

On June 3, OpenAI quietly **stopped allowing gpt-5.2** on the ChatGPT-subscription kind of
account these agents use. From that moment every one of those cheap calls started failing with
a flat error — so, for example, Codey could no longer detect the commitments it makes, all day,
silently.

The model name was **hardcoded in two places**, so this fix updates both to point at the
cheapest model that still works on the account: **gpt-5.4-mini**. The agents work again
immediately.

The one catch, called out honestly: gpt-5.2 was the only *non-thinking* (cheapest) model. The
replacement is a small *thinking* model, which costs more per call. There was no cheaper option
left, so this trades a bit more usage for actually working. A follow-up will make this self-heal
— when a model gets retired, the agent will automatically fall back to a working one instead of
breaking.

_Patch fix · branch `echo/codex-fast-model-retire` · found by scanning live fleet logs (the
see-what-breaks loop) and empirically re-probing which models the account still accepts._
