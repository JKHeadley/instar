# Match a Stop callback to the Codex response that caused it

A Codex turn can contain several responses when a project keeps working. Instar needs to know which response caused a Stop callback before it can decide whether to issue another instruction. This change adds the internal lookup for that check. It uses the callback turn and assistant text to find one completed response in the verified local record. If a matching response appears twice or a later response has already finished, the lookup returns no result.

The tests cover a normal callback, identical response text, a late callback from an earlier turn and a record with incomplete framing. The lookup also records the response position, so reused provider IDs cannot make separate records appear identical. This component is still unwired. It does not start workers, change project settings, or enable continuation.
