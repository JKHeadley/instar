#!/usr/bin/env python3
"""
Playbook Schema Validator — validate manifest files against JSON Schema.

Part of Playbook Phase 4 (context-engineering-integration spec, Section 10).

Zero-dependency validator (stdlib only) that checks a context-manifest.json
against the schema at schemas/context-manifest.schema.json. Used by both
Dawn (Portal) and external Instar consumers.

Validates:
  - Required fields presence
  - Type correctness
  - Enum value membership
  - Pattern matching (IDs, hashes)
  - Array constraints (maxItems)
  - Nested object structure ($defs expansion)

Usage:
    python3 playbook-schema-validate.py [path/to/manifest.json]
    python3 playbook-schema-validate.py --schema-only  # Validate the schema itself

Library usage:
    from playbook_schema_validate import validate_manifest, load_schema
"""

import json
import os
import re
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)
from playbook_paths import get_paths

_paths = get_paths()
PROJECT_DIR = _paths.playbook_root
DEFAULT_MANIFEST = _paths.manifest
SCHEMA_FILE = _paths.manifest_schema


def load_schema(schema_path=None):
    """Load the JSON Schema from disk."""
    path = schema_path or SCHEMA_FILE
    if not os.path.exists(path):
        return None, f"Schema file not found: {path}"
    try:
        with open(path, "r") as f:
            return json.load(f), None
    except json.JSONDecodeError as e:
        return None, f"Schema is not valid JSON: {e}"


def _check_type(value, expected_type):
    """Check if a value matches a JSON Schema type."""
    type_map = {
        "string": str,
        "integer": int,
        "number": (int, float),
        "boolean": bool,
        "array": list,
        "object": dict,
        "null": type(None),
    }
    py_type = type_map.get(expected_type)
    if py_type is None:
        return True
    return isinstance(value, py_type)


def _validate_value(value, prop_schema, defs, path=""):
    """Validate a single value against its property schema. Returns list of errors."""
    errors = []

    if "$ref" in prop_schema:
        ref = prop_schema["$ref"]
        if ref.startswith("#/$defs/"):
            def_name = ref.split("/")[-1]
            if def_name in defs:
                prop_schema = defs[def_name]
            else:
                errors.append(f"{path}: unresolved $ref '{ref}'")
                return errors

    if "type" in prop_schema:
        if not _check_type(value, prop_schema["type"]):
            errors.append(f"{path}: expected type '{prop_schema['type']}', got {type(value).__name__}")
            return errors

    if "enum" in prop_schema:
        if value not in prop_schema["enum"]:
            errors.append(f"{path}: value '{value}' not in enum {prop_schema['enum']}")

    if "pattern" in prop_schema and isinstance(value, str):
        if not re.search(prop_schema["pattern"], value):
            errors.append(f"{path}: value '{value}' does not match pattern '{prop_schema['pattern']}'")

    if "minimum" in prop_schema and isinstance(value, (int, float)):
        if value < prop_schema["minimum"]:
            errors.append(f"{path}: value {value} below minimum {prop_schema['minimum']}")

    if "maxLength" in prop_schema and isinstance(value, str):
        if len(value) > prop_schema["maxLength"]:
            errors.append(f"{path}: string length {len(value)} exceeds maxLength {prop_schema['maxLength']}")

    if prop_schema.get("type") == "array" and isinstance(value, list):
        if "maxItems" in prop_schema and len(value) > prop_schema["maxItems"]:
            errors.append(f"{path}: array length {len(value)} exceeds maxItems {prop_schema['maxItems']}")
        if "items" in prop_schema:
            for i, item in enumerate(value):
                errors.extend(_validate_value(item, prop_schema["items"], defs, f"{path}[{i}]"))

    if prop_schema.get("type") == "object" and isinstance(value, dict):
        for req in prop_schema.get("required", []):
            if req not in value:
                errors.append(f"{path}: missing required field '{req}'")

        props = prop_schema.get("properties", {})
        for key, val in value.items():
            if key in props:
                errors.extend(_validate_value(val, props[key], defs, f"{path}.{key}"))
            elif prop_schema.get("additionalProperties") is False:
                errors.append(f"{path}: unexpected property '{key}'")

    return errors


