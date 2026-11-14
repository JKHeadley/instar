# Side effects: owner phone reads Slack history held by another machine

Change: `GET /mobile/chat/slack/:id/messages` forwards a named nonlocal machine for a current owner phone through `buildSlackHolderRead`; a token read with `deviceView=1` answers in the phone's shape.

1. Over-block: an older holder is refused (502 `holder-outdated`) until it updates. MSP phones with a Slack grant still get 409.
2. Under-block: a revocation after the last check and before the socket write is not covered, the same as a local read. Attachments on remote rows do not download yet.
3. Level fit: the route owns the machine rule, so the branch sits there; transport stays in the existing pool fetch and URL guard.
4. Signal vs authority: fixed owner and trust checks; no brittle judgment holds authority. See docs/signal-vs-authority.md.
5. Interactions: poolPeerFetch may try fallback ropes on a dead dial, each through the default guard. `deviceView=1` adds nothing for a device caller. Rate limits are the device rule already on this route, plus 8 reads in flight, 4 per holder.
6. External surfaces: new 502/503/504 holder codes on this route for the owner phone. Old apps show them as a failed load. No send path changes.
7. Multi-machine posture: proxied-on-read through resolvePeerUrls; no state; machine-local nothing.
8. Rollback: revert the commit; the route returns to 409.

## Second-pass review

**Reviewer:** claude-code clean-door read (claude-opus-5-5, same family) and codex-cli gpt-6-astra, both MINOR ISSUES
**Independent read of the artifact: concur, with findings fixed**

The clean-door read's design points: per-rope budget stays a stated limit; the shape test now covers a server path. Precision points fixed: third-machine test, MSP with a grant, `holder-outdated`, failure reporting, per-holder cap. No subagent reviewer ran, because a fork cannot spawn one. No reviewer re-read the last comment and wording edits.
