## What Changed

- Alerts now name the conversation and the machine they are about, instead of their internal numbers. "Topic 28730's pin has waited…" becomes 'Topic "Release notes"'s pin has waited…', and "Machine m_cc2e… is flapping" becomes "Mac Mini is flapping". This is applied where every alert is created, so all alerts get it. An open alert whose wording only changes this way is not sent again.

## What to Tell Your User

Alerts now say which conversation or machine they mean by name, not by number or code.

## Evidence

- A live agent had open alerts titled "Topic 28730's pin has waited 2892h unfulfilled", "Machine m_cc2ec651… is flapping" and "Conversation telegram:61449 keeps re-duplicating". Unit tests cover naming each shape, leaving unknown ids alone, and an existing alert being renamed without a second post.

## Summary of New Capabilities

None. This changes the wording of existing alerts.
