# worker-api-proxy

OpenAI-compatible Cloudflare Worker that routes requests to model pools instead of exposing provider keys directly.

It is designed for simple clients such as n8n, custom scripts, or any OpenAI-compatible SDK that can send requests to a custom base URL.

## What It Does

- Exposes `POST /v1/chat/completions`
- Authenticates requests with a single `MASTER_KEY`
- Maps friendly pool names to real upstream models
- Rotates Gemini requests across 6 API keys per pool
- Applies temporary cooldown when an upstream key returns `429`
- Proxies Gemini through Cloudflare AI Gateway
- Proxies DeepSeek V3 through GitHub Models
- Passes through successful upstream responses, including streaming responses

## Current Model Pools

| Pool name | Upstream provider | Upstream model |
| --- | --- | --- |
| `pool-pro` | Google AI Studio | `gemini-3.1-pro-preview` |
| `pool-flash` | Google AI Studio | `gemini-3-flash-preview` |
| `pool-flash-lite` | Google AI Studio | `gemini-3.1-flash-lite-preview` |
| `deepseekv3` | GitHub Models | `deepseek/DeepSeek-V3-0324` |

## Project Files

- [src/index.js](src/index.js): Worker implementation
- [wrangler.jsonc](wrangler.jsonc): Wrangler config
- [test/index.spec.js](test/index.spec.js): basic worker tests
- [.dev.vars.example](.dev.vars.example): local secret template

## Prerequisites

- Node.js and npm
- Cloudflare account
- Wrangler login already configured with `npx wrangler login`
- A Cloudflare AI Gateway created in your account
- Google AI Studio API keys
- A GitHub Models token if you want `deepseekv3`

## Local Setup

1. Install dependencies:

```bash
npm install
```

2. Copy the example secrets file:

```bash
copy .dev.vars.example .dev.vars
```

3. Fill in `.dev.vars` with your real values:

- `MASTER_KEY`: secret used by your clients to call this Worker
- `CF_ACCOUNT_ID`: your Cloudflare account ID
- `GATEWAY_NAME`: the AI Gateway name used by this Worker
- `CF_API_TOKEN`: Cloudflare AI Gateway authorization token sent as the `cf-aig-authorization` header when the Worker calls AI Gateway
- `GITHUB_TOKEN`: GitHub Models token for `deepseekv3`
- `GEMINI_KEY_1` to `GEMINI_KEY_6`: Google AI Studio API keys

4. Start local dev:

```bash
npm run dev
```

5. Run tests:

```bash
npm test -- --run
```

## Cloudflare Setup

This Worker expects the following runtime config in Cloudflare:

### Plaintext variables

- `CF_ACCOUNT_ID`
- `GATEWAY_NAME`

These are safe to keep in [wrangler.jsonc](wrangler.jsonc). They are identifiers, not credentials.

- `CF_ACCOUNT_ID` identifies your Cloudflare account, but it does not grant access by itself.
- `GATEWAY_NAME` is just the AI Gateway name used in the request path.

### Secrets

- `MASTER_KEY`
- `CF_API_TOKEN`
- `GITHUB_TOKEN`
- `GEMINI_KEY_1`
- `GEMINI_KEY_2`
- `GEMINI_KEY_3`
- `GEMINI_KEY_4`
- `GEMINI_KEY_5`
- `GEMINI_KEY_6`

You can add secrets in Cloudflare Dashboard under Worker settings, or with Wrangler secret commands.

## Upload Secrets From `.dev.vars`

The repo includes a small PowerShell helper at [scripts/upload-secrets.ps1](scripts/upload-secrets.ps1).

What it does:

- reads `.dev.vars`
- skips plaintext config keys that should stay in [wrangler.jsonc](wrangler.jsonc)
- uploads only real secrets to the Worker
- warns if `MASTER_KEY` or `CF_API_TOKEN` is missing or blank
- automatically uploads any additional secret names you add later, such as image model keys, extra provider keys, or more model-specific secrets
- can optionally delete remote Worker secrets that are no longer present in `.dev.vars`
- supports a dry-run mode so you can preview uploads and deletions without changing Cloudflare

Important:

- `CF_ACCOUNT_ID` and `GATEWAY_NAME` do not need secret upload because they are already deployed from [wrangler.jsonc](wrangler.jsonc)
- local Gemini testing needs `CF_API_TOKEN` in `.dev.vars`
- if you add more secret entries to `.dev.vars`, the script will upload them too unless the key name is explicitly excluded

### Run the helper from PowerShell

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\upload-secrets.ps1
```

### Upload from a custom file

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\upload-secrets.ps1 -SecretsFile .dev.vars
```

### Add new secret names later

If you later add entries like these to `.dev.vars`:

