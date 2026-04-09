/**
 * DarkMatter Merkle Tree — Phase 3
 * ==================================
 * RFC 6962 Merkle hash tree over the append-only log.
 *
 * MERKLE LEAF SPEC v1 (frozen)
 * ────────────────────────────
 * Each leaf represents one log entry. The leaf input is the canonical
 * serialization of a "log entry envelope" — a small object binding the
 * commit to its exact position in the log:
 *
 *   leaf_envelope = {
 *     commit_id:      "ctx_...",
 *     integrity_hash: "<64-char hex>",   // no sha256: prefix
 *     log_position:   <integer>,
 *     accepted_at:    "<ISO-8601 UTC seconds>"
 *   }
 *
 *   leaf_hash = SHA256( 0x00 || UTF8( canonical(leaf_envelope) ) )
 *
 * Why a structured envelope and not just integrity_hash:
 *   - binds the commit to its exact position (position forgery detectable)
 *   - avoids duplicate-leaf ambiguity if two commits ever share a hash
 *   - consistent with CT-style transparency logs
 *
 * Internal node hash (RFC 6962 §2.1):
 *   node_hash = SHA256( 0x01 || left_hash || right_hash )
 *
 * Domain separation (0x00 / 0x01) prevents second-preimage attacks.
 */

'use strict';

const crypto = require('crypto');
const { canonicalize } = require('./integrity');

// ─────────────────────────────────────────────────────────────────────────────
// LEAF SPEC
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the canonical leaf envelope for a log entry.
 * All fields required. accepted_at must be seconds precision (no ms).
 */
function buildLeafEnvelope(commitId, integrityHash, logPosition, acceptedAt) {
  const ts = (acceptedAt || new Date().toISOString()).replace(/\.\d+Z?$/, '').replace(/Z?$/, 'Z');
  return {
    commit_id:      commitId,
    integrity_hash: integrityHash.replace('sha256:', ''), // bare hex
    log_position:   logPosition,
    accepted_at:    ts,
  };
}

/**
 * Compute the RFC 6962 leaf hash for a log entry.
 * leaf_hash = SHA256( 0x00 || UTF8(canonical(envelope)) )
 */
function leafHash(commitId, integrityHash, logPosition, acceptedAt) {
  const envelope  = buildLeafEnvelope(commitId, integrityHash, logPosition, acceptedAt);
  const canonical = canonicalize(envelope);
  const buf       = Buffer.concat([Buffer.from([0x00]), Buffer.from(canonical, 'utf8')]);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Compute leaf hash directly from a pre-built envelope string.
 * Used during proof verification.
 */
function leafHashFromCanonical(canonicalEnvelopeString) {
  const buf = Buffer.concat([Buffer.from([0x00]), Buffer.from(canonicalEnvelopeString, 'utf8')]);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// NODE HASH
// ─────────────────────────────────────────────────────────────────────────────

function nodeHash(left, right) {
  const buf = Buffer.concat([
    Buffer.from([0x01]),
    Buffer.from(left,  'hex'),
    Buffer.from(right, 'hex'),
  ]);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// TREE OPERATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute Merkle root from an array of leaf hashes (hex strings).
 */
function computeRoot(leafHashes) {
  if (!leafHashes || leafHashes.length === 0) {
    return crypto.createHash('sha256').update(Buffer.from([0x00])).digest('hex'); // empty tree
  }
  if (leafHashes.length === 1) return leafHashes[0];

  let nodes = [...leafHashes];
  while (nodes.length > 1) {
    const next = [];
    for (let i = 0; i < nodes.length; i += 2) {
      if (i + 1 < nodes.length) {
        next.push(nodeHash(nodes[i], nodes[i + 1]));
      } else {
        next.push(nodes[i]); // odd node promoted unchanged (RFC 6962 §2.1)
      }
    }
    nodes = next;
  }
  return nodes[0];
}

/**
 * Generate an inclusion proof for the leaf at leafIndex.
 *
 * Returns:
 *   { leaf_index, tree_size, proof: [{ hash, direction }] }
 *
 * direction: 'left' | 'right' — which side the sibling sits on.
 * To verify: start with leaf_hash, for each step hash with sibling
 * on the indicated side. Result must equal tree_root.
 */
function generateInclusionProof(leafHashes, leafIndex) {
  if (leafIndex < 0 || leafIndex >= leafHashes.length) {
    throw new Error(`leafIndex ${leafIndex} out of range [0, ${leafHashes.length})`);
  }

  const proof = [];
  let nodes   = [...leafHashes];
  let idx     = leafIndex;

  while (nodes.length > 1) {
    const next = [];
    for (let i = 0; i < nodes.length; i += 2) {
      const left   = nodes[i];
      const right  = i + 1 < nodes.length ? nodes[i + 1] : null;
      const parent = right ? nodeHash(left, right) : left;

      // Is our current position at i or i+1?
      if (i === idx || i + 1 === idx) {
        const ourSide     = (idx === i) ? 'left' : 'right';
        const siblingHash = ourSide === 'left' ? right : left;
        if (siblingHash) {
          // sibling sits opposite to us
          proof.push({ hash: siblingHash, direction: ourSide === 'left' ? 'right' : 'left' });
        }
        idx = Math.floor(i / 2); // our position in next level
      }
      next.push(parent);
    }
    nodes = next;
  }

  return { leaf_index: leafIndex, tree_size: leafHashes.length, proof };
}

/**
 * Verify an inclusion proof.
 *
 * @param {string} lHash        - The leaf hash (hex)
 * @param {object} proof        - { leaf_index, tree_size, proof: [{hash, direction}] }
 * @param {string} expectedRoot - The tree root to verify against (hex)
 * @returns {boolean}
 */
function verifyInclusionProof(lHash, proof, expectedRoot) {
  try {
    let current = lHash;
    for (const step of proof.proof) {
      current = step.direction === 'right'
        ? nodeHash(current,    step.hash)
        : nodeHash(step.hash,  current);
    }
    return current === expectedRoot;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSISTENCY PROOF (RFC 6962 §2.1.2)
// Proves tree_root_B is an append-only extension of tree_root_A.
// Phase 3.5 — lightweight version: just link previous checkpoint.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify that oldRoot (size oldSize) is a prefix of newRoot (size newSize).
 * Simplified: recompute oldRoot from first oldSize leaves and compare.
 *
 * @param {string[]} allLeafHashes - All leaf hashes in the full tree
 * @param {number}   oldSize       - Number of leaves in the old tree
 * @param {string}   oldRoot       - Expected root of the old tree
 * @param {string}   newRoot       - Expected root of the new tree
 */
function verifyConsistency(allLeafHashes, oldSize, oldRoot, newRoot) {
  if (oldSize > allLeafHashes.length) return false;
  const recomputedOld = computeRoot(allLeafHashes.slice(0, oldSize));
  const recomputedNew = computeRoot(allLeafHashes);
  return recomputedOld === oldRoot && recomputedNew === newRoot;
}

module.exports = {
  buildLeafEnvelope,
  leafHash,
  leafHashFromCanonical,
  nodeHash,
  computeRoot,
  generateInclusionProof,
  verifyInclusionProof,
  verifyConsistency,
};
