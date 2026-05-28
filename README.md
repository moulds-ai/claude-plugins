# moulds.ai plugins for Claude Code

Turn your automations into deployed, monetizable agents on the [moulds.ai](https://app.moulds.ai) marketplace — without leaving Claude Code.

## Install

```
/plugin marketplace add moulds-ai/claude-plugins
/plugin install moulds-ship
```

## `moulds-ship`

In any directory containing an automation, tell Claude:

> **"ship this to moulds.ai"**

The skill detects what's there and publishes it:

| In your directory | What you get |
|---|---|
| an **MCP server** (Node) | a hosted Tier-2 agent — each MCP tool becomes a `POST /api/<tool>` endpoint, run in an isolated sandbox per request |
| an existing **`manifest.json`** | validated and published as-is |
| a **script** or just an **idea** | Claude drafts a Tier-1 agent manifest, then publishes it |

It bundles your code (esbuild → single file), authorizes via a one-time browser confirmation (device flow → a personal access token cached in `~/.moulds/credentials.json`), creates the app, uploads + activates the bundle, and submits it for review. You get a dashboard link; once an admin approves, it's public at `app.moulds.ai/agents/<slug>`.

### The MCP path in one line

A `fetch`/`time`/compute MCP server in your cwd becomes a live, callable agent on moulds.ai. The generated bundle spawns your server over stdio per request and forwards the request body as the tool's arguments.

### Requirements & V1 limits

- **Node 18+**, plus `npx` (esbuild) and the `zip` CLI for the MCP path.
- The sandbox runtime is **node20** — **Python MCP servers are not supported yet**.
- A converted MCP server runs with **no environment variables** set, so V1 best fits **self-contained** servers (no API keys). BYOK wiring is a follow-on.
- Everything ships **pending admin approval** before public listing.

### Target a different platform

```
MOULDS_BASE_URL=http://localhost:3000   # default: https://app.moulds.ai
```

## Layout

```
.claude-plugin/marketplace.json     # marketplace definition
plugins/moulds-ship/
  .claude-plugin/plugin.json
  skills/moulds-ship/SKILL.md        # the skill Claude follows
  scripts/                           # zero-dependency Node helpers
    detect.mjs  login.mjs  ship.mjs  lib.mjs
```

## License

MIT
