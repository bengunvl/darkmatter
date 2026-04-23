# DarkMatter Canonical Envelope v1

**Status:** Normative  
**Version:** dm-envelope-v1  
**Date:** 2026-04-23

---

## Purpose

This document defines the canonical signed envelope for DarkMatter L3 (Non-repudiation) commits. Any implementation — server, Python SDK, TypeScript SDK, or third-party verifier — that correctly implements this spec will produce interoperable signatures.

**This spec is a release gate.** No SDK ships until it passes all test vectors in Section 6.

---

## 1. Canonicalization Rule

The canonical form of the envelope is a JSON string produced by the following algorithm, applied deterministically:

1. Construct the envelope object (Section 2)
2. Sort all object keys **recursively** in ascending Unicode code point order
3. Serialize to JSON with **no whitespace** (no spaces, no newlines)
4. Encode as **UTF-8** bytes
5. Do **not** escape non-ASCII Unicode characters (use literal UTF-8)
6. Numbers serialized as-is (no trailing zeros, no scientific notation for integers)

This is equivalent to Python's `json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False)`.

**Implementations must not:**
- Add whitespace
- Use different key ordering
- Escape Unicode characters unnecessarily
- Add trailing commas
- Serialize null fields differently than `null`

---

## 2. Envelope Object

```json
{
  "version": "dm-envelope-v1",
  "algorithm": "Ed25519",
  "agent_id": "<string>",
  "client_timestamp": "<ISO8601 UTC, e.g. 2026-04-23T18:42:11.182Z>",
  "key_id": "<string>",
  "metadata_hash": "<'sha256:' + hex string, or null>",
  "parent_id": "<string or null>",
  "payload_hash": "<'sha256:' + hex string>"
}
```

### Field rules

| Field | Type | Required | Notes |
|---|---|---|---|
| `version` | string | yes | Always `"dm-envelope-v1"` |
| `algorithm` | string | yes | Always `"Ed25519"` for this version |
| `agent_id` | string | yes | The committing agent's ID (`dm_...`) |
| `client_timestamp` | string | yes | ISO8601 UTC with milliseconds |
| `key_id` | string | yes | Identifies the signing key |
| `metadata_hash` | string\|null | yes | `"sha256:" + hex(sha256(canonical(metadata)))` or `null` if no metadata |
| `parent_id` | string\|null | yes | Parent commit ID, or `null` for root commits |
| `payload_hash` | string | yes | `"sha256:" + hex(sha256(canonical(payload)))` |

**All fields must be present.** Omitting optional-seeming fields (like `parent_id: null`) is not permitted — the field must be present with value `null`.

---

## 3. Hashing Rules

### Payload hash

Hash the **canonical JSON** of the payload object (same sort+serialize rule):

```
payload_hash = "sha256:" + hex(sha256(canonical_json(payload)))
```

Example: payload `{"input": "hello", "output": "world"}` canonicalizes to `{"input":"hello","output":"world"}`.

### Metadata hash

If metadata is present:
```
metadata_hash = "sha256:" + hex(sha256(canonical_json(metadata)))
```

If no metadata: `metadata_hash = null` (the field is still present in the envelope).

### Envelope hash

```
envelope_hash = "sha256:" + hex(sha256(utf8(canonical_json(envelope))))
```

The envelope hash is what is actually signed.

---

## 4. Signing

```
signature = Ed25519.sign(private_key, utf8(canonical_json(envelope)))
```

The signature is over the **raw UTF-8 bytes** of the canonical envelope JSON — not the hash of it. This is standard Ed25519 practice (the algorithm already applies internal hashing).

Signature is encoded as **base64url** (no padding) for transport.

---

## 5. client_attestation Object (API Transport)

This is the object sent in the `/api/commit` request body:

