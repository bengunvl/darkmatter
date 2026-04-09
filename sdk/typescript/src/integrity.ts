/**
 * DarkMatter Integrity Module — TypeScript
 * ==========================================
 * Canonical serialization, commit envelope hashing, and signature verification.
 *
 * This file is a faithful port of src/integrity.js.
 * All cross-language SDKs must produce byte-identical output.
 * Validated by: github-template/integrity_test_vectors.json
 *
 * Spec: https://darkmatterhub.ai/docs#integrity-model
 *
 * Usage (no dependencies beyond Node.js built-ins):
 *   import { hashPayload, buildEnvelope, computeIntegrityHash } from './integrity';
 *
 * For agent signing (Ed25519), pass pre-computed signatures from your
 * key management layer — this module does not import crypto directly
 * so it also works in browser/edge environments.
 */

export const SCHEMA_VERSION = '2';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface CommitEnvelope {
  schema_version:        string;
  agent_id:              string;
  key_id:                string;
  timestamp:             string;   // ISO-8601 UTC, seconds precision (no ms)
  payload_hash:          string;   // lowercase hex SHA-256
  parent_integrity_hash: string;   // lowercase hex SHA-256, or 'root'
}

export interface ChainVerifyResult {
  chain_intact: boolean;
  length:       number;
  broken_at:    string | null;
  mode:         'strict' | 'legacy';
  steps:        ChainStep[];
}

export interface ChainStep {
  id:           string;
  payload_ok:   boolean;
  integrity_ok: boolean;
  link_ok:      boolean;
  reason?:      string;
}

export interface ClientHashValidation {
  valid:                boolean;
  reason:               string | null;
  serverPayloadHash:    string;
  serverIntegrityHash:  string;
  envelope:             CommitEnvelope;
}

// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL SERIALIZATION v1
//
// Rules — all SDKs must implement identically:
//   1. Object keys sorted lexicographically (Unicode codepoint order)
//   2. null values in objects KEPT as "null" (null ≠ undefined)
//   3. undefined values in objects DROPPED
//   4. Arrays preserve element order
//   5. Strings: standard JSON encoding via JSON.stringify
//   6. Integers: decimal digits only
//   7. Floats: non-finite (NaN, ±Infinity) throw TypeError
//   8. Floats: toPrecision(17) then strip trailing zeros, keep ≥1 decimal digit
//   9. Boolean: "true" / "false"
//  10. null (standalone): "null"
// ─────────────────────────────────────────────────────────────────────────────

