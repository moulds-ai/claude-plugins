---
name: moulds-ship
description: Use when the user wants to publish, ship, deploy, or monetize an automation in the current directory to moulds.ai — an MCP server, a script, or just an idea. Turns it into a live marketplace agent. Triggers on "ship this to moulds.ai", "turn this MCP server into an agent", "publish this to moulds", "deploy this as an agent", "monetize this automation".
---

# moulds-ship

Turn whatever is in the current directory into a deployed agent on the **moulds.ai** marketplace. The headline case: an **MCP server** → a hosted agent whose tools become callable HTTP endpoints, each running the server inside an isolated sandbox.

Scripts live at `$CLAUDE_PLUGIN_ROOT/scripts/` (this skill's base directory is `<plugin>/skills/moulds-ship`; the scripts are two levels up under `scripts/`). All scripts are zero-dependency Node (require Node 18+); they shell out to `npx esbuild` and the system `zip` only for the MCP path.

To target a non-production platform (local dev or staging), set `MOULDS_BASE_URL` (e.g. `http://localhost:3000`) in the environment for every command. Default is `https://app.moulds.ai`.

## Process — follow in order

### 1. Detect what's here
Run:
```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/detect.mjs"
```
It prints JSON with a `type`: `mcp`, `manifest`, `script`, `mcp-python`, or `idea`.

### 2. Show the plan and confirm (once)
Tell the user, in 2-3 lines: what was detected, the agent name/slug it will get, and — for MCP — that each tool becomes a `POST /api/<tool>` endpoint. Ask for a single go-ahead. Don't over-ask; the user invoked this skill on purpose.

### 3. Ensure authorization
Run (this may open a browser and **wait** for the user to approve — use a generous Bash timeout, ~300000 ms):
```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/login.mjs"
```
It prints a short code + a URL to stderr. Relay that to the user and tell them to approve in the browser. The token is cached at `~/.moulds/credentials.json`; subsequent runs skip this.

### 4. Ship, by detected type

**`mcp`** — fully automatic. Run from the MCP server's directory:
```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/ship.mjs"
```
This bundles the server (esbuild → single file), introspects its tools, generates the Tier-2 manifest + a per-tool stdio adapter, zips it, creates the app, uploads + activates the package, and submits for review.

**`manifest`** (a `manifest.json` already present) — run `ship.mjs`; it validates and publishes. If the file is `manifest.yaml`, first convert it to `manifest.json` yourself (read the YAML, write equivalent JSON), then run `ship.mjs`.

**`script` or `idea`** (no MCP server, no manifest) — **you draft a Tier-1 manifest.** Ask the user 1-2 quick questions if the purpose/inputs are unclear, then write a `manifest.json` using the template below, then run:
```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/ship.mjs" --manifest manifest.json
```

**`mcp-python`** — not supported in V1 (the sandbox runtime is node20). Tell the user to re-implement as a Node MCP server, or offer to draft a Tier-1 agent (the `idea` path) instead.

### 5. Report
On success `ship.mjs` prints JSON with `slug`, `dashboard_url`, and `public_url_after_approval`. Tell the user: it's shipped and **pending admin approval** before it appears publicly at `/agents/<slug>`; they can view/manage it now at the dashboard URL. For MCP agents, list the tool endpoints that are now live.

## Tier-1 manifest template (for the script / idea path)

Fill every `<…>`. `shape: batch_analyzer` = "inputs in → AI processes → report out". Keep one `ai_generate` step + one `render_report` step unless the user needs more.

```json
{
  "manifest_version": 1,
  "slug": "<kebab-case-slug>",
  "name": "<Display Name>",
  "shape": "batch_analyzer",
  "category": "<e.g. research-tools>",
  "landing": { "tagline": "<one line>", "description": "<2-3 sentences>" },
  "integrations": [],
  "inputs": [
    { "kind": "text", "name": "<input_name>", "label": "<Label>", "required": true }
  ],
  "pipeline": [
    {
      "step": "ai_generate",
      "config": {
        "model": "flash",
        "prompt_template": "<instructions using {{input_name}} placeholders>",
        "output_schema": { "type": "object" },
        "knowledge_collections": []
      }
    },
    { "step": "render_report", "config": { "template": "<HTML using {{outputs}}>" } }
  ],
  "pricing": { "free_trial": { "quantity": 25, "period_days": 30 }, "plans": [] },
  "platform_fee_pct": 15
}
```

## Red flags — stop and reconsider
- **Don't invent integration secrets.** A converted MCP server runs in the sandbox with NO env vars set, so MCP servers needing API keys won't work in V1 — warn the user; their server must be self-contained (e.g. `fetch`, `time`, computation). (BYOK wiring is a follow-on.)
- **Don't claim it's "live to the public" yet** — everything ships **pending admin approval**. Be precise.
- **Don't skip the plan/confirm step** for destructive surprises (e.g. a slug collision will fail; let the user rename).
- **Don't hand-edit `~/.moulds/credentials.json`** — re-run `login.mjs --force` to refresh.
