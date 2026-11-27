# Secret store key-name hardening, in plain words

## What this is

Your agent keeps its passwords, tokens and keys in one encrypted file, the secret store. Inside that file, secrets are grouped and found by dotted names, the way a folder path works: `telegram.token` means "the token inside the telegram group".

The code that walks those dotted names trusted every part of the name. In JavaScript, a few special words (`__proto__`, `prototype`, `constructor`) do not name stored data at all. They name the language's own building blocks, which every object in the running program shares. A name containing one of those words could therefore make the store write into that shared machinery instead of into the vault, and could make a read of a built-in word come back with a piece of JavaScript instead of "there is no such secret".

## What already exists

The store already encrypts everything at rest, keeps the key in the operating system's keychain, and only accepts names from the agent's own code and from its own paired machines. So reaching this needed a caller that was already highly trusted. That is why it was rated as hardening rather than an urgent hole.

## What is new

- A write whose name contains one of the three special words is refused with a clear error.
- A read of such a name, or of any built-in name, answers "not found".
- A delete of such a name does nothing.
- The walk follows only keys the vault actually stores, never inherited ones.
- Saving under a group that currently holds an empty value now creates the group instead of crashing.

## What you need to decide

Nothing. No real secret uses those words, so existing secrets read and save exactly as before, and nothing you see changes. If this ever turned out wrong, undoing it is a plain code revert with no data to repair.
