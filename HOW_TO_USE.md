# How to Use worker-api-proxy

This guide shows how to make requests to the Worker from different platforms.

## Prerequisites

You need:
- The Worker's deployed URL (e.g., `https://your-worker.example.com`)
- Your `MASTER_KEY` (configured in the Worker's Cloudflare secrets)

## Quick Reference

**Endpoint:** `POST https://<your-worker-url>/v1/chat/completions`

**Required header:** `Authorization: Bearer <MASTER_KEY>`

**Available models (pools):**
- `pool-2.5-tools` — Gemini 2.5 Flash (thinking OFF, best for tools/file ops)
- `pool-flash` — Gemini 3.5 Flash (minimal thinking)
- `pool-flash-low` — Gemini 3.5 Flash (low thinking)
- `pool-flash-med` — Gemini 3.5 Flash (medium thinking)
- `pool-flash-high` — Gemini 3.5 Flash (high thinking, no tools)
- `pool-lite` — Gemini 3.1 Flash Lite (fastest, least capable)

## OpenAI-Compatible Gateway Usage

This Worker is the OpenAI-compatible endpoint your code should call. Do not call the Cloudflare AI Gateway URL directly from client or OpenAI SDK code.

- `base_url`: `https://<your-worker-url>/v1`
- `api_key`: your `MASTER_KEY`
- `Authorization` header: `Bearer <MASTER_KEY>`
-- `model`: one of the pool names (`pool-2.5-tools`, `pool-flash`, `pool-flash-low`, `pool-flash-med`, `pool-flash-high`, `pool-lite`)

Example: in OpenAI SDKs, set the base URL to the Worker and use your `MASTER_KEY`.

---

## OpenAI Python SDK

For agentic work, use the OpenAI Python SDK pointed at the Worker.

### Installation

```bash
pip install openai
```

### Basic Usage

```python
from openai import OpenAI

client = OpenAI(
    api_key="<YOUR_MASTER_KEY>",
    base_url="https://<your-worker-url>/v1",
)

response = client.chat.completions.create(
    model="pool-flash",
    messages=[
        {"role": "user", "content": "What is 2 + 2?"}
    ]
)

print(response.choices[0].message.content)
```

### With Streaming

```python
stream = client.chat.completions.create(
    model="pool-flash",
    messages=[
        {"role": "user", "content": "Tell me a story"}
    ],
    stream=True
)

for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
```

### For Agentic Work (with tools)

```python
client = OpenAI(
    api_key="<YOUR_MASTER_KEY>",
    base_url="https://<your-worker-url>/v1",
)

tools = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get the weather for a location",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {
                        "type": "string",
                        "description": "The city name"
                    }
                },
                "required": ["location"]
            }
        }
    }
]

response = client.chat.completions.create(
    model="pool-flash",
    messages=[
        {"role": "user", "content": "What's the weather in New York?"}
    ],
    tools=tools,
    tool_choice="auto"
)

print(response.choices[0].message)
```

---

## OpenAI JavaScript/TypeScript SDK

For Node.js agentic work.

### Installation

```bash
npm install openai
```

### Basic Usage

```javascript
const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: "<YOUR_MASTER_KEY>",
  baseURL: "https://<your-worker-url>/v1",
});

async function chat() {
  const response = await client.chat.completions.create({
    model: "pool-flash",
    messages: [
      { role: "user", content: "What is 2 + 2?" }
    ]
  });

  console.log(response.choices[0].message.content);
}

chat();
```

### With Streaming

```javascript
async function chatStream() {
  const stream = await client.chat.completions.create({
    model: "pool-flash",
    messages: [
      { role: "user", content: "Tell me a story" }
    ],
    stream: true
  });

  for await (const chunk of stream) {
    if (chunk.choices[0].delta.content) {
      process.stdout.write(chunk.choices[0].delta.content);
    }
  }
}

chatStream();
```

---

## Raw HTTP Request (curl / Postman)

If you prefer raw HTTP or need to test quickly.

### Command Line (curl)

```bash
curl https://<your-worker-url>/v1/chat/completions \
  -H "Authorization: Bearer <YOUR_MASTER_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "pool-flash",
    "messages": [
      {"role": "user", "content": "Say hello"}
    ]
  }'
```

### With Streaming

```bash
curl https://<your-worker-url>/v1/chat/completions \
  -H "Authorization: Bearer <YOUR_MASTER_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "pool-flash",
    "messages": [
      {"role": "user", "content": "Tell me a story"}
    ],
    "stream": true
  }' \
  -N
```

---

## n8n Integration

The Worker is OpenAI-compatible, so it works seamlessly with n8n.

### Option 1: Using OpenAI Chat Model Node

1. **Create a credential:**
   - Go to **Credentials** → **New** → **OpenAI**
   - Set **API Key** to your `MASTER_KEY`
   - Set **Base URL** to `https://<your-worker-url>/v1`

2. **In your workflow:**
   - Add an **OpenAI Chat Model** node
   - Select your credential
   - Set **Model** to one of:
     - `pool-2.5-tools`
     - `pool-flash`
     - `pool-flash-low`
     - `pool-flash-med`
     - `pool-flash-high`
     - `pool-lite`
   - Wire up your chat input

3. **Example workflow:**
   ```
   Trigger
      ↓
   Chat Input (user message)
      ↓
   OpenAI Chat Model (model: pool-flash, credential: your credential)
      ↓
   Chat Output (response)
   ```

### Option 2: Using HTTP Request Node

1. **Add an HTTP Request node**
   - Method: `POST`
   - URL: `https://<your-worker-url>/v1/chat/completions`

2. **Headers tab:**
   - Add `Content-Type: application/json`
   - Add `Authorization: Bearer <YOUR_MASTER_KEY>`

3. **Body tab (JSON mode):**
   ```json
   {
     "model": "pool-flash",
     "messages": [
       {
         "role": "user",
         "content": "{{ $json.userMessage }}"
       }
     ]
   }
   ```

4. **To extract the response:**
   - The response body will look like:
     ```json
     {
       "choices": [
         {
           "message": {
             "content": "..."
           }
         }
       ]
     }
     ```
   - Use `{{ $json.choices[0].message.content }}` to extract the text

### Option 3: Agentic Workflow with Tools

Use the OpenAI Chat Model node with the **Tools** setting:

1. **In the OpenAI Chat Model node:**
   - Enable **Tools**
   - Define your tool schema (e.g., `get_weather`)
   - Set **Tool Choice** to `auto`

2. **Add a conditional:** Check if the response includes a tool call
   - If yes, execute the tool logic, then loop back to the model
   - If no, return the final response

---

## Response Format

All responses follow OpenAI's chat completion format:

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "Your response here"
      }
    }
  ],
  "model": "gemini-3-flash-preview",
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 20,
    "total_tokens": 30
  }
}
```

## Streaming Response Format

When `"stream": true`, responses come as newline-delimited JSON:

```
data: {"choices":[{"delta":{"content":"Hello"}}]}
data: {"choices":[{"delta":{"content":" world"}}]}
data: [DONE]
```

The SDKs (OpenAI, n8n) handle this automatically.

---

## Error Handling

### 401 Unauthorized

```json
{ "error": "Unauthorized" }
```

**Fix:** Check your `MASTER_KEY` — it doesn't match what's in the Worker's secrets.

### 400 Bad Request

```json
{
  "error": "Invalid request body. Required fields: model (string), messages (non-empty array of { role, content })"
}
```

**Fix:** Ensure your request body has:
- `"model"`: string (one of the pool names)
- `"messages"`: array with at least one message
- Each message has `"role"` and `"content"` fields

### 429 Rate Limited

```json
{
  "error": "Rate limit hit for model pool \"pool-flash\". All 6 keys are currently exhausted."
}
```

**Cause:** All Gemini API keys in the pool hit their rate limit.

**Fix:** Wait 60 seconds (the Worker's cooldown) and retry. This is a soft limit — the Worker will try the next available key automatically for subsequent requests.

### 5xx Server Error

The Worker encountered an error. Check:
- Your `CF_API_TOKEN` is set in the Worker's Cloudflare secrets
- Your Gemini API keys are valid
- Cloudflare AI Gateway is configured correctly

---

## Performance Tips

1. **Use `pool-lite` for simple tasks** — faster and cheaper
2. **Use `pool-flash-high` for complex reasoning** — slower but more capable
3. **Enable streaming** for long responses — users see output sooner
4. **Implement exponential backoff** for retries on 429 errors
5. **Monitor token usage** — the response includes `usage.total_tokens`

---

## Example: Complete n8n Agent Workflow

```
[Trigger]
  ↓
