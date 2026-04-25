# DarkMatter × Anthropic SDK

Auto-instrument every `messages.create()` call with one import change.

## Install

```bash
pip install darkmatter-sdk anthropic
```

## Quickstart

```python
from darkmatter.integrations.anthropic import Anthropic

client = Anthropic(
    dm_api_key  = "dm_sk_...",   # or set DARKMATTER_API_KEY
    dm_agent_id = "dm_...",      # or set DARKMATTER_AGENT_ID
)

# Identical to the standard Anthropic client:
response = client.messages.create(
    model     = "claude-sonnet-4-6",
    max_tokens= 1024,
    messages  = [{"role": "user", "content": "Should I approve this refund?"}],
)

print(response.content[0].text)
# → Every call is automatically committed to DarkMatter
```

## With L3 signing

```python
from darkmatter.integrations.anthropic import Anthropic
import darkmatter as dm

client = Anthropic(
    dm_api_key  = "dm_sk_...",
    dm_agent_id = "dm_...",
    dm_signing  = dm.SigningConfig(
        key_id           = "my-signing-key",
        private_key_path = "./my-signing-key.pem",
    ),
)
```

Every commit is signed before reaching DarkMatter. Verification requires only your public key.

## What gets committed

For each `messages.create()` call:

| Field | Value |
|---|---|
| `payload.input` | Last 4 turns of the conversation |
| `payload.output` | Full assistant response text |
| `payload.model` | Model name (e.g. `claude-sonnet-4-6`) |
| `payload.elapsed_ms` | Latency of the API call |
| `payload.stop_reason` | `end_turn`, `tool_use`, etc. |
| `payload.tool_calls` | Array of tool use blocks (if any) |
| `metadata.input_tokens` | Token usage |
| `metadata.output_tokens` | Token usage |
| `event_type` | `anthropic.messages.create` |
| `completeness_claim` | `True` — wrapper observed full request + response |

Tool calls are also committed as separate child records with `event_type: anthropic.tool_call`.

## Coverage assertion

Each commit carries `completeness_claim=True` scoped to the **observed API call**:

> "The wrapper observed this Anthropic API call and committed it completely."

This is NOT an assertion about the broader agent workflow. For full workflow coverage, use this wrapper for every call in your agent loop.

## Options

| Parameter | Default | Description |
|---|---|---|
| `dm_api_key` | `DARKMATTER_API_KEY` | DarkMatter API key |
| `dm_agent_id` | `DARKMATTER_AGENT_ID` | DarkMatter agent ID |
| `dm_signing` | `None` | `SigningConfig` for L3 |
| `dm_event_type` | `anthropic.messages.create` | Custom event type label |
| `dm_metadata` | `None` | Extra metadata on every commit |
| `dm_auto_commit` | `True` | Set `False` to disable |
| `dm_commit_tools` | `True` | Set `False` to skip tool call commits |
| `dm_async` | `True` | Commits sent in background thread |
| `dm_debug` | `False` | Print commit errors with full traceback |

## Async

```python
from darkmatter.integrations.anthropic import AsyncAnthropic

client = AsyncAnthropic(
    dm_api_key  = "dm_sk_...",
    dm_agent_id = "dm_...",
)

response = await client.messages.create(...)
# Commits are sent in a background thread — no async overhead
```

## Disable for a single call

```python
# Disable auto-commit globally
client = Anthropic(dm_api_key="...", dm_agent_id="...", dm_auto_commit=False)

# Or just use the standard client for calls you don't want committed
import anthropic
raw_client = anthropic.Anthropic()
```
