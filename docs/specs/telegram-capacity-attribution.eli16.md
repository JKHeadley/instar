# Explain Why a Telegram Update Is Waiting

Some project progress replies have been delayed because the system recorded that it could not obtain permission to start a Telegram send. The existing record does not explain which part failed. A temporary permission may have expired, the local connection to the credential owner may have failed, the machine may no longer have held the lead, or the shared rate window may have been full. Those possibilities require different repairs.

This change records what the actual attempt observed. It measures how long reserving and consuming permission took and keeps the owner's answer separate from the caller's checks. If a reply from the owner is lost, it says that the answer is unknown. It does not falsely claim that the owner refused. If the owner consumed permission successfully but the caller then found that its deadline had passed, both facts remain visible.

These diagnostics cannot grant permission, send another message or change when a retry happens. The existing rate limits, lease checks, one-use permissions and retry calculations remain unchanged. Old and new software can use the same local protocol, so adding explanations does not block an otherwise valid send. No message text, credentials or permission secret is copied into the diagnostic record.

The evidence belongs to the same stored attempt as the delivery result. If storing the optional evidence fails, a fixed unavailable status distinguishes that failure from an older attempt without diagnostics. The actual delivery result still follows its existing safe recording rules. Readback and archive records retain the status where supported; an older rolled-back writer may omit new diagnostic details, which is a disclosed limit.

The delayed Windows reply already recovered through the normal automatic queue. That does not establish why its earlier attempts failed. This work first makes the next failure explainable. The actual cause still needs observed evidence before a separate repair is chosen, and neither a local test nor shipping diagnostics means delivery is proven restored everywhere.

The owner now sends its own clock reading with each decision. If the caller closes after the owner consumes a grant, the record can show when the owner decided and why the caller still stopped before contacting Telegram. Timestamps help explain delays. They confer no permission to send.
