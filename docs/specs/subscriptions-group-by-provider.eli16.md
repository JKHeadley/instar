# Grouping the accounts list by provider

## What this is

A small change to how the Subscriptions tab lists your accounts: all your Claude accounts
together, all your Codex accounts together, each under a heading.

## Why

Right now the list is one flat run of cards in whatever order the accounts were enrolled, so
a Codex account can sit between two Claude ones. Each card does say which provider it belongs
to, but in small text partway down, so telling them apart means reading every card. With one
provider that was fine. With two it stopped being fine, which is what prompted this.

## What it does and does not change

It changes the ORDER things are drawn in, and adds a heading above each group. It does not
change any card, any number, or any quota bar. The quota bars live inside the account cards,
so grouping the accounts groups the quota view with them.

Two choices are worth naming because they could have gone the other way:

**Accounts keep their existing order inside each group.** Nothing is sorted alphabetically.
The order accounts arrive in carries meaning the dashboard cannot see — which was enrolled
first, which one is the default — so the change re-associates them without re-ranking them.

**If you only have one provider, nothing appears at all.** No heading, no change, identical to
before. A heading saying "Claude" above a list of only Claude accounts is noise. Most installs
have one provider, so the common case is deliberately untouched. There is a test holding that
line, because a change described as "group everything" would naturally add the redundant
heading and nobody would notice.

## Safety

The heading is the one new piece of text reaching the page, and it goes through the same
cleaning every other value on that tab already uses — the provider name is written as plain
text, so a malformed or hostile provider string cannot become markup. A test plants a hostile
one and confirms no live element survives.

An account whose provider is missing is still shown, under a heading that says Other rather
than being silently dropped or filed under a provider it does not belong to.

## What you would notice

Your accounts list gets two headings instead of none, and the Codex account stops sitting in
the middle of the Claude ones.
