# 🌑 DarkMatter

> **AI decisions are easy to make. Proving them is the hard part.**
> DarkMatter is the independent verification and audit layer for AI agent decisions.

---

## What it is

When an AI agent makes a decision — approving a refund, locking an account, sending a message, modifying a file — that decision needs to be provable. Not just logged. Provable: cryptographically, to anyone, offline, without depending on DarkMatter to be honest.

DarkMatter records each agent action as an immutable commit, hashed client-side, chained to its parent, and anchored to an external timestamp. The result is a record you can hand to legal, compliance, or a counterparty — and they can verify it themselves.

**Manus-type products do the work. DarkMatter makes the work safe, provable, and controllable.**

---

## The core primitive: commit

One call. Every decision becomes a verifiable record.

```python
import darkmatter as dm

ctx = dm.commit(payload={
    "input":  "Approve refund for order #84721?",
    "output": "Approved. Reason: within 30-day window.",
})

print(ctx["verify_url"])  # share with anyone — no login required
```

That's it. DarkMatter handles the hashing, chaining, timestamping, and signing.

---

## Install

```bash
pip install darkmatter-sdk
```

```bash
npm install darkmatter-js
```

Get your API key at [darkmatterhub.ai/signup](https://darkmatterhub.ai/signup) — free, no credit card.

---

## How it works

Every `dm.commit()` call:

1. **Hashes the payload** client-side (SHA-256) before sending
2. **Chains to the previous commit** via `parent_hash` — tampering at any node breaks every downstream hash
3. **Commits to an append-only log** — records cannot be modified after writing
4. **Returns a `verify_url`** — anyone can independently verify the record, no login needed

```python
import darkmatter as dm

# Multi-step pipeline — each step chained to the previous
ctx1 = dm.commit(payload={"input": "Raw contract text", "output": "Key clauses extracted"})
ctx2 = dm.commit(payload={"input": "Key clauses", "output": "Risk score: HIGH"}, parent_id=ctx1["id"])
ctx3 = dm.commit(payload={"input": "Risk: HIGH", "output": "Escalated to human review"}, parent_id=ctx2["id"])

# Verify the full chain
print(dm.verify(ctx3["id"]))  # {"intact": true, "chain_length": 3}

# Export a portable proof bundle — verifiable offline, no DarkMatter dependency
bundle = dm.export(ctx3["id"])
```

---

## API

| Operation | What it does | When to use |
|-----------|-------------|-------------|
| `dm.commit(payload, parent_id?)` | Record an agent decision | After every consequential agent action |
| `dm.verify(ctx_id)` | Prove the chain was never modified | Before sharing with legal/compliance |
| `dm.export(ctx_id)` | Download a portable proof bundle | For offline verification, legal discovery |
| `dm.replay(ctx_id)` | Walk the full decision chain root→tip | For audits and debugging |
| `dm.fork(ctx_id)` | Branch from a checkpoint without modifying original | For counterfactual analysis |

---

## What DarkMatter closes

| Without DarkMatter | With DarkMatter |
|--------------------|-----------------|
| "The agent said it approved this" | Cryptographic proof of what was approved, when, with what input |
| Log files anyone can edit | Append-only chain — tampering is mathematically detectable |
| Trust the operator | Verify independently — no dependency on DarkMatter's honesty |
| Buried in your infrastructure | Portable proof bundle — share with legal, compliance, counterparty |

---

## Integrations

Works with any language, any model, any framework:

- **LangGraph** — `DarkMatterTracer(app)` wraps your compiled graph in one line
- **LangChain** — `DarkMatterCallbackHandler` auto-commits after each LLM call
- **CrewAI** — commit after each task output, chain across crew members
- **Anthropic SDK** — `dm_client(anthropic.Anthropic())` wraps the client
- **OpenAI SDK** — same wrapper pattern
- **AWS Bedrock**, **Google ADK**, **local models (Ollama, vLLM)** — all supported

Full integration docs at [darkmatterhub.ai/docs](https://darkmatterhub.ai/docs).

---

## TypeScript / Node.js

```typescript
import { commit, verify } from 'darkmatter-js';

const ctx = await commit({
  payload: { input: prompt, output: result },
});

const proof = await verify(ctx.id);
console.log(proof.intact); // true
```

---

## Verification model

Three levels of guarantee:

**Level 1 — Verifiable Record** (live)
SHA-256 payload hash + parent chain linkage. Tampering at any node breaks every downstream hash. Independent offline verifier included.

**Level 2 — Independent Verification** (live)
Signed checkpoint bundles anchored to Bitcoin via OpenTimestamps. Timestamp proof lives outside DarkMatter's infrastructure entirely.

**Level 3 — Non-Repudiation** (roadmap)
Customer-held signing keys. Even DarkMatter cannot forge a record.

Full integrity model: [darkmatterhub.ai/integrity](https://darkmatterhub.ai/integrity)

---

## The open format

The commit format is [publicly specified](INTEGRITY_SPEC_V1.md). You can build your own verifier — no DarkMatter dependency required.

```bash
python verify_darkmatter_chain.py my_bundle.json
# ✓ Chain intact — 12 commits, 0 tampered
```

---

## Quickstart

> ⚠️ The code below is Python. Run it in a `.py` file or the Python REPL (`python3`), not in bash/terminal directly.

```bash
# 1. Install
pip install darkmatter-sdk

# 2. Set your API key (get one free at darkmatterhub.ai/signup)
export DARKMATTER_API_KEY=dm_sk_...

# 3. Run Python
python3
```

```python
import darkmatter as dm

ctx = dm.commit(payload={
    "input":  "Should I approve this transaction?",
    "output": "Approved. Amount within limit, user verified.",
})
print(ctx["verify_url"])
```

---

## Repository structure

```
src/                  Node.js/Express API server (Railway)
public/               Frontend HTML pages
sdk/typescript/       TypeScript SDK (npm: darkmatter-js)
test/                 Smoke tests (node test/smoke.test.js)
supabase/             Database migrations
INTEGRITY_SPEC_V1.md  Open format specification
CONTEXT_PASSPORT.md   Context object schema
```

---

## Links

- [darkmatterhub.ai](https://darkmatterhub.ai)
- [Docs](https://darkmatterhub.ai/docs)
- [Integrity model](https://darkmatterhub.ai/integrity)
- [PyPI: darkmatter-sdk](https://pypi.org/project/darkmatter-sdk/)
- [npm: darkmatter-js](https://www.npmjs.com/package/darkmatter-js)
- [Feedback & bugs](https://github.com/darkmatter-hub/darkmatter-feedback/issues)
