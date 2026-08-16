#!/usr/bin/env python3
"""
Playbook Lessons Migration — migrate existing lessons into manifest items.

Part of Playbook Phase 3 (context-engineering-integration spec, Section 8.1 Stage 3).

Scans existing lesson files, classifies memory_type per content:
  - Stable facts -> fact (e.g., "Prisma createMany silently skips...")
  - Debugging insights -> experiential (e.g., "Silent catch blocks are #1 suspect")
  - Session-specific observations -> episodic
  - How-to knowledge -> procedural (e.g., "To restart the server, run...")

Runs dedup pass before import. Initial usefulness counters = 0.
Ambiguous classification -> pending_review quarantine status.

Usage:
    python3 playbook-migrate-lessons.py scan             # Preview migration
    python3 playbook-migrate-lessons.py migrate [--dry-run]  # Execute migration
    python3 playbook-migrate-lessons.py classify <text>    # Classify a single text

Library usage:
    from playbook_migrate_lessons import scan_lessons, classify_memory_type
"""

import hashlib
import json
import os
import re
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from playbook_paths import get_paths

_paths = get_paths()
PROJECT_DIR = _paths.playbook_root
REPO_ROOT = _paths.project_root
MANIFEST_FILE = _paths.manifest
LESSONS_DIR = os.path.join(PROJECT_DIR, "lessons")
MIGRATION_LOG = os.path.join(PROJECT_DIR, "context-migration-log.jsonl")

# Classification keywords
FACT_KEYWORDS = [
    "always", "never", "must", "requires", "silently", "only works",
    "does not work", "incompatible", "default", "limitation",
    "maximum", "minimum", "exactly", "version", "port",
]
PROCEDURAL_KEYWORDS = [
    "to do", "how to", "steps", "run ", "execute", "configure",
    "restart", "deploy", "install", "setup", "command",
    "workflow", "process", "procedure",
]
EXPERIENTIAL_KEYWORDS = [
    "debugging", "suspect", "investigation", "root cause", "found that",
    "discovered", "realized", "turned out", "trap", "pitfall",
    "lesson learned", "mistake", "insight", "pattern",
]
EPISODIC_KEYWORDS = [
    "session", "today", "this time", "just now", "currently",
    "at the moment", "right now", "temporary",
]


def classify_memory_type(text):
    """
    Classify text into a memory_type based on content analysis.

    Returns (memory_type, confidence) tuple.
    Confidence < 0.6 means ambiguous -> should route to pending_review.
    """
    if not text:
        return "experiential", 0.3

    text_lower = text.lower()

    scores = {
        "fact": 0,
        "procedural": 0,
        "experiential": 0,
        "episodic": 0,
    }

    for kw in FACT_KEYWORDS:
        if kw in text_lower:
            scores["fact"] += 1

    for kw in PROCEDURAL_KEYWORDS:
        if kw in text_lower:
            scores["procedural"] += 1

    for kw in EXPERIENTIAL_KEYWORDS:
        if kw in text_lower:
            scores["experiential"] += 1

    for kw in EPISODIC_KEYWORDS:
        if kw in text_lower:
            scores["episodic"] += 1

    # Normalize
    total = sum(scores.values())
    if total == 0:
        return "experiential", 0.4

    best = max(scores, key=scores.get)
    confidence = scores[best] / max(total, 1)

    # Boost confidence if strongly one type
    if scores[best] >= 3 and confidence >= 0.5:
        confidence = min(confidence + 0.2, 0.95)

    return best, round(confidence, 2)