```json
{
  "version": "dm-envelope-v1",
  "algorithm": "Ed25519",
  "key_id": "acme-prod-key-1",
  "public_key": "<base64url of raw 32-byte Ed25519 public key>",
  "client_timestamp": "2026-04-23T18:42:11.182Z",
  "payload_hash": "sha256:abc123...",
  "metadata_hash": "sha256:def456...",
  "envelope_hash": "sha256:789ghi...",
  "signature": "<base64url of 64-byte Ed25519 signature>"
}
```

`public_key` may be omitted if the `key_id` is registered via `POST /api/signing-keys`. If both are present, the registered key takes precedence and they must match.

---

## 6. Test Vectors

These are normative. Any implementation must reproduce these outputs exactly.

---

### Vector 1 — Minimal root commit

**Input payload:**
```json
{"input": "approve transaction", "output": "approved"}
```

**Input metadata:** none

**Envelope fields:**
```json
{
  "agent_id": "dm_abc123",
  "algorithm": "Ed25519",
  "client_timestamp": "2026-04-23T18:42:11.182Z",
  "key_id": "test-key-1",
  "metadata_hash": null,
  "parent_id": null,
  "payload_hash": "sha256:PAYLOAD_HASH_1",
  "version": "dm-envelope-v1"
}
```

**Canonical payload JSON:**
```
{"input":"approve transaction","output":"approved"}
```

**payload_hash:**
```
sha256:e3b1a8c9f2d4a6b8e3b1a8c9f2d4a6b8e3b1a8c9f2d4a6b8e3b1a8c9f2d4a6b8
```
*(replace with actual sha256 — computed in Section 7)*

**Canonical envelope JSON:**
```
{"agent_id":"dm_abc123","algorithm":"Ed25519","client_timestamp":"2026-04-23T18:42:11.182Z","key_id":"test-key-1","metadata_hash":null,"parent_id":null,"payload_hash":"sha256:COMPUTED","version":"dm-envelope-v1"}
```

---

### Vector 2 — Commit with parent and metadata

**Input payload:**
```json
{"input": "Risk: HIGH", "output": "Escalated to human review"}
```

**Input metadata:**
```json
{"model": "claude-sonnet-4-6", "provider": "anthropic", "temperature": 0.2}
```

**Envelope fields:**
```json
{
  "agent_id": "dm_abc123",
  "algorithm": "Ed25519",
  "client_timestamp": "2026-04-23T18:43:00.000Z",
  "key_id": "test-key-1",
  "metadata_hash": "sha256:METADATA_HASH",
  "parent_id": "ctx_1776867044953_f59579ba4edc",
  "payload_hash": "sha256:PAYLOAD_HASH_2",
  "version": "dm-envelope-v1"
}
```

**Canonical metadata JSON:**
```
{"model":"claude-sonnet-4-6","provider":"anthropic","temperature":0.2}
```

---

### Vector 3 — Unicode payload

**Input payload:**
```json
{"input": "Révision du contrat", "output": "Approuvé — décision finale"}
```

Unicode characters must not be escaped. Canonical form:
```
{"input":"Révision du contrat","output":"Approuvé — décision finale"}
```

---

## 7. Reference Implementation (Python)

This is the normative reference. Other implementations must produce identical output.

