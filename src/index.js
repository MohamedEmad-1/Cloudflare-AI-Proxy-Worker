/**
 * Welcome to Cloudflare Workers! AI Router
 */

// Logical model pools exposed to clients. The incoming request uses one of
// these aliases in `body.model`, and the worker swaps it to the real upstream model.
const POOLS = {
  'pool-pro': {
    provider: 'gemini',
    model: 'gemini-3.1-pro-preview',
    keys: ['GEMINI_KEY_1', 'GEMINI_KEY_2', 'GEMINI_KEY_3', 'GEMINI_KEY_4', 'GEMINI_KEY_5', 'GEMINI_KEY_6']
  },
  'pool-flash': {
    provider: 'gemini',
    model: 'gemini-3-flash-preview',
    keys: ['GEMINI_KEY_1', 'GEMINI_KEY_2', 'GEMINI_KEY_3', 'GEMINI_KEY_4', 'GEMINI_KEY_5', 'GEMINI_KEY_6']
  },
  'pool-flash-lite': {
    provider: 'gemini',
    model: 'gemini-3.1-flash-lite-preview',
    keys: ['GEMINI_KEY_1', 'GEMINI_KEY_2', 'GEMINI_KEY_3', 'GEMINI_KEY_4', 'GEMINI_KEY_5', 'GEMINI_KEY_6']
  },
  'deepseekv3': {
    provider: 'github-models',
    model: 'deepseek/DeepSeek-V3-0324',
    keys: ['GITHUB_TOKEN']
  }
};

// Round-robin cursor per pool so requests spread across available keys.
const counters = {};
// In-memory cooldown map for keys that recently returned HTTP 429.
const rateLimits = new Map(); // key -> expiration timestamp
const COOLDOWN_MS = 60 * 1000; // 1 minute cooldown for 429s

function getNextKey(poolName, pool, env) {
  // Get all defined keys
  const keys = pool.keys.map(k => env[k]).filter(Boolean);
  if (keys.length === 0) {
    throw new Error(`No configured secrets found for pool: "${poolName}"`);
  }

  const now = Date.now();
  // Clean up old rate limits
  for (const [key, expiry] of rateLimits.entries()) {
    if (expiry < now) rateLimits.delete(key);
  }

  // Find keys not currently rate limited
  const availableKeys = keys.filter(k => !rateLimits.has(k));
  
  if (availableKeys.length === 0) {
    const err = new Error(`Rate limit hit for model pool "${poolName}". All ${keys.length} keys are currently exhausted.`);
    err.status = 429;
    throw err;
  }

  if (!counters[poolName]) counters[poolName] = 0;
  const apiKey = availableKeys[counters[poolName] % availableKeys.length];
  counters[poolName]++;
  return apiKey;
}

// Helper for JSON responses with CORS enabled.
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// Minimal schema check for OpenAI-style chat completion requests.
function isValidChatBody(body) {
  if (!body || typeof body !== 'object') return false;
  if (!body.model || typeof body.model !== 'string') return false;
  if (!Array.isArray(body.messages) || body.messages.length === 0) return false;
  return body.messages.every(
    (m) => m && typeof m.role === 'string' && typeof m.content === 'string'
  );
}

async function callWithRetry(origBody, poolName, pool, env) {
  // Override the dummy pool name with the actual upstream model name
  const body = { ...origBody, model: pool.model };
  const bodyStr = JSON.stringify(body);
  
  // Try up to the total number of keys configured. If a key is rate limited,
  // we immediately add it to the cooldown map and try the next available one.
  const totalKeys = pool.keys.filter(k => Boolean(env[k])).length;
  if (totalKeys === 0) throw new Error(`No keys for pool ${poolName}`);

  for (let attempt = 0; attempt < totalKeys; attempt++) {
    // This will throw 429 if no keys are currently available
    const apiKey = getNextKey(poolName, pool, env);

    // Build provider-specific endpoint and headers.
    let url;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    };

    if (pool.provider === 'gemini') {
      // Use the native OpenAI compatibility endpoint for Gemini
      url = `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.GATEWAY_NAME}/google-ai-studio/v1beta/openai/chat/completions`;
      
      // AI Gateway requires authorization so it knows the worker is allowed to proxy
      if (env.CF_API_TOKEN) {
        headers['cf-aig-authorization'] = `Bearer ${env.CF_API_TOKEN}`;
      }

    } else if (pool.provider === 'github-models') {
      url = `https://models.github.ai/inference/chat/completions`;
    }

    // Forward the request to the selected upstream endpoint.
    const response = await fetch(url, { method: 'POST', headers, body: bodyStr });

    if (response.status === 429) {
      console.warn(`Key rate limited for pool ${poolName}, applying ${COOLDOWN_MS}ms cooldown.`);
      rateLimits.set(apiKey, Date.now() + COOLDOWN_MS);
      continue; // Immediately loop and try next key
    }

    if (!response.ok) {
      // Retry on 5xx errors, but throw on 4xx (like bad request)
      if (response.status >= 500) continue;
      
      const errText = await response.text().catch(() => '');
      const err = new Error(`Upstream error: ${errText}`);
      err.status = response.status;
      throw err;
    }

    // Pass through successful response!
    // Returning `response.body` natively streams if it's a stream, and just sends JSON if it isn't.
    const responseHeaders = new Headers();
    responseHeaders.set('Content-Type', response.headers.get('Content-Type') || 'application/json');
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    
    // Preserve SSE-friendly headers when stream mode is requested.
    if (body.stream) {
      responseHeaders.set('Cache-Control', 'no-cache');
      responseHeaders.set('Connection', 'keep-alive');
    }

    return new Response(response.body, {
      status: 200,
      headers: responseHeaders
    });
  }

  const err = new Error(`All keys failing for pool "${poolName}".`);
  err.status = 429;
  throw err;
}

export default {
  async fetch(request, env) {
    // CORS preflight handler.
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
      });
    }

    // Only handle POST to /v1/chat/completions (OpenAI-compatible)
    const url = new URL(request.url);
    if (url.pathname !== '/v1/chat/completions') {
      return new Response('Not found', { status: 404 });
    }

    // Simple shared-secret auth for clients of this proxy.
    const auth = request.headers.get('Authorization') || '';
    if (auth !== `Bearer ${env.MASTER_KEY}`) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400);
    }

    if (!isValidChatBody(body)) {
      return jsonResponse(
        {
          error: 'Invalid request body. Required fields: model (string), messages (non-empty array of { role, content })'
        },
        400
      );
    }

    const poolName = body.model;
    const pool = POOLS[poolName];

    if (!pool) {
      return jsonResponse({
        error: `Unknown model pool: "${poolName}". Available: ${Object.keys(POOLS).join(', ')}`
      }, 400);
    }

    try {
      // Execute upstream call with key rotation and retry/cooldown behavior.
      const result = await callWithRetry(body, poolName, pool, env);
      return result; // callWithRetry already returns a fully formed Response
    } catch (err) {
      return jsonResponse({ error: err.message || 'Request failed' }, err.status || 500);
    }
  }
};