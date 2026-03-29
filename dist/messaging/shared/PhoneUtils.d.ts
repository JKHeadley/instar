/**
 * PhoneUtils — International phone number handling for WhatsApp.
 *
 * Normalizes phone numbers to E.164 format and handles WhatsApp JID
 * conversion. Lightweight implementation without external dependencies.
 *
 * E.164: +[country code][subscriber number], e.g. +14155552671
 * WhatsApp JID: [number]@s.whatsapp.net, e.g. 14155552671@s.whatsapp.net
 */
/**
 * Normalize a phone number to E.164 format.
 *
 * Strips whitespace, dashes, parentheses. Ensures + prefix.
 * Extracts number from WhatsApp JID format if needed.
 *
 * @throws Error if the input is empty after stripping
 */
export declare function normalizePhoneNumber(input: string): string;
/**
 * Convert a phone number to WhatsApp JID format.
 * +14155552671 -> 14155552671@s.whatsapp.net
 */
export declare function phoneToJid(phone: string): string;
/**
 * Extract a phone number from a WhatsApp JID.
 * 14155552671@s.whatsapp.net -> +14155552671
 *
 * Returns null if the input doesn't look like a JID.
 */
export declare function jidToPhone(jid: string): string | null;
/**
 * Check if a string looks like a WhatsApp JID.
 */
export declare function isJid(input: string): boolean;
/**
 * Check if a JID is a LID (Linked Identity) JID.
 * LID JIDs don't contain real phone numbers — they use WhatsApp's internal ID.
 */
export declare function isLidJid(input: string): boolean;
/**
 * Check if a JID is a group JID.
 */
export declare function isGroupJid(input: string): boolean;
//# sourceMappingURL=PhoneUtils.d.ts.map