```python
import hashlib
import json
import base64
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

def canonical_json(obj: dict) -> str:
    """Canonical JSON: sorted keys, no whitespace, UTF-8, no escaped Unicode."""
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False)

def sha256_hex(data: str) -> str:
    """SHA-256 of UTF-8 string, returned as hex."""
    return hashlib.sha256(data.encode('utf-8')).hexdigest()

def hash_field(obj: dict | None) -> str | None:
    """Hash a dict for payload_hash or metadata_hash. Returns None if obj is None."""
    if obj is None:
        return None
    return 'sha256:' + sha256_hex(canonical_json(obj))

def build_envelope(agent_id, key_id, client_timestamp, payload, metadata=None, parent_id=None):
    return {
        'version':          'dm-envelope-v1',
        'algorithm':        'Ed25519',
        'agent_id':         agent_id,
        'client_timestamp': client_timestamp,
        'key_id':           key_id,
        'metadata_hash':    hash_field(metadata),
        'parent_id':        parent_id,
        'payload_hash':     hash_field(payload),
    }

def sign_envelope(envelope: dict, private_key: Ed25519PrivateKey) -> dict:
    """Sign envelope, return client_attestation object."""
    canonical = canonical_json(envelope)
    envelope_hash = 'sha256:' + sha256_hex(canonical)
    signature_bytes = private_key.sign(canonical.encode('utf-8'))
    signature_b64 = base64.urlsafe_b64encode(signature_bytes).rstrip(b'=').decode()
    pub_bytes = private_key.public_key().public_bytes_raw()
    public_key_b64 = base64.urlsafe_b64encode(pub_bytes).rstrip(b'=').decode()
    return {
        'version':          envelope['version'],
        'algorithm':        envelope['algorithm'],
        'key_id':           envelope['key_id'],
        'public_key':       public_key_b64,
        'client_timestamp': envelope['client_timestamp'],
        'payload_hash':     envelope['payload_hash'],
        'metadata_hash':    envelope['metadata_hash'],
        'envelope_hash':    envelope_hash,
        'signature':        signature_b64,
    }

def verify_attestation(attestation: dict, payload: dict, metadata: dict | None = None) -> bool:
    """Verify a client_attestation object. Returns True if valid."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    from cryptography.exceptions import InvalidSignature

    # 1. Recompute payload hash
    expected_payload_hash = hash_field(payload)
    if attestation['payload_hash'] != expected_payload_hash:
        return False

    # 2. Recompute metadata hash
    expected_meta_hash = hash_field(metadata)
    if attestation['metadata_hash'] != expected_meta_hash:
        return False

    # 3. Reconstruct envelope
    envelope = {
        'version':          attestation['version'],
        'algorithm':        attestation['algorithm'],
        'agent_id':         attestation.get('agent_id', ''),
        'client_timestamp': attestation['client_timestamp'],
        'key_id':           attestation['key_id'],
        'metadata_hash':    attestation['metadata_hash'],
        'parent_id':        attestation.get('parent_id', None),
        'payload_hash':     attestation['payload_hash'],
    }
    canonical = canonical_json(envelope)

    # 4. Verify envelope hash
    expected_env_hash = 'sha256:' + sha256_hex(canonical)
    if attestation['envelope_hash'] != expected_env_hash:
        return False

    # 5. Verify signature
    pub_bytes = base64.urlsafe_b64decode(attestation['public_key'] + '==')
    public_key = Ed25519PublicKey.from_public_bytes(pub_bytes)
    sig_bytes = base64.urlsafe_b64decode(attestation['signature'] + '==')
    try:
        public_key.verify(sig_bytes, canonical.encode('utf-8'))
        return True
    except InvalidSignature:
        return False
```

---

## 8. Clock Skew Policy

- Accept commits with any `client_timestamp`
- If `|server_time - client_timestamp| > 300 seconds` (5 minutes): store `timestamp_skew_warning: true` on the commit
- Never reject a commit solely due to clock skew
- Skew warning is visible in export bundle and on `/r/:traceId`

---

## 9. Error Codes

When attestation verification fails, the server returns HTTP 400 with:

```json
{
  "error": "attestation_failed",
  "reason": "<one of the values below>",
  "message": "<human-readable description>"
}
```

| reason | meaning |
|---|---|
| `invalid_signature` | Ed25519 signature did not verify |
| `payload_hash_mismatch` | Recomputed payload hash does not match attestation |
| `metadata_hash_mismatch` | Recomputed metadata hash does not match attestation |
| `envelope_hash_mismatch` | Recomputed envelope hash does not match attestation |
| `unknown_key_id` | key_id not found in registry and no inline public_key provided |
| `revoked_key` | key_id found but has been revoked |
| `unsupported_algorithm` | Algorithm is not Ed25519 |
| `missing_public_key` | No inline public_key and key_id not registered |
