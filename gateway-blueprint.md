# AI Gateway Blueprint

## Architecture

```
Goose (research) + OpenCode (code)
        ↓ Bearer: AUTH_KEY
Cloudflare Worker — smart routing + key rotation
        ↓ Durable Objects (key state + cooldowns)
Cloudflare AI Gateway — cache + analytics
        ↓
Gemini (6+ keys) → Groq (3+) → Mistral → Cerebras → Fallbacks
        ↓
Obsidian Vault ← MCP Server ← Both agents
```

---

## Smart Key Selection

Worker auto-selects model and key. You don't need to specify unless overriding.

**Tier order (best available wins):**
1. `gemini-2.5-pro` — quality, 25 req/day per key
2. `gemini-2.0-flash` — fast, 1500 req/day per key
3. `llama-3.3-70b-versatile` (Groq) — speed, 14.4k/day
4. `llama3.1-70b` (Cerebras) — ultra-fast
5. `mistral-small-latest` — fallback

**Cooldown logic:**
- `429` (per-minute) → cooldown = `Retry-After` seconds
- `403` (daily quota) → cooldown until midnight UTC
- Auto-retry with next available key, same request

**With 6 Gemini keys:**
- 150 quality requests/day (2.5 Pro)
- 9,000 requests/day (2.0 Flash)

---

## Phase 1 — Gateway

### 1. Scaffold Worker
```bash
mkdir ai-gateway && cd ai-gateway
npm create cloudflare@latest . -- --type worker --lang ts
```

### 2. wrangler.toml
```toml
name = "ai-gateway-brain"
main = "src/index.ts"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]

[[durable_objects.bindings]]
name = "KEY_STORE"
class_name = "KeyStore"

[[migrations]]
tag = "v1"
new_classes = ["KeyStore"]

[vars]
GATEWAY_ACCOUNT_ID = "YOUR_CF_ACCOUNT_ID"
GATEWAY_ID = "YOUR_GATEWAY_ID"
```

### 3. Deploy + Seed Keys
```bash
wrangler secret put AUTH_KEY
wrangler secret put GATEWAY_TOKEN
wrangler deploy

curl -X POST https://ai-gateway-brain.YOUR.workers.dev/admin/keys \
  -H "Authorization: Bearer YOUR_AUTH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "keys": [
      {"id":"gem-1","provider":"gemini","apiKey":"AIza..."},
      {"id":"gem-2","provider":"gemini","apiKey":"AIza..."},
      {"id":"gem-3","provider":"gemini","apiKey":"AIza..."},
      {"id":"gem-4","provider":"gemini","apiKey":"AIza..."},
      {"id":"gem-5","provider":"gemini","apiKey":"AIza..."},
      {"id":"gem-6","provider":"gemini","apiKey":"AIza..."},
      {"id":"groq-1","provider":"groq","apiKey":"gsk_..."},
      {"id":"mistral-1","provider":"mistral","apiKey":"..."}
    ]
  }'
```

### 4. Cloudflare AI Gateway (Dashboard)
```
AI → AI Gateway → Create → name: ai-gateway-prod

Caching: ON, TTL: 300s
Auth: ON → generate GATEWAY_TOKEN
Rate Limiting: ON
```

Gateway ID is in the URL after creation.

---

## Phase 1B — Key Pool

| Provider | Model | Limit | Target |
|---|---|---|---|
| Google AI Studio | gemini-2.5-pro | 25/day | 10+ keys |
| Google AI Studio | gemini-2.0-flash | 1500/day | same keys |
| Groq | llama-3.3-70b | 14.4k/day | 3+ keys |
| Cerebras | llama3.1-70b | free tier | 2+ keys |
| Mistral | mistral-small | free tier | 2 keys |
| SambaNova | llama-3.3-70b | free tier | 2 keys |
| GitHub Models | gpt-4o + others | free/GH | 1-2 keys |
| OpenRouter | :free models | 20 req/min | last resort |

**Get keys:**
- Gemini → `aistudio.google.com/apikey` (one per Google account)
- Groq → `console.groq.com/keys`
- Cerebras → `cloud.cerebras.ai`
- SambaNova → `cloud.sambanova.ai`
- Mistral → `console.mistral.ai`
- GitHub → `github.com/marketplace/models`
- OpenRouter → `openrouter.ai/keys`

---

## Phase 2A — Goose (Research Agent)

**Role:** web search → synthesize → write notes → find gaps

```bash
pip install goose-ai
npm install -g @modelcontextprotocol/server-brave-search
npm install -g mcp-obsidian
# Brave key: api.search.brave.com (2000 req/month free)
```