[HTTP Request: Get system prompt]
  ↓
[Set Initial Messages]
  messages = [
    { role: "system", content: "<system_prompt>" },
    { role: "user", content: "<user_input>" }
  ]
  ↓
[Loop: Call OpenAI Chat Model]
  model: pool-flash
  messages: {{ $json.messages }}
  tools: [list of available tools]
  ↓
[Check for Tool Use]
  ├─ If tool_use:
  │   ├─ Execute tool function
  │   ├─ Append result to messages
  │   └─ Loop back to OpenAI Chat Model
  │
  └─ If no tool_use:
      └─ Return final response
```

---

## Troubleshooting

| Problem | Solution |
| --- | --- |
| "Unauthorized" error | Verify `MASTER_KEY` matches Worker's secret |
| "Unknown model pool" error | Use one of: `pool-2.5-tools`, `pool-flash`, `pool-flash-low`, `pool-flash-med`, `pool-flash-high`, `pool-lite` |
| Empty response `{}` | This was a known bug (fixed). Update Worker code if old. |
| Slow responses | Try `pool-lite` instead of `pool-flash-high` |
| Streaming not working | Ensure `"stream": true` in request body |
| n8n can't connect | Check Worker URL is publicly accessible and includes `https://` |

---

## Questions?

- Check [README.md](README.md) for architecture details
- Review [src/index.js](src/index.js) for rate-limit logic
- See [wrangler.jsonc](wrangler.jsonc) for deployed config