def _extract_lesson_from_file(filepath):
    """Extract lesson entries from a lessons file."""
    lessons = []
    try:
        with open(filepath, "r", errors="replace") as f:
            content = f.read()

        # Try to parse as numbered lessons (e.g., "1st Lesson: ...")
        lesson_pattern = re.compile(
            r'(?:^|\n)(?:#+\s*)?(?:The\s+)?(\d+)(?:st|nd|rd|th)\s+Lesson[:\s]*(.+?)(?=\n(?:#+\s*)?(?:The\s+)?\d+(?:st|nd|rd|th)\s+Lesson|\Z)',
            re.DOTALL | re.IGNORECASE
        )
        matches = lesson_pattern.findall(content)
        if matches:
            for num, text in matches:
                clean = text.strip()
                if len(clean) > 20:
                    lessons.append({
                        "number": int(num),
                        "text": clean,
                        "source_file": filepath,
                    })

        # If no numbered lessons, try markdown headers
        if not lessons:
            header_pattern = re.compile(
                r'^##\s+(.+?)$\n(.*?)(?=^##\s|\Z)',
                re.MULTILINE | re.DOTALL
            )
            matches = header_pattern.findall(content)
            for title, body in matches:
                clean = body.strip()
                if len(clean) > 20:
                    lessons.append({
                        "number": 0,
                        "text": f"{title.strip()}: {clean}",
                        "source_file": filepath,
                    })

        # If still nothing, treat whole file as one lesson
        if not lessons and len(content.strip()) > 50:
            lessons.append({
                "number": 0,
                "text": content.strip(),
                "source_file": filepath,
            })

    except OSError:
        pass

    return lessons


def scan_lessons():
    """
    Scan all lesson files and classify for migration.

    Returns migration plan with classified lessons.
    """
    if not os.path.exists(LESSONS_DIR):
        return {"status": "error", "message": f"Lessons directory not found: {LESSONS_DIR}"}

    all_lessons = []
    for fname in sorted(os.listdir(LESSONS_DIR)):
        fpath = os.path.join(LESSONS_DIR, fname)
        if os.path.isfile(fpath):
            lessons = _extract_lesson_from_file(fpath)
            all_lessons.extend(lessons)

    # Classify each lesson
    classified = []
    ambiguous = []
    for lesson in all_lessons:
        memory_type, confidence = classify_memory_type(lesson["text"])
        entry = {
            "text": lesson["text"][:200],
            "full_text": lesson["text"],
            "source_file": lesson["source_file"],
            "lesson_number": lesson["number"],
            "memory_type": memory_type,
            "confidence": confidence,
        }
        if confidence < 0.6:
            entry["status"] = "ambiguous"
            ambiguous.append(entry)
        else:
            entry["status"] = "classified"
            classified.append(entry)

    return {
        "status": "complete",
        "total_lessons": len(all_lessons),
        "classified": len(classified),
        "ambiguous": len(ambiguous),
        "by_type": {
            "fact": len([c for c in classified if c["memory_type"] == "fact"]),
            "experiential": len([c for c in classified if c["memory_type"] == "experiential"]),
            "procedural": len([c for c in classified if c["memory_type"] == "procedural"]),
            "episodic": len([c for c in classified if c["memory_type"] == "episodic"]),
        },
        "lessons": classified + ambiguous,
    }


def _generate_item_id(lesson_text, idx):
    """Generate a manifest item ID from lesson text."""
    # Extract keywords for slug
    words = re.sub(r'[^a-z0-9\s]', '', lesson_text.lower()).split()
    slug_words = [w for w in words[:6] if len(w) > 2]
    slug = "-".join(slug_words[:4]) if slug_words else f"lesson-{idx}"
    return f"/context/lessons/migrated/{slug}"


