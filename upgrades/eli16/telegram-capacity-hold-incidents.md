# Show when a Telegram reply is waiting for send capacity

Echo sometimes has to hold a reply briefly because the process that sends Telegram messages is restarting or cannot grant a send slot. The reply stays in the existing queue, which retries the same operation. Previously the incident view counted replies held by a lease check, but it omitted replies held by the credential capacity check. That made a conversation look clear even while its reply was still waiting.

This change records the capacity hold under the original operation. If Telegram later accepts the reply, the existing receipt closes the incident and records the delivery time. The change adds visibility only. It uses the existing retry schedule and leaves the credential and lease checks in place.
