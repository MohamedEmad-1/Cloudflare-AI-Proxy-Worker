/**
 * AI Router — Cloudflare Worker
 * OpenAI-compatible proxy with smart key rotation and per-pool thinking config.
 *
 * Pool reference:
 * pool-2.5-tools   → gemini-2.5-flash  | thinking OFF (reasoning_effort:none) | BEST for tools/file ops
 * pool-flash       → gemini-3.5-flash  | thinking_level: minimal             | light tool use
 * pool-flash-low   → gemini-3.5-flash  | thinking_level: low
 * pool-flash-med   → gemini-3.5-flash  | thinking_level: medium
 * pool-flash-high  → gemini-3.5-flash  | thinking_level: high                 | deep reasoning, no tools
 * pool-lite        → gemini-3.1-flash-lite | default (thinking off by default) | fastest/cheapest
 */

// ─── Pool definitions ─────────────────────────────────────────────────────────
const POOLS = {
  'pool-2.5-tools': {
    model: 'gemini-2.5-flash',
    keys: ['GEMINI_KEY_1', 'GEMINI_KEY_2', 'GEMINI_KEY_3', 'GEMINI_KEY_4', 'GEMINI_KEY_5', 'GEMINI_KEY_6'],
    thinking: { type: '2.5', reasoning_effort: 'none' }
  },
  'pool-flash': {
    model: 'gemini-3.5-flash',
    keys: ['GEMINI_KEY_1', 'GEMINI_KEY_2', 'GEMINI_KEY_3', 'GEMINI_KEY_4', 'GEMINI_KEY_5', 'GEMINI_KEY_6'],
    thinking: { type: '3.x', thinking_level: 'minimal' }
  },
  'pool-flash-low': {
    model: 'gemini-3.5-flash',
    keys: ['GEMINI_KEY_1', 'GEMINI_KEY_2', 'GEMINI_KEY_3', 'GEMINI_KEY_4', 'GEMINI_KEY_5', 'GEMINI_KEY_6'],
    thinking: { type: '3.x', thinking_level: 'low' }
  },
  'pool-flash-med': {
    model: 'gemini-3.5-flash',
    keys: ['GEMINI_KEY_1', 'GEMINI_KEY_2', 'GEMINI_KEY_3', 'GEMINI_KEY_4', 'GEMINI_KEY_5', 'GEMINI_KEY_6'],
    thinking: { type: '3.x', thinking_level: 'medium' }
  },
  'pool-flash-high': {
    model: 'gemini-3.5-flash',
    keys: ['GEMINI_KEY_1', 'GEMINI_KEY_2', 'GEMINI_KEY_3', 'GEMINI_KEY_4', 'GEMINI_KEY_5', 'GEMINI_KEY_6'],
    thinking: { type: '3.x', thinking_level: 'high' },
    disableTools: true 
  },
  'pool-lite': {
    model: 'gemini-3.1-flash-lite',
    keys: ['GEMINI_KEY_1', 'GEMINI_KEY_2', 'GEMINI_KEY_3', 'GEMINI_KEY_4', 'GEMINI_KEY_5', 'GEMINI_KEY_6'],
    thinking: null
  }
};

// ─── Counters & Rate limit tracking ──────────────────────────────────────────
const counters   = {};
const rateLimits = new Map(); 
const COOLDOWN_MS = 60 * 1000; 

// ─── Ephemeral Memory Fallback (For Local Dev without KV) ─────────────────────
const memCache = new Map();

