/**
 * darkmatter-js — TypeScript/Node.js SDK v1.2
 * ============================================
 * Phase 1: client-side hashing + envelope signatures
 *
 * npm install darkmatter-js
 * Requires Node.js 18+ (native fetch)
 */

export {
  SCHEMA_VERSION,
  canonicalize,
  hashPayload,
  buildEnvelope,
  hashEnvelope,
  computeIntegrityHash,
  validateClientHashes,
  verifyEnvelopeSignature,
  verifyChain,
  stripPrefix,
  runTestVectors,
} from './integrity';

export type {
  CommitEnvelope,
  ChainVerifyResult,
  ChainStep,
  ClientHashValidation,
  CommitRecord,
  TestResult,
} from './integrity';

import {
  hashPayload,
  buildEnvelope,
  hashEnvelope,
  computeIntegrityHash,
  stripPrefix,
} from './integrity';

import type { CommitEnvelope } from './integrity';

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

const DM_BASE = 'https://darkmatterhub.ai';

interface SDKState {
  apiKey:       string | null;
  agentId:      string | null;
  keyId:        string;
  baseUrl:      string;
  lastCtxId:    string | null;
  lastIntegrity: string | null;
}

const state: SDKState = {
  apiKey:        null,
  agentId:       null,
  keyId:         'default',
  baseUrl:       DM_BASE,
  lastCtxId:     null,
  lastIntegrity: null,
};

export function configure(options: {
  apiKey?:  string;
  agentId?: string;
  keyId?:   string;
  baseUrl?: string;
}): void {
  if (options.apiKey)  state.apiKey  = options.apiKey;
  if (options.agentId) state.agentId = options.agentId;
  if (options.keyId)   state.keyId   = options.keyId;
  if (options.baseUrl) state.baseUrl = options.baseUrl.replace(/\/$/, '');
}

function getApiKey(override?: string): string {
  const key = override ?? state.apiKey ?? process.env.DARKMATTER_API_KEY ?? '';
  if (!key) throw new Error(
    'No API key. Call configure({ apiKey }) or set DARKMATTER_API_KEY.\n' +
    'Get a free key: https://darkmatterhub.ai/signup'
  );
  return key;
}

function getAgentId(override?: string): string {
  const id = override ?? state.agentId ?? process.env.DARKMATTER_AGENT_ID ?? '';
  if (!id) throw new Error(
    'No agent ID. Call configure({ agentId }) or set DARKMATTER_AGENT_ID.'
  );
  return id;
}

function headers(apiKey: string): Record<string, string> {
  return {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'User-Agent':    'darkmatter-js/1.2.0',
  };
}

