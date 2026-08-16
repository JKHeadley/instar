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
export function normalizePhoneNumber(input) {
    if (!input || typeof input !== 'string') {
        throw new Error('Phone number is required');
    }
    // Extract from JID format first
    let number = input.replace(/@.*$/, '');
    // Strip formatting characters
    number = number.replace(/[\s\-\(\)\.\u2013\u2014]/g, '');
    // Strip international dialing prefix (00, 011)
    if (number.startsWith('00')) {
        number = '+' + number.slice(2);
    }
    else if (number.startsWith('011')) {
        number = '+' + number.slice(3);
    }
    // Ensure + prefix
    if (!number.startsWith('+')) {
        // If it's 10 digits, assume US/Canada (+1)
        if (/^\d{10}$/.test(number)) {
            number = '+1' + number;
        }
        else if (/^\d{11,}$/.test(number)) {
            number = '+' + number;
        }
        else {
            number = '+' + number;
        }
    }
    // Validate: must be + followed by digits only
    if (!/^\+\d{7,15}$/.test(number)) {
        throw new Error(`Invalid phone number format: ${input}`);
    }
    return number;
}
/**
 * Convert a phone number to WhatsApp JID format.
 * +14155552671 -> 14155552671@s.whatsapp.net
 */
export function phoneToJid(phone) {
    const normalized = normalizePhoneNumber(phone);
    // Strip the + prefix for JID
    return normalized.slice(1) + '@s.whatsapp.net';
}
/**
 * Extract a phone number from a WhatsApp JID.
 * 14155552671@s.whatsapp.net -> +14155552671
 *
 * Returns null if the input doesn't look like a JID.
 */
export function jidToPhone(jid) {
    if (!jid)
        return null;
    // LID JIDs (Linked Identity, e.g. 272404173598970@lid) don't contain real
    // phone numbers — the digits are an opaque WhatsApp internal ID.
    // Return null so callers know they need special handling.
    if (jid.endsWith('@lid'))
        return null;
    // Handle both JID format and plain numbers
    const match = jid.match(/^(\d+)@/);
    if (match) {
        return '+' + match[1];
    }
    // If it's just digits (no @), treat as phone number
    if (/^\+?\d{7,15}$/.test(jid.replace(/[\s\-\(\)]/g, ''))) {
        try {
            return normalizePhoneNumber(jid);
        }
        catch {
            return null;
        }
    }
    return null;
}
/**
 * Check if a string looks like a WhatsApp JID.
 */
export function isJid(input) {
    return /@s\.whatsapp\.net$/.test(input) || /@g\.us$/.test(input) || /@lid$/.test(input);
}
/**
 * Check if a JID is a LID (Linked Identity) JID.
 * LID JIDs don't contain real phone numbers — they use WhatsApp's internal ID.
 */
export function isLidJid(input) {
    return /@lid$/.test(input);
}
/**
 * Check if a JID is a group JID.
 */
export function isGroupJid(input) {
    return /@g\.us$/.test(input);
}
//# sourceMappingURL=PhoneUtils.js.map