# Side effects — advisory flag position

- **Behavior change (agent-facing):** `telegram-reply.sh` now exits 2 when
  `--tone-ack|--tone-reason|--tone-complied|--tone-decision-ref|--ack-advisory|--format|--stdin-base64`
  appears AFTER the topic id. Previously such an argument became the message body.
  A caller that RELIED on that accident (sending a literal `--tone-complied …`
  string as a message) now fails loudly. No such caller exists in-tree.
- **Output change:** the `tone-gate-advisory` and DISAGREE lines now print a full
  command including the topic id. Anything parsing those two lines by exact prefix
  would need to re-read them; they are human/agent-facing guidance, not a machine contract.
- **Migration:** the outgoing shipped SHA (`a2cf0215…`) is added to
  `TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS`, so existing agents' copies are backed up and
  overwritten on update rather than left behind with a `.new` candidate.
- **Rollback:** revert the template + the SHA entry; deployed copies revert on the
  next migration by the same SHA-history path.
- **Test surface:** three new cases in `telegram-reply-advisory-script.test.ts`, plus
  a `sendBody` option on the fake-curl shim — which is what makes the 422 advisory
  branches testable at all (they were previously unreachable in that harness).