```yaml
# ~/.config/goose/config.yaml
provider: openai-compatible
OPENAI_API_KEY: YOUR_AUTH_KEY
OPENAI_BASE_URL: https://ai-gateway-brain.YOUR.workers.dev/v1
model: gemini-2.5-pro

extensions:
  brave-search:
    command: npx @modelcontextprotocol/server-brave-search
    env:
      BRAVE_API_KEY: YOUR_BRAVE_KEY
  obsidian:
    command: npx mcp-obsidian /home/mohamed/vault
```

**Power prompts:**
```
# Research + build notes
"Search [topic]. Find gaps in my vault under [[maps/X]].
Build atomic notes and link them."

# Gap detection
"Read all /maps/ files. Find referenced topics with no
dedicated note. Add to /gaps/INDEX.md with context."
```

---

## Phase 2B — OpenCode (Engineering Agent)

**Role:** scripts, code, vault automation, note linking

```bash
npm install -g opencode-ai
```

```json
// ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "https://ai-gateway-brain.YOUR.workers.dev/v1" },
      "models": {
        "gemini-2.5-pro": { "name": "Gemini 2.5 Pro" },
        "gemini-2.0-flash": { "name": "Gemini 2.0 Flash" }
      }
    }
  },
  "model": "gateway/gemini-2.5-pro",
  "mcp": {
    "obsidian": {
      "command": "npx",
      "args": ["mcp-obsidian", "/home/mohamed/vault"]
    }
  }
}
```

```json
// ~/.config/opencode/auth.json
{ "gateway": { "api_key": "YOUR_AUTH_KEY" } }
```

**Power prompts:**
```
# Auto-link notes
"Find mentions of topics that have a note file.
Replace with [[wikilinks]] using AGENT.md conventions."

# Build quiz from notes
"Read notes tagged #topic/devops. Build a CLI quiz script."

# Orphan finder
"Write a Python script to find notes with no outgoing [[links]]."
```

---

## Phase 3 — Vault Intelligence

### MCP Servers

| Server | Purpose | Used by |
|---|---|---|
| `mcp-obsidian` | read/write/search vault | Both |
| `server-brave-search` | web search | Goose |
| `server-filesystem` | raw file access | OpenCode |

```bash
npm install -g mcp-obsidian
npm install -g @modelcontextprotocol/server-brave-search
npm install -g @modelcontextprotocol/server-filesystem
```

### AGENT.md — drop in vault root

```markdown
# Agent Context — read this first

## Vault Structure
/inbox/    → raw captures
/notes/    → atomic notes (one idea each)
/maps/     → Maps of Content per topic
/projects/ → active workspaces
/gaps/     → knowledge gap tracker

## Conventions
- Internal links: always [[wikilink]] format
- External links: [text](url) only
- Required frontmatter on every note:
  ---
  title:
  tags: [#topic/X, #status/draft]
  created: YYYY-MM-DD
  related: []
  ---
- One idea per note
- Every note links to at least 2 existing notes
- After creating a note → add to relevant MOC

## Knowledge Gaps
→ See [[gaps/INDEX]]
When gap found: append with context and source notes.

## Do Not
- Create duplicate notes (search first)
- Delete notes (mark #status/deprecated instead)

## Current Focus
- Cloudflare Workers + Durable Objects
- AI gateway infrastructure
- n8n automation
- DevOps career
```

---

## Execution Timeline

**Week 1**
- [ ] Scaffold Worker project
- [ ] Write smart Worker + DO key store
- [ ] Create AI Gateway in dashboard
- [ ] Deploy Worker
- [ ] Seed all 6 Gemini keys + others
- [ ] Test with curl, verify /admin/status
- [ ] Collect remaining provider keys (Groq, Cerebras, Mistral)

**Week 2**
- [ ] Install + configure OpenCode → point to gateway
- [ ] Install + configure Goose → add MCP extensions
- [ ] Test Brave Search from Goose
- [ ] Test vault read/write from both agents

**Week 3**
- [ ] Create AGENT.md in vault root
- [ ] Create /gaps/INDEX.md
- [ ] Create /maps/ MOCs for main topics
- [ ] First Goose research session
- [ ] First knowledge gap scan
- [ ] OpenCode: build note-linking script

**Ongoing**
- [ ] Add new free-tier keys as providers release them
- [ ] Monitor /admin/status for key health
- [ ] Update AGENT.md as vault conventions evolve

---

## Related
- [[maps/Cloudflare]]
- [[maps/AI Tools]]
- [[projects/ai-gateway]]