async function request<T>(
  method:  string,
  path:    string,
  body?:   unknown,
  apiKey?: string,
): Promise<T> {
  const key      = getApiKey(apiKey);
  const url      = (state.baseUrl || DM_BASE) + path;
  const response = await fetch(url, {
    method,
    headers: headers(key),
    body:    body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json() as T & { error?: string };
  if (!response.ok || (data as { error?: string }).error) {
    throw new Error((data as { error?: string }).error ?? `HTTP ${response.status}`);
  }
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface CommitOptions {
  toAgentId:    string;
  payload:      Record<string, unknown>;
  parentId?:    string;
  traceId?:     string;
  branchKey?:   string;
  eventType?:   string;
  agent?:       { role?: string; provider?: string; model?: string };
  /** Pre-computed Ed25519 signature over canonical(envelope). Hex string. */
  agentSignature?: string;
  /** Override the agent ID for this commit */
  agentId?:     string;
  /** Override the key ID for this commit */
  keyId?:       string;
  /** If true, last commit ID is used as parentId automatically */
  autoThread?:  boolean;
  apiKey?:      string;
}

export interface CommitReceipt {
  id:              string;
  schema_version:  string;
  integrity_hash:  string;
  payload_hash:    string;
  parent_hash:     string | null;
  verified:        boolean;
  timestamp:       string;
  _log?:           LogReceipt;
  _warnings?:      string[];
  /** The envelope that was hashed and signed — for local verification */
  _envelope?:      CommitEnvelope;
}

export interface LogReceipt {
  position:    number;
  log_root:    string;
  server_sig:  string;
  timestamp:   string;
  pubkey_url:  string;
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Commit agent context to DarkMatter.
 *
 * Phase 1 guarantees (all computed client-side before transmission):
 *   - payload_hash  = SHA-256( canonical(payload) )
 *   - integrity_hash = SHA-256( canonical(envelope) )
 *     where envelope binds: payload_hash + parent + agent_id + key_id + timestamp
 *   - agentSignature = Ed25519 sign( canonical(envelope) )  [if provided]
 *
 * Server recomputes and validates all hashes.
 * Mismatches are flagged in receipt._warnings, not silently corrected.
 */
export async function commit(options: CommitOptions): Promise<CommitReceipt> {
  const {
    toAgentId, payload, parentId, traceId, branchKey, eventType,
    agent, agentSignature, autoThread = true, apiKey,
  } = options;

  const agentId = getAgentId(options.agentId);
  const keyId   = options.keyId ?? state.keyId;
  const ts      = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  // Resolve parent for auto-threading
  const resolvedParent = parentId
    ?? (autoThread ? state.lastCtxId ?? undefined : undefined);

  // Client-side hashing — Phase 1
  const { payloadHash, integrityHash, envelope } = computeIntegrityHash(
    payload,
    state.lastIntegrity && autoThread && !parentId ? state.lastIntegrity : null,
    agentId,
    keyId,
    ts,
  );

  const body = {
    toAgentId,
    payload,
    payload_hash:    payloadHash,
    integrity_hash:  integrityHash,
    envelope,
    ...(agentSignature ? { agent_signature: agentSignature } : {}),
    ...(resolvedParent ? { parentId: resolvedParent } : {}),
    ...(traceId        ? { traceId }  : {}),
    ...(branchKey      ? { branchKey } : {}),
    ...(eventType      ? { eventType } : {}),
    ...(agent          ? { agent }     : {}),
  };

  const receipt = await request<CommitReceipt>('POST', '/api/commit', body, apiKey);

  // Attach envelope to receipt for local verification
  receipt._envelope = envelope;

  // Update auto-threading state
  state.lastCtxId    = receipt.id;
  state.lastIntegrity = integrityHash;

  return receipt;
}

export async function replay(
  ctxId:   string,
  options?: { mode?: 'full' | 'summary'; apiKey?: string },
): Promise<unknown> {
  const mode = options?.mode ?? 'full';
  return request('GET', `/api/replay/${ctxId}?mode=${mode}`, undefined, options?.apiKey);
}

export async function fork(
  ctxId:   string,
  options?: { branchKey?: string; apiKey?: string },
): Promise<unknown> {
  return request('POST', `/api/fork/${ctxId}`,
    options?.branchKey ? { branchKey: options.branchKey } : {}, options?.apiKey);
}

export async function verify(ctxId: string, apiKey?: string): Promise<unknown> {
  return request('GET', `/api/verify/${ctxId}`, undefined, apiKey);
}

export async function diff(ctxIdA: string, ctxIdB: string, apiKey?: string): Promise<unknown> {
  return request('GET', `/api/diff?a=${ctxIdA}&b=${ctxIdB}`, undefined, apiKey);
}

export async function bundle(ctxId: string, apiKey?: string): Promise<unknown> {
  return request('GET', `/api/export/${ctxId}`, undefined, apiKey);
}

export async function me(apiKey?: string): Promise<unknown> {
  return request('GET', '/api/me', undefined, apiKey);
}

export async function checkpoint(apiKey?: string): Promise<{ checkpoint: unknown; pubkey_url: string }> {
  return request('GET', '/api/log/checkpoint', undefined, apiKey);
}

export async function serverPubkey(): Promise<string> {
  const data = await request<{ public_key: string }>('GET', '/api/log/pubkey');
  return data.public_key;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLASS INTERFACE (for those who prefer it)
// ─────────────────────────────────────────────────────────────────────────────

export class DarkMatter {
  constructor(options?: { apiKey?: string; agentId?: string; keyId?: string; baseUrl?: string }) {
    if (options) configure(options);
  }
  commit   = commit;
  replay   = replay;
  fork     = fork;
  verify   = verify;
  diff     = diff;
  bundle   = bundle;
  me       = me;
  checkpoint = checkpoint;
}

export default DarkMatter;
