# Hiding the whole API key in the live tail — plain overview

When one of your machines shares its live activity feed with your other machines, it first scrubs out anything that looks like a password or API key. That scrubber had a blind spot. It only recognised keys that start with "sk-" followed straight away by a long run of letters and numbers. Modern keys do not look like that anymore. Anthropic keys start with something like "sk-ant-api03-" and OpenAI project keys start with "sk-proj-". Because of the extra short word and hyphen near the front, the scrubber did not recognise them at all, and the entire key could travel to your other machines in plain text.

This change teaches the scrubber the modern shapes: the Anthropic family (api, admin, and sign-in tokens, which always carry a number in the prefix), the OpenAI project, service-account and admin forms, and OpenRouter keys. When one appears, the whole key is replaced with a short placeholder that says an API key was removed.

We were careful not to hide normal writing. Words that happen to start with "sk-", such as "sk-learn-compatible-estimators", or long hyphenated names like "task-proj-migration-checklist", are left alone. Tests check both sides: real-looking keys disappear completely, and ordinary hyphenated text stays exactly as written.

The same blind spot existed in a few neighbouring helpers that clean text before it is sent to an outside model or shown in a summary, so those were fixed the same way. An existing check that compares all these helpers now includes the live-tail scrubber too, so the copies cannot quietly drift apart again.

Nothing for you to do. If this ever needed undoing, it is a single code change to revert, with no stored data affected.