```text
PHOTO_MODEL_KEY=...
GEMINI_IMAGE_KEY_1=...
ANOTHER_PROVIDER_TOKEN=...
```

the helper will upload them automatically on the next run. You do not need to edit the script for each new secret name.

### Stage secrets as a version first

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\upload-secrets.ps1 -UseVersions
```

### Delete old remote secrets not present in `.dev.vars`

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\upload-secrets.ps1 -DeleteMissing
```

This mode:

- uploads the current secret values from `.dev.vars`
- fetches the current secret names from the deployed Worker
- deletes remote secret names that are no longer in `.dev.vars`

Use it only if you want `.dev.vars` to be the source of truth for Worker secrets.

`-DeleteMissing` cannot be combined with `-UseVersions`.

When stale remote secrets are found, the script will ask for confirmation. You must type `YES` to delete them.

### Preview changes without uploading or deleting

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\upload-secrets.ps1 -DryRun
```

Preview upload plus stale-secret cleanup:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\upload-secrets.ps1 -DeleteMissing -DryRun
```

In dry-run mode the script:

- shows which secret names would be uploaded
- checks for stale remote secrets if `-DeleteMissing` is set
- does not upload anything
- does not delete anything

### Direct Wrangler commands

Upload one secret:

```bash
npx wrangler secret put MASTER_KEY
```

Upload many secrets directly from a file:

```bash
npx wrangler secret bulk .dev.vars
```

That direct bulk command works, but it will also upload `CF_ACCOUNT_ID` and `GATEWAY_NAME` as secrets even though they are better kept as plaintext vars. The helper script avoids that.

## Deploy

Deploy the current code with:

```bash
npm run deploy
```

Wrangler will bundle [src/index.js](src/index.js) and deploy the Worker configured in [wrangler.jsonc](wrangler.jsonc).

## API Usage

The Worker expects requests at:

```text
POST https://<your-worker-domain>/v1/chat/completions
```

Required request header:

```text
Authorization: Bearer <MASTER_KEY>
```

### Example request body

```json
{
  "model": "pool-flash",
  "messages": [
    { "role": "user", "content": "Say hello in one sentence" }
  ]
}
```

### PowerShell example

```powershell
Invoke-RestMethod -Method POST `
  -Uri "https://<your-worker-domain>/v1/chat/completions" `
  -Headers @{"Content-Type"="application/json"; "Authorization"="Bearer <MASTER_KEY>"} `
  -Body '{"model":"pool-flash","messages":[{"role":"user","content":"Say hello in one sentence"}]}'
```

### JavaScript example

```js
const response = await fetch("https://<your-worker-domain>/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer <MASTER_KEY>",
  },
  body: JSON.stringify({
    model: "pool-flash",
    messages: [{ role: "user", content: "Say hello in one sentence" }],
  }),
});

const data = await response.json();
console.log(data);
```

## n8n Setup

This Worker is a good fit for n8n because it looks like an OpenAI-compatible chat endpoint.

### Option 1: OpenAI Chat Model node

1. Create or open your n8n workflow.
2. Add an OpenAI-compatible chat node.
3. Create a credential using your Worker `MASTER_KEY` as the API key.
4. Set the base URL to:

```text
https://<your-worker-domain>/v1
```

5. Set the model field to one of these pool names:

- `pool-pro`
- `pool-flash`
- `pool-flash-lite`
- `deepseekv3`

6. Send messages as normal chat input.

### Option 2: HTTP Request node

1. Add an HTTP Request node.
2. Set method to `POST`.
3. Set URL to:

```text
https://<your-worker-domain>/v1/chat/completions
```

4. Add headers:

- `Content-Type: application/json`
- `Authorization: Bearer <MASTER_KEY>`

5. Set body to JSON:

```json
{
  "model": "pool-flash",
  "messages": [
    { "role": "user", "content": "Write a short summary" }
  ]
}
```

6. If your node supports streaming and you want streamed responses, include:

```json
{
  "stream": true
}
```

## How Rate Limiting Works

- Each Gemini pool has its own round-robin counter
- Each request uses the next available key in that pool
- If an upstream key returns `429`, that key is put on cooldown for 60 seconds
- If all keys in a pool are rate-limited, the Worker returns a `429`
- Rate limiting for one model pool does not block the other model pools

## Public Repo Safety

Safe to keep public:

- [src/index.js](src/index.js)
- [wrangler.jsonc](wrangler.jsonc)
- [.dev.vars.example](.dev.vars.example)

Also safe to keep public in config:

- `CF_ACCOUNT_ID`
- `GATEWAY_NAME`

Never commit:

- `.dev.vars`
- `.env`
- any real token, API key, or secret value

Before making the repo public, follow [PUBLIC_RELEASE_CHECKLIST.md](PUBLIC_RELEASE_CHECKLIST.md).