def migrate_to_manifest(dry_run=True):
    """
    Execute the migration: create manifest items from classified lessons.

    Runs dedup check before import.
    """
    import secrets

    scan = scan_lessons()
    if scan.get("status") == "error":
        return scan

    lessons = scan.get("lessons", [])
    if not lessons:
        return {"status": "no_lessons", "message": "No lessons found to migrate"}

    # Load manifest for dedup checking
    manifest = None
    if os.path.exists(MANIFEST_FILE):
        with open(MANIFEST_FILE, "r") as f:
            manifest = json.load(f)

    # Import dedup for similarity checking
    try:
        dedup = None
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "playbook_dedup",
            os.path.join(SCRIPT_DIR, "playbook-dedup.py"))
        dedup = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(dedup)
    except Exception:
        pass

    deltas = []
    skipped_dedup = []
    skipped_ambiguous = []
    existing_texts = set()

    for idx, lesson in enumerate(lessons):
        text = lesson.get("full_text", lesson.get("text", ""))

        # Skip ambiguous for human review
        if lesson.get("confidence", 0) < 0.6:
            skipped_ambiguous.append(lesson)
            continue

        # Internal dedup: skip if we already have very similar text
        text_hash = hashlib.md5(text.encode()).hexdigest()[:12]
        if text_hash in existing_texts:
            skipped_dedup.append(lesson)
            continue
        existing_texts.add(text_hash)

        # Check similarity against existing manifest items
        if dedup and manifest:
            text_tokens = set(text.lower().split())
            for item in manifest.get("items", []):
                item_text = item.get("content_inline", "")
                if item_text:
                    item_tokens = set(item_text.lower().split())
                    if text_tokens and item_tokens:
                        jaccard = len(text_tokens & item_tokens) / len(text_tokens | item_tokens)
                        if jaccard >= 0.92:
                            skipped_dedup.append(lesson)
                            text_hash = None
                            break
            if text_hash is None:
                continue

        item_id = _generate_item_id(text, idx)

        # Truncate content to 500 tokens (governance max)
        content = text[:2000]  # ~500 tokens

        content_hash = "sha256:" + hashlib.sha256(content.encode()).hexdigest()[:16]

        delta = {
            "delta_id": f"delta-{secrets.token_hex(6)}",
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "source_session": "MIGRATION",
            "operation": "create",
            "target_item_id": item_id,
            "reflector_confidence": lesson.get("confidence", 0.7),
            "payload": {
                "category": "lesson",
                "memory_type": lesson["memory_type"],
                "content_inline": content,
                "content_hash": content_hash,
                "tokens_est": len(content) // 4 + 1,
                "tags": {"domains": [], "qualifiers": []},
                "load_triggers": [],
            },
            "evidence": [{
                "type": "test_result",
                "value": f"migrated_from:{os.path.basename(lesson.get('source_file', ''))}",
            }],
        }
        deltas.append(delta)

    # Submit deltas if not dry run
    if not dry_run and deltas:
        try:
            import importlib.util
            spec = importlib.util.spec_from_file_location(
                "playbook_lifecycle",
                os.path.join(SCRIPT_DIR, "playbook-lifecycle.py"))
            lifecycle = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(lifecycle)
            for delta in deltas:
                lifecycle.submit_delta(delta)
        except Exception as e:
            return {"status": "error", "message": f"Failed to submit deltas: {e}"}

    # Log
    from atomic_write import atomic_append
    log_entry = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "total_lessons": len(lessons),
        "deltas_created": len(deltas),
        "skipped_dedup": len(skipped_dedup),
        "skipped_ambiguous": len(skipped_ambiguous),
        "dry_run": dry_run,
    }
    atomic_append(MIGRATION_LOG, json.dumps(log_entry, separators=(",", ":")))

    return {
        "status": "complete",
        "total_lessons": len(lessons),
        "deltas_created": len(deltas),
        "skipped_dedup": len(skipped_dedup),
        "skipped_ambiguous": len(skipped_ambiguous),
        "dry_run": dry_run,
    }


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "scan":
        result = scan_lessons()
        print(json.dumps({k: v for k, v in result.items() if k != "lessons"}, indent=2))
        if result.get("lessons"):
            print(f"\nFirst 5 lessons:")
            for lesson in result["lessons"][:5]:
                print(f"  [{lesson['memory_type']}@{lesson['confidence']}] {lesson['text'][:80]}...")

    elif cmd == "migrate":
        dry_run = "--dry-run" in sys.argv or "--dry_run" in sys.argv
        result = migrate_to_manifest(dry_run=dry_run)
        print(json.dumps(result, indent=2))

    elif cmd == "classify" and len(sys.argv) >= 3:
        text = " ".join(sys.argv[2:])
        memory_type, confidence = classify_memory_type(text)
        print(f"Type: {memory_type}, Confidence: {confidence}")

    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