// Generate a deterministic SHA-256 fingerprint of the message history context
async function getCacheKey(messages) {
  const str = messages
    .map(m => `${m.role}:${m.content ? (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) : ''}`)
    .join('\n');
  const msgUint8 = new TextEncoder().encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function saveSignature(key, signature, env) {
  if (env.SIGNATURE_KV) {
    // Save to distributed KV namespace with a 10-minute time-to-live
    await env.SIGNATURE_KV.put(key, signature, { expirationTtl: 600 });
  } else {
    if (memCache.size >= 1000) memCache.delete(memCache.keys().next().value);
    memCache.set(key, signature);
  }
}

async function getSignature(key, env) {
  if (env.SIGNATURE_KV) {
    return await env.SIGNATURE_KV.get(key);
  }
  return memCache.get(key);
}

// ─── Key selection ────────────────────────────────────────────────────────────
function getNextKey(poolName, pool, env) {
  const keys = pool.keys.map(k => env[k]).filter(Boolean);
  if (keys.length === 0) throw new Error(`No secrets configured for pool: "${poolName}"`);

  const now = Date.now();
  for (const [k, exp] of rateLimits.entries()) {
    if (exp < now) rateLimits.delete(k);
  }

  const available = keys.filter(k => !rateLimits.has(k));

  if (available.length === 0) {
    const earliest = Math.min(...keys.map(k => rateLimits.get(k)).filter(Boolean));
    const err = new Error(
      `All ${keys.length} keys exhausted for pool "${poolName}".` +
      (isFinite(earliest) ? ` Retry in ${Math.ceil((earliest - now) / 1000)}s.` : '')
    );
    err.status = 429;
    if (isFinite(earliest)) {
      err.retryAfter   = Math.max(0, earliest - now);
      err.earliestExpiry = earliest;
    }
    throw err;
  }

  if (!counters[poolName]) counters[poolName] = 0;
  const key = available[counters[poolName] % available.length];
  counters[poolName]++;
  return key;
}

// ─── Apply thinking config per pool ──────────────────────────────────────────
function applyThinkingConfig(body, pool) {
  const cfg = pool.thinking;
  if (!cfg) return body;

  delete body.thinking_config;
  delete body.reasoning_effort;

  body.extra_body = body.extra_body || {};
  body.extra_body.google = body.extra_body.google || {};
  delete body.extra_body.google.thinking_config;

  if (cfg.type === '2.5') {
    body.reasoning_effort = cfg.reasoning_effort; 
  } else if (cfg.type === '3.x') {
    body.extra_body.google.thinking_config = {
      thinking_level: cfg.thinking_level
    };
  }

  return body;
}

// ─── Upstream call with key rotation + signature state injection ──────────────
async function callWithRetry(origBody, poolName, pool, env) {
  const totalKeys = pool.keys.filter(k => Boolean(env[k])).length;
  if (totalKeys === 0) throw new Error(`No keys for pool "${poolName}"`);

  // Deep clone input context to keep the injection cycle non-destructive
  let messages = JSON.parse(JSON.stringify(origBody.messages || []));

  // Auto-inject missing thought signatures back into replayed context turns
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const contextKey = await getCacheKey(messages.slice(0, i));
      const cachedSig = await getSignature(contextKey, env);
      if (cachedSig) {
        const firstToolCall = msg.tool_calls[0];
        firstToolCall.extra_content = firstToolCall.extra_content || {};
        firstToolCall.extra_content.google = firstToolCall.extra_content.google || {};
        firstToolCall.extra_content.google.thought_signature = cachedSig;
      }
    }
  }

  let body = { ...origBody, messages, model: pool.model };
  body = applyThinkingConfig(body, pool);
  const bodyStr = JSON.stringify(body);

  const currentRequestKey = await getCacheKey(origBody.messages || []);

  for (let attempt = 0; attempt < totalKeys; attempt++) {
    const apiKey = getNextKey(poolName, pool, env);
    const url = `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.GATEWAY_NAME}/google-ai-studio/v1beta/openai/chat/completions`;

    const headers = {
      'Content-Type':    'application/json',
      'Authorization':   `Bearer ${apiKey}`
    };
    if (env.CF_API_TOKEN) {
      headers['cf-aig-authorization'] = `Bearer ${env.CF_API_TOKEN}`;
    }

    const response = await fetch(url, { method: 'POST', headers, body: bodyStr });

    if (response.status === 429) {
      console.warn(`[${poolName}] Key rate-limited — cooldown ${COOLDOWN_MS}ms`);
      rateLimits.set(apiKey, Date.now() + COOLDOWN_MS);
      continue;
    }

    if (!response.ok) {
      if (response.status >= 500) continue; 
      const errText = await response.text().catch(() => '');
      const err = new Error(`Upstream error: ${errText}`);
      err.status = response.status;
      throw err;
    }

    const respHeaders = new Headers({
      'Content-Type':               response.headers.get('Content-Type') || 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    if (body.stream) {
      respHeaders.set('Cache-Control', 'no-cache');
      respHeaders.set('Connection',    'keep-alive');
    }

    // Capture response signatures
    if (!body.stream) {
      const cloneResp = response.clone();
      try {
        const json = await cloneResp.json();
        const toolCalls = json.choices?.[0]?.message?.tool_calls;
        if (Array.isArray(toolCalls)) {
          for (const tc of toolCalls) {
            const sig = tc.extra_content?.google?.thought_signature;
            if (sig) {
              await saveSignature(currentRequestKey, sig, env);
              break; 
            }
          }
        }
      } catch (e) {
        console.error('JSON signature extract failed:', e);
      }
      return response;
    } else {
      // Structured SSE streaming line parser
      const { readable, writable } = new TransformStream();
      const reader = response.body.getReader();
      const writer = writable.getWriter();
      const decoder = new TextDecoder();
      let lineBuffer = '';

      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              writer.close();
              break;
            }
            await writer.write(value);

            lineBuffer += decoder.decode(value, { stream: true });
            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed.startsWith('data: ')) {
                const jsonStr = trimmed.slice(6);
                if (jsonStr === '[DONE]') continue;
                try {
                  const parsed = JSON.parse(jsonStr);
                  const sig = parsed.choices?.[0]?.delta?.tool_calls?.[0]?.extra_content?.google?.thought_signature;
                  if (sig) {
                    await saveSignature(currentRequestKey, sig, env);
                  }
                } catch {
                  // Keep going on incomplete stream pieces
                }
              }
            }
          }
        } catch (err) {
          writer.abort(err);
        }
      })();

      return new Response(readable, { status: 200, headers: respHeaders });
    }
  }

  const now = Date.now();
  const expiries = pool.keys.map(k => env[k]).filter(Boolean).map(k => rateLimits.get(k)).filter(Boolean);
  const err = new Error(`All keys failing for pool "${poolName}".`);
  err.status = 429;
  if (expiries.length) {
    err.retryAfter    = Math.max(0, Math.min(...expiries) - now);
    err.earliestExpiry = Math.min(...expiries);
  }
  throw err;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type':               'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