export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'null'; // top-level undefined treated as null

  if (typeof value === 'boolean') return value ? 'true' : 'false';

  if (typeof value === 'number') {
    if (!isFinite(value)) {
      throw new TypeError(`canonicalize: non-finite number rejected: ${value}`);
    }
    if (Number.isInteger(value)) return String(value);

    // Rule 8: toPrecision(17) then strip trailing zeros, keep ≥1 decimal digit
    let s = value.toPrecision(17);
    if (s.includes('.') && !s.includes('e')) {
      s = s.replace(/\.?0+$/, '');
      if (!s.includes('.')) s += '.0';
    }
    return s;
  }

  if (typeof value === 'string') {
    // Delegate to JSON.stringify for correct escape sequences
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const pairs: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue; // drop undefined, keep null
      pairs.push(JSON.stringify(k) + ':' + canonicalize(v));
    }
    return '{' + pairs.join(',') + '}';
  }

  throw new TypeError(`canonicalize: unsupported type ${typeof value}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// HASHING (Node.js built-in crypto)
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'crypto';

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * SHA-256 of canonical(payload). Returns lowercase hex, no prefix.
 */
export function hashPayload(payload: Record<string, unknown>): string {
  return sha256(canonicalize(payload));
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMIT ENVELOPE
//
// The envelope is what gets hashed (→ integrity_hash) and signed by the agent.
// Signing the envelope binds:
//   payload content, chain position, agent identity, key identity,
//   schema version, and timestamp.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the canonical commit envelope.
 * Timestamp is normalized to seconds precision (milliseconds stripped).
 * parentIntegrityHash = null → 'root' in envelope (root commit).
 */
export function buildEnvelope(
  payloadHash:          string,
  parentIntegrityHash:  string | null,
  agentId:              string,
  keyId:                string,
  timestamp:            string,
): CommitEnvelope {
  // Strip milliseconds, ensure Z suffix
  const ts = timestamp.replace(/\.\d+Z?$/, '').replace(/Z?$/, 'Z');

  return {
    schema_version:        SCHEMA_VERSION,
    agent_id:              agentId,
    key_id:                keyId,
    timestamp:             ts,
    payload_hash:          payloadHash,
    parent_integrity_hash: parentIntegrityHash ?? 'root',
  };
}

/**
 * SHA-256 of canonical(envelope). Returns lowercase hex, no prefix.
 */
export function hashEnvelope(envelope: CommitEnvelope): string {
  return sha256(canonicalize(envelope as unknown as Record<string, unknown>));
}

/**
 * One-shot: compute both payload_hash and integrity_hash.
 * Returns { payloadHash, integrityHash, envelope }.
 */
export function computeIntegrityHash(
  payload:             Record<string, unknown>,
  parentIntegrityHash: string | null,
  agentId:             string,
  keyId:               string,
  timestamp:           string,
): { payloadHash: string; integrityHash: string; envelope: CommitEnvelope } {
  const payloadHash    = hashPayload(payload);
  const envelope       = buildEnvelope(payloadHash, parentIntegrityHash, agentId, keyId, timestamp);
  const integrityHash  = hashEnvelope(envelope);
  return { payloadHash, integrityHash, envelope };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT HASH VALIDATION
// Server calls this after recomputing hashes. Detects client-side mismatches.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate client-supplied hashes against server-recomputed values.
 * Returns { valid, reason, serverPayloadHash, serverIntegrityHash, envelope }.
 * If valid=false the commit is still stored but hash_mismatch=true is flagged.
 */
export function validateClientHashes(
  payload:              Record<string, unknown>,
  clientPayloadHash:    string | null,
  clientIntegrityHash:  string | null,
  parentIntegrityHash:  string | null,
  agentId:              string,
  keyId:                string,
  timestamp:            string,
): ClientHashValidation {
  const { payloadHash: serverPayloadHash, integrityHash: serverIntegrityHash, envelope }
    = computeIntegrityHash(payload, parentIntegrityHash, agentId, keyId, timestamp);

  if (clientPayloadHash && clientPayloadHash !== serverPayloadHash) {
    return {
      valid:   false,
      reason:  `payload_hash mismatch: client=${clientPayloadHash} server=${serverPayloadHash}`,
      serverPayloadHash, serverIntegrityHash, envelope,
    };
  }
  if (clientIntegrityHash && clientIntegrityHash !== serverIntegrityHash) {
    return {
      valid:   false,
      reason:  `integrity_hash mismatch: client=${clientIntegrityHash} server=${serverIntegrityHash}`,
      serverPayloadHash, serverIntegrityHash, envelope,
    };
  }
  return { valid: true, reason: null, serverPayloadHash, serverIntegrityHash, envelope };
}

// ─────────────────────────────────────────────────────────────────────────────
// SIGNATURE VERIFICATION (Ed25519)
// Agents sign canonical(envelope) — full commit authentication.
// ─────────────────────────────────────────────────────────────────────────────

import { createPublicKey, verify as cryptoVerify } from 'crypto';

/**
 * Verify an Ed25519 signature over canonical(envelope).
 * Returns false on any error (wrong key, malformed sig, etc.).
 */
export function verifyEnvelopeSignature(
  envelope:      CommitEnvelope,
  signatureHex:  string,
  publicKeyPem:  string,
): boolean {
  try {
    const message   = Buffer.from(canonicalize(envelope as unknown as Record<string, unknown>), 'utf8');
    const signature = Buffer.from(signatureHex, 'hex');
    const publicKey = createPublicKey(publicKeyPem);
    return cryptoVerify(null, message, publicKey, signature);
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHAIN VERIFICATION
// Strict by default: missing hashes = broken. Use legacy for old exports.
// ─────────────────────────────────────────────────────────────────────────────

export interface CommitRecord {
  id:              string;
  payload?:        Record<string, unknown>;
  context?:        Record<string, unknown>;
  payload_hash?:   string;
  integrity_hash?: string;
  agent_id?:       string;
  agent_info?:     { id?: string; key_id?: string };
  key_id?:         string;
  timestamp?:      string;
}

/**
 * Verify an ordered array of commits (root → tip).
 * Strict mode (default): missing payload_hash or integrity_hash = broken.
 * Legacy mode: missing hashes are skipped (for exports from before Phase 1).
 */
export function verifyChain(
  commits: CommitRecord[],
  options: { strict?: boolean } = {},
): ChainVerifyResult {
  const strict         = options.strict ?? true;
  let   prevIntegrity: string | null = null;
  let   brokenAt:      string | null = null;
  const steps:         ChainStep[]   = [];

  for (const commit of commits) {
    const cid      = commit.id;
    const payload  = commit.payload ?? commit.context ?? {};
    const agentId  = commit.agent_id ?? commit.agent_info?.id ?? '';
    const keyId    = commit.key_id   ?? commit.agent_info?.key_id ?? 'default';
    const ts       = commit.timestamp ?? '';

    const storedPH = stripPrefix(commit.payload_hash);
    const storedIH = stripPrefix(commit.integrity_hash);

    // Strict: missing hashes = broken
    if (strict && (!storedPH || !storedIH)) {
      steps.push({ id: cid, payload_ok: false, integrity_ok: false, link_ok: false, reason: 'missing_hashes' });
      if (!brokenAt) brokenAt = cid;
      continue;
    }

    const serverPH              = hashPayload(payload);
    const envelope              = buildEnvelope(serverPH, prevIntegrity, agentId, keyId, ts);
    const serverIH              = hashEnvelope(envelope);

    const payloadOk:   boolean  = !storedPH || serverPH === storedPH;
    const integrityOk: boolean  = !storedIH || serverIH === storedIH;
    const linkOk:      boolean  = payloadOk && integrityOk;

    steps.push({ id: cid, payload_ok: payloadOk, integrity_ok: integrityOk, link_ok: linkOk });
    if (!linkOk && !brokenAt) brokenAt = cid;

    prevIntegrity = serverIH; // always advance with server-recomputed value
  }

  return {
    chain_intact: brokenAt === null,
    length:       commits.length,
    broken_at:    brokenAt,
    mode:         strict ? 'strict' : 'legacy',
    steps,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST VECTOR RUNNER
// Call from your CI pipeline to verify this module against the published vectors.
// ─────────────────────────────────────────────────────────────────────────────

export interface TestResult {
  id:       string;
  desc:     string;
  ok:       boolean;
  expected: string;
  got:      string;
}

/**
 * Run canonicalization test vectors from integrity_test_vectors.json.
 * Returns { passed, failed, results }.
 * All SDKs must achieve failed === 0 before any release.
 */
export function runTestVectors(vectors: {
  canonicalize_vectors: Array<{ id: string; desc: string; input: unknown; expected: string }>;
}): { passed: number; failed: number; results: TestResult[] } {
  const results: TestResult[] = [];

  for (const vec of vectors.canonicalize_vectors) {
    let got: string;
    let ok: boolean;
    try {
      got = canonicalize(vec.input);
      ok  = got === vec.expected;
    } catch (e) {
      got = `ERROR: ${e}`;
      ok  = false;
    }
    results.push({ id: vec.id, desc: vec.desc, ok, expected: vec.expected, got });
  }

  return {
    passed:  results.filter(r => r.ok).length,
    failed:  results.filter(r => !r.ok).length,
    results,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Safely remove 'sha256:' prefix.
 * Uses startsWith — avoids the lstrip() character-set bug.
 */
export function stripPrefix(h: string | undefined | null): string | null {
  if (!h) return null;
  return h.startsWith('sha256:') ? h.slice(7) : h;
}
