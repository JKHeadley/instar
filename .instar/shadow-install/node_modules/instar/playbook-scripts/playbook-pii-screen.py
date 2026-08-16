#!/usr/bin/env python3
"""
Playbook PII Screening — screens proposed deltas for personal data.

Part of Playbook Phase 2 (context-engineering-integration spec, Section 3.10).

Screens delta payloads for PII patterns before they enter the manifest.
Called by the lifecycle pipeline during delta validation.

Patterns detected:
  - Email addresses
  - Phone numbers
  - IP addresses
  - API keys / tokens (long hex/base64 strings)
  - URLs with embedded credentials

Does NOT use LLM detection (deterministic only, per security model).

Usage:
    python3 playbook-pii-screen.py check '<json_delta>'
    python3 playbook-pii-screen.py scan-file <path>

Library usage:
    from playbook_pii_screen import screen_delta, screen_text
    result = screen_delta(delta_dict)
    findings = screen_text("some text to check")
"""

import json
import os
import re
import sys

# PII detection patterns (deterministic, no LLM)
PII_PATTERNS = {
    "email": re.compile(
        r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b'
    ),
    "phone_us": re.compile(
        r'\b(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b'
    ),
    "ip_address": re.compile(
        r'\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b'
    ),
    "api_key_hex": re.compile(
        r'\b(?:sk-|pk-|api[_-]?key[=:]\s*)[a-zA-Z0-9_-]{20,}\b'
    ),
    "long_secret": re.compile(
        r'\b[A-Za-z0-9+/=]{40,}\b'  # Base64 or hex strings > 40 chars
    ),
    "credential_url": re.compile(
        r'https?://[^:]+:[^@]+@'  # URLs with embedded user:pass
    ),
    "ssn_like": re.compile(
        r'\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b'
    ),
}

# Allow-list patterns that look like PII but aren't
ALLOWLIST = [
    re.compile(r'sha256:[a-f0-9]{64}'),          # Content hashes
    re.compile(r'delta-[a-f0-9]{12}'),             # Delta IDs
    re.compile(r'/context/[a-z]+/[a-z0-9/-]+'),    # Item paths
    re.compile(r'AUT-\d+-wo'),                      # Session IDs
    re.compile(r'dawn@sagemindai\.io'),             # Dawn's own email
    re.compile(r'noreply@anthropic\.com'),          # Anthropic noreply
    re.compile(r'\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/\d+'),  # CIDR notation
]


def _is_allowlisted(match_text, full_text=None, match_start=0):
    """Check if a match is in the allow-list.

    Checks both the match text itself and a window of surrounding context,
    because some allowlist patterns (e.g., sha256:xxx) include a prefix
    that won't appear in the PII regex match alone.
    """
    for pattern in ALLOWLIST:
        if pattern.search(match_text):
            return True
    # Check surrounding context (prefix + match) for patterns like sha256:xxx
    if full_text and match_start > 0:
        context_start = max(0, match_start - 10)
        context = full_text[context_start:match_start + len(match_text)]
        for pattern in ALLOWLIST:
            if pattern.search(context):
                return True
    return False


def screen_text(text):
    """
    Screen text for PII patterns.

    Returns list of findings: [{"type": "email", "match": "...", "position": N}]
    """
    if not text:
        return []

    findings = []
    for pii_type, pattern in PII_PATTERNS.items():
        for match in pattern.finditer(text):
            match_text = match.group()
            if not _is_allowlisted(match_text, text, match.start()):
                findings.append({
                    "type": pii_type,
                    "match": match_text[:20] + "..." if len(match_text) > 20 else match_text,
                    "position": match.start(),
                })
    return findings


def screen_delta(delta):
    """
    Screen a delta for PII in payload content.

    Returns dict with:
        - has_pii: bool
        - findings: list of PII detections
        - fields_checked: list of field paths checked
    """
    findings = []
    fields_checked = []

    payload = delta.get("payload", {})

    # Check content fields
    content_fields = ["content_inline", "description", "insight", "reason"]
    for field in content_fields:
        value = payload.get(field, "")
        if isinstance(value, str) and value:
            fields_checked.append(f"payload.{field}")
            field_findings = screen_text(value)
            for f in field_findings:
                f["field"] = f"payload.{field}"
            findings.extend(field_findings)

    # Check tags
    tags = payload.get("tags", {})
    for tag_type in ("domains", "qualifiers"):
        for tag in tags.get(tag_type, []):
            if isinstance(tag, str):
                tag_findings = screen_text(tag)
                for f in tag_findings:
                    f["field"] = f"payload.tags.{tag_type}"
                findings.extend(tag_findings)

    # Check evidence values
    for ev in delta.get("evidence", []):
        value = ev.get("value", "")
        if isinstance(value, str):
            fields_checked.append("evidence[].value")
            ev_findings = screen_text(value)
            for f in ev_findings:
                f["field"] = "evidence[].value"
            findings.extend(ev_findings)

    return {
        "has_pii": len(findings) > 0,
        "findings": findings,
        "fields_checked": fields_checked,
    }


def screen_file(filepath):
    """Screen a file for PII."""
    with open(filepath, "r", errors="replace") as f:
        content = f.read()
    return screen_text(content)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "check" and len(sys.argv) >= 3:
        delta = json.loads(sys.argv[2])
        result = screen_delta(delta)
        print(json.dumps(result, indent=2))
        if result["has_pii"]:
            sys.exit(1)

    elif cmd == "scan-file" and len(sys.argv) >= 3:
        findings = screen_file(sys.argv[2])
        if findings:
            print(f"Found {len(findings)} PII pattern(s):")
            for f in findings:
                print(f"  [{f['type']}] {f['match']} at position {f['position']}")
            sys.exit(1)
        else:
            print("No PII patterns detected.")

    elif cmd == "scan-text":
        text = sys.stdin.read() if len(sys.argv) < 3 else sys.argv[2]
        findings = screen_text(text)
        print(json.dumps(findings, indent=2))

    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