function isValidChatBody(body) {
  if (!body || typeof body !== 'object')   return false;
  if (!body.model || typeof body.model !== 'string') return false;
  if (!Array.isArray(body.messages) || body.messages.length === 0) return false;
  return body.messages.every(m =>
    m &&
    typeof m.role === 'string' &&
    (typeof m.content === 'string' || Array.isArray(m.content) || m.content === null)
  );
}

// ─── Main fetch handler ───────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin':  '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
      });
    }

    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return jsonResponse({
        status: 'ok',
        pools: Object.keys(POOLS),
        rateLimited: [...rateLimits.keys()].length
      });
    }

    if (url.pathname !== '/v1/chat/completions') {
      return new Response('Not found', { status: 404 });
    }

    const auth        = request.headers.get('Authorization') || '';
    const expectedAuth = `Bearer ${env.MASTER_KEY}`;

    if (env.DEBUG_AUTH) {
      console.log(`AUTH_DEBUG matches=${auth === expectedAuth} headerLen=${auth.length}`);
    }

    if (auth !== expectedAuth) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400);
    }

    if (!isValidChatBody(body)) {
      return jsonResponse({
        error: 'Invalid body. Required: model (string), messages (array of {role, content})'
      }, 400);
    }

    const poolName = body.model;
    const pool     = POOLS[poolName];

    if (!pool) {
      return jsonResponse({
        error: `Unknown pool: "${poolName}". Available: ${Object.keys(POOLS).join(', ')}`
      }, 400);
    }

    if (pool.disableTools && body.tools) {
      return jsonResponse({
        error: `Tool use is not allowed for "${poolName}" (high thinking mode). Use pool-2.5-tools for tool calls.`
      }, 400);
    }

    try {
      return await callWithRetry(body, poolName, pool, env);
    } catch (err) {
      if (err?.status === 429) {
        const resp = { error: err.message };
        if (err.retryAfter    != null) resp.retry_after_ms = err.retryAfter;
        if (err.earliestExpiry)       resp.renew_at       = new Date(err.earliestExpiry).toISOString();
        return jsonResponse(resp, 429);
      }
      return jsonResponse({ error: err.message || 'Request failed' }, err?.status || 500);
    }
  }
};