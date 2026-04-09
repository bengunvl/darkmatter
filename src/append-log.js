/**
 * DarkMatter Append-Only Log — Phase 3
 * ======================================
 * Every commit appended here gets:
 *   - a log_position (sequential, immutable)
 *   - a leaf_hash (RFC 6962, over canonical leaf envelope)
 *   - a tree_root (Merkle root of all leaves 0..position)
 *   - a log_root (running SHA-256 hash chain — Phase 2 compatibility)
 *   - an inclusion_proof (derivable on demand)
 *   - a server_sig over the checkpoint envelope
 *
 * Failure semantics:
 *   - appendToLog throws → caller sets proof_status = 'proof_unavailable'
 *   - tree build fails   → commit still stored, proof_status = 'pending'
 *   - checkpoint fails   → proof_status = 'included' (not yet 'checkpointed')
 */

'use strict';

const crypto = require('crypto');
const { canonicalize }                         = require('./integrity');
const { leafHash, computeRoot,
        generateInclusionProof,
        buildLeafEnvelope }                    = require('./merkle');

// ─────────────────────────────────────────────────────────────────────────────
// SERVER SIGNING KEY
// ─────────────────────────────────────────────────────────────────────────────

let _serverKey    = null;
let _serverPubPem = null;

function _initKey() {
  if (_serverKey) return;
  if (process.env.DM_LOG_SIGNING_KEY_PEM) {
    _serverKey = crypto.createPrivateKey(process.env.DM_LOG_SIGNING_KEY_PEM);
  } else {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    _serverKey = privateKey;
    console.warn('[append-log] WARNING: Using ephemeral signing key. Set DM_LOG_SIGNING_KEY_PEM.');
  }
  _serverPubPem = crypto.createPublicKey(_serverKey).export({ type: 'spki', format: 'pem' });
}

function getServerPublicKeyPem() { _initKey(); return _serverPubPem; }

// ─────────────────────────────────────────────────────────────────────────────
// LOG ROOT (Phase 2 — running hash chain, kept for backwards compat)
// ─────────────────────────────────────────────────────────────────────────────

function computeLogRoot(prevLogRoot, integrityHash) {
  const prev  = prevLogRoot || 'genesis';
  return crypto.createHash('sha256').update(prev + ':' + integrityHash, 'utf8').digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECKPOINT SIGNING
// Checkpoint envelope (what gets signed):
// {
//   schema_version:      "3",
//   checkpoint_id:       "cp_<timestamp>_<hex>",
//   tree_root:           "<hex>",
//   tree_size:           <int>,
//   log_root:            "<hex>",
//   log_position:        <int>,
//   timestamp:           "<ISO seconds>",
//   previous_cp_id:      "<cp_...> | null",
//   previous_tree_root:  "<hex> | null"
// }
// ─────────────────────────────────────────────────────────────────────────────

const CHECKPOINT_SCHEMA_VERSION = '3';

function buildCheckpointEnvelope(treeRoot, treeSize, logRoot, logPosition, timestamp, prevCpId, prevTreeRoot) {
  const ts = timestamp.replace(/\.\d+Z?$/, '').replace(/Z?$/, 'Z');
  return {
    schema_version:      CHECKPOINT_SCHEMA_VERSION,
    checkpoint_id:       `cp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    tree_root:           treeRoot,
    tree_size:           treeSize,
    log_root:            logRoot,
    log_position:        logPosition,
    timestamp:           ts,
    previous_cp_id:      prevCpId   || null,
    previous_tree_root:  prevTreeRoot || null,
  };
}

function signCheckpointEnvelope(envelope) {
  _initKey();
  const msg = Buffer.from(canonicalize(envelope), 'utf8');
  return crypto.sign(null, msg, _serverKey).toString('hex');
}

function verifyCheckpointSig(envelope, signatureHex, publicKeyPem) {
  try {
    const msg    = Buffer.from(canonicalize(envelope), 'utf8');
    const sig    = Buffer.from(signatureHex, 'hex');
    const pubKey = crypto.createPublicKey(publicKeyPem);
    return crypto.verify(null, msg, pubKey, sig);
  } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APPEND — called inside commit transaction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Append a commit to the log. Computes leaf_hash, tree_root, and log_root.
 *
 * @returns {object} {
 *   position, leaf_hash, tree_root, tree_size, log_root, accepted_at,
 *   inclusion_proof: { leaf_index, tree_size, proof: [{hash, direction}] }
 * }
 */
async function appendToLog(supabaseService, commitId, integrityHash) {
  const accepted_at = new Date().toISOString().replace(/\.\d+Z?$/, 'Z');

  // Fetch all existing log entries (sorted) for tree construction
  const { data: existing, error: fetchErr } = await supabaseService
    .from('log_entries')
    .select('position, leaf_hash, log_root')
    .order('position', { ascending: true });

  if (fetchErr) throw new Error(`Log fetch failed: ${fetchErr.message}`);

  const prevEntries  = existing || [];
  const newPosition  = prevEntries.length;
  const prevLogRoot  = prevEntries.length > 0
    ? prevEntries[prevEntries.length - 1].log_root
    : null;

  // Compute this entry's leaf hash
  const lHash = leafHash(commitId, integrityHash, newPosition, accepted_at);

  // Build full leaf set for Merkle root computation
  const allLeafHashes = [
    ...prevEntries.map(e => e.leaf_hash),
    lHash,
  ];
  const treeRoot  = computeRoot(allLeafHashes);
  const treeSize  = allLeafHashes.length;
  const logRoot   = computeLogRoot(prevLogRoot, integrityHash);

  // Generate inclusion proof for this commit
  const inclusionProof = generateInclusionProof(allLeafHashes, newPosition);

  // Insert log entry
  const { error: insertErr } = await supabaseService
    .from('log_entries')
    .insert({
      position:       newPosition,
      commit_id:      commitId,
      integrity_hash: integrityHash,
      leaf_hash:      lHash,
      tree_root:      treeRoot,
      tree_size:      treeSize,
      log_root:       logRoot,
      server_sig:     '',   // placeholder — checkpoint signs the tree, not each entry
      timestamp:      accepted_at,
    });

  if (insertErr) throw new Error(`Log insert failed: ${insertErr.message}`);

  return {
    position:       newPosition,
    leaf_hash:      lHash,
    tree_root:      treeRoot,
    tree_size:      treeSize,
    log_root:       logRoot,
    accepted_at,
    inclusion_proof: inclusionProof,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PROOF GENERATION (on demand, from stored leaf hashes)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate an inclusion proof for any commit by ID.
 * Fetches all leaf hashes up to and including this commit's position.
 */
async function generateProofForCommit(supabaseService, commitId) {
  // Find this commit's log entry
  const { data: entry } = await supabaseService
    .from('log_entries')
    .select('position, leaf_hash, tree_root, tree_size, integrity_hash, timestamp')
    .eq('commit_id', commitId)
    .single();

  if (!entry) return null;

  // Fetch all entries up to tree_size at time of append
  const { data: allEntries } = await supabaseService
    .from('log_entries')
    .select('leaf_hash')
    .lte('position', entry.tree_size - 1)
    .order('position', { ascending: true });

  const allLeafHashes = (allEntries || []).map(e => e.leaf_hash);

  // Recompute to verify consistency
  const recomputedRoot = computeRoot(allLeafHashes);
  const consistent     = recomputedRoot === entry.tree_root;

  const proof = generateInclusionProof(allLeafHashes, entry.position);

  // Build leaf envelope for verifier
  const leafEnvelope = buildLeafEnvelope(
    commitId, entry.integrity_hash, entry.position, entry.timestamp
  );

  return {
    commit_id:      commitId,
    log_position:   entry.position,
    tree_size:      entry.tree_size,
    tree_root:      entry.tree_root,
    leaf_hash:      entry.leaf_hash,
    leaf_envelope:  leafEnvelope,
    consistent,
    inclusion_proof: proof,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LOG CONSISTENCY VERIFICATION
// ─────────────────────────────────────────────────────────────────────────────

function verifyLogConsistency(entries, pubKeyPem) {
  let prevRoot  = null;
  let brokenAt  = null;

  for (const entry of entries) {
    // Rebuild log root
    const expectedLogRoot = computeLogRoot(prevRoot, entry.integrity_hash);
    if (expectedLogRoot !== entry.log_root) {
      brokenAt = entry.position; break;
    }
    prevRoot = entry.log_root;
  }

  return {
    consistent:      brokenAt === null,
    broken_at:       brokenAt,
    entries_checked: entries.length,
  };
}

module.exports = {
  getServerPublicKeyPem,
  computeLogRoot,
  buildCheckpointEnvelope,
  signCheckpointEnvelope,
  verifyCheckpointSig,
  appendToLog,
  generateProofForCommit,
  verifyLogConsistency,
  CHECKPOINT_SCHEMA_VERSION,
};