def validate_manifest(manifest, schema=None):
    """
    Validate a manifest dict against the schema.

    Returns dict with valid (bool), errors (list), items_validated (int), warnings (list).
    """
    if schema is None:
        schema, err = load_schema()
        if err:
            return {"valid": False, "errors": [err], "items_validated": 0, "warnings": []}

    defs = schema.get("$defs", {})
    errors = []
    warnings = []

    if not isinstance(manifest, dict):
        return {"valid": False, "errors": ["Manifest must be a JSON object"], "items_validated": 0, "warnings": []}

    for req in schema.get("required", []):
        if req not in manifest:
            errors.append(f"Missing required top-level field: '{req}'")

    props = schema.get("properties", {})
    for key, val in manifest.items():
        if key in props:
            errors.extend(_validate_value(val, props[key], defs, key))
        elif schema.get("additionalProperties") is False:
            errors.append(f"Unexpected top-level property: '{key}'")

    items = manifest.get("items", [])
    items_validated = len(items)

    seen_ids = set()
    for i, item in enumerate(items):
        item_id = item.get("id", f"<item[{i}]>")

        if item_id in seen_ids:
            warnings.append(f"Duplicate item ID: '{item_id}'")
        seen_ids.add(item_id)

        if not item.get("path") and not item.get("content_inline"):
            warnings.append(f"{item_id}: has neither 'path' nor 'content_inline'")

        if item.get("status") == "retired" and not item.get("retired_at"):
            warnings.append(f"{item_id}: status is 'retired' but missing 'retired_at'")
        if item.get("retired_at") and item.get("status") != "retired":
            warnings.append(f"{item_id}: has 'retired_at' but status is '{item.get('status')}'")

    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "items_validated": items_validated,
        "warnings": warnings,
    }


def validate_schema_self(schema_path=None):
    """Validate the schema file itself is well-formed."""
    schema, err = load_schema(schema_path)
    if err:
        return {"valid": False, "errors": [err]}

    errors = []

    if "$schema" not in schema:
        errors.append("Schema missing '$schema' declaration")

    if "$defs" not in schema:
        errors.append("Schema missing '$defs' section")
    else:
        def _find_refs(obj, path=""):
            refs = []
            if isinstance(obj, dict):
                if "$ref" in obj:
                    refs.append((path, obj["$ref"]))
                for k, v in obj.items():
                    refs.extend(_find_refs(v, f"{path}.{k}"))
            elif isinstance(obj, list):
                for i, v in enumerate(obj):
                    refs.extend(_find_refs(v, f"{path}[{i}]"))
            return refs

        all_refs = _find_refs(schema)
        defs = schema.get("$defs", {})
        for path, ref in all_refs:
            if ref.startswith("#/$defs/"):
                def_name = ref.split("/")[-1]
                if def_name not in defs:
                    errors.append(f"{path}: $ref '{ref}' does not resolve")

    manifest_item = schema.get("$defs", {}).get("ManifestItem", {})
    if not manifest_item:
        errors.append("$defs missing 'ManifestItem' definition")
    else:
        required = manifest_item.get("required", [])
        for field in ["id", "category", "memory_type", "status"]:
            if field not in required:
                errors.append(f"ManifestItem missing required field '{field}'")

    return {"valid": len(errors) == 0, "errors": errors}


def main():
    if "--schema-only" in sys.argv:
        result = validate_schema_self()
        if result["valid"]:
            print("Schema self-validation: PASS")
        else:
            print("Schema self-validation: FAIL")
            for err in result["errors"]:
                print(f"  ERROR: {err}")
        sys.exit(0 if result["valid"] else 1)

    manifest_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_MANIFEST
    if not os.path.exists(manifest_path):
        print(f"Manifest not found: {manifest_path}")
        sys.exit(1)

    with open(manifest_path, "r") as f:
        manifest = json.load(f)

    result = validate_manifest(manifest)

    if result["valid"]:
        print(f"Validation: PASS ({result['items_validated']} items)")
    else:
        print(f"Validation: FAIL ({len(result['errors'])} errors)")
        for err in result["errors"]:
            print(f"  ERROR: {err}")

    if result["warnings"]:
        print(f"Warnings ({len(result['warnings'])}):")
        for warn in result["warnings"]:
            print(f"  WARN: {warn}")

    sys.exit(0 if result["valid"] else 1)


if __name__ == "__main__":
    main()
