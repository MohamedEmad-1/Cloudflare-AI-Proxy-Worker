/**
 * AI Router — Cloudflare Worker
 * OpenAI-compatible proxy with smart key rotation and per-pool thinking config.
 *
 * Pool reference:
 *  pool-2.5-tools   → gemini-2.5-flash  | thinking OFF (reasoning_effort:none) | BEST for tools/file ops
 *  pool-flash       → gemini-3.5-flash  | thinking_level: minimal              | light tool use
 *  pool-flash-low   → gemini-3.5-flash  | thinking_level: low
 *  pool-flash-med   → gemini-3.5-flash  | thinking_level: medium
 *  pool-flash-high  → gemini-3.5-flash  | thinking_level: high                 | deep reasoning, no tools
 *  pool-lite        → gemini-3.1-flash-lite | default (thinking off by default) | fastest/cheapest
 */

// ─── Pool definitions ─────────────────────────────────────────────────────────
// `thinking` encodes what the Worker injects into each request before forwarding.
// null = don't touch thinking config (model default).
const POOLS = {

  // ── Gemini 2.5 Flash — thinking completely OFF ────────────────────────────
  // Use for: any task that involves tool calls / file reads / folder access.
  // reasoning_effort:"none" is the OpenAI-compat way to set thinking_budget:0 on 2.5 models.
  // No thought signatures generated → tools work reliably across multi-turn conversations.
  'pool-2.5-tools': {
    model: 'gemini-2.5-flash',
    keys: ['GEMINI_KEY_1', 'GEMINI_KEY_2', 'GEMINI_KEY_3',
           'GEMINI_KEY_4', 'GEMINI_KEY_5', 'GEMINI_KEY_6'],
    thinking: { type: '2.5', reasoning_effort: 'none' }
  },

  // ── Gemini 3.5 Flash — minimal thinking ──────────────────────────────────
  // Use for: general coding tasks, light tool use.
  // Note: even at minimal level, thought signatures exist. Works for single-turn
  // tool calls but may fail in deep multi-turn tool loops. Use pool-2.5-tools instead.
  'pool-flash': {
    model: 'gemini-3.5-flash',
    keys: ['GEMINI_KEY_1', 'GEMINI_KEY_2', 'GEMINI_KEY_3',
           'GEMINI_KEY_4', 'GEMINI_KEY_5', 'GEMINI_KEY_6'],
    thinking: { type: '3.x', thinking_level: 'minimal' }
  },

  // ── Gemini 3.5 Flash — low thinking ──────────────────────────────────────
  // Use for: balanced reasoning + speed. Good general purpose.
  'pool-flash-low': {
    model: 'gemini-3.5-flash',
    keys: ['GEMINI_KEY_1', 'GEMINI_KEY_2', 'GEMINI_KEY_3',
           'GEMINI_KEY_4', 'GEMINI_KEY_5', 'GEMINI_KEY_6'],
    thinking: { type: '3.x', thinking_level: 'low' }
  },

  // ── Gemini 3.5 Flash — medium thinking ───────────────────────────────────
  // Use for: architecture planning, complex code review, analysis.
  'pool-flash-med': {
    model: 'gemini-3.5-flash',
    keys: ['GEMINI_KEY_1', 'GEMINI_KEY_2', 'GEMINI_KEY_3',
           'GEMINI_KEY_4', 'GEMINI_KEY_5', 'GEMINI_KEY_6'],
    thinking: { type: '3.x', thinking_level: 'medium' }
  },

  // ── Gemini 3.5 Flash — high thinking ─────────────────────────────────────
  // Use for: deep research, hard problems, math. DO NOT use with tools.
  // High thinking produces large thought signatures — multi-turn tool calls will fail.
  'pool-flash-high': {
    model: 'gemini-3.5-flash',
    keys: ['GEMINI_KEY_1', 'GEMINI_KEY_2', 'GEMINI_KEY_3',
           'GEMINI_KEY_4', 'GEMINI_KEY_5', 'GEMINI_KEY_6'],
    thinking: { type: '3.x', thinking_level: 'high' },
    disableTools: true // Worker will reject tool-use requests to this pool
  },

  // ── Gemini 3.1 Flash Lite — default ──────────────────────────────────────
  // Use for: fast cheap tasks, summaries, classifications.
  // thinking is OFF by default on Flash-Lite — tools work fine.
  'pool-lite': {
    model: 'gemini-3.1-flash-lite',
    keys: ['GEMINI_KEY_1', 'GEMINI_KEY_2', 'GEMINI_KEY_3',
           'GEMINI_KEY_4', 'GEMINI_KEY_5', 'GEMINI_KEY_6'],
    thinking: null
  }
};

// ─── Round-robin counters + rate limit map ────────────────────────────────────
const counters   = {};
const rateLimits = new Map(); // apiKey → expiry timestamp
const COOLDOWN_MS = 60 * 1000; // 1-minute cooldown on 429

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
// Injects the correct thinking parameters based on model generation.
// IMPORTANT: never mix thinking_budget (2.5) with thinking_level (3.x).
function applyThinkingConfig(body, pool) {
  const cfg = pool.thinking;
  if (!cfg) return body; // pool-lite: leave defaults untouched

  // Strip any client-supplied thinking params to avoid conflicts
  delete body.thinking_config;
  delete body.reasoning_effort;

  // Ensure extra_body.google exists
  body.extra_body = body.extra_body || {};
  body.extra_body.google = body.extra_body.google || {};
  delete body.extra_body.google.thinking_config; // remove stale client value

  if (cfg.type === '2.5') {
    // Gemini 2.5 models: use reasoning_effort at top level (OpenAI compat)
    // "none" maps to thinking_budget:0 — fully disables thinking, no thought signatures
    body.reasoning_effort = cfg.reasoning_effort; // "none"
  } else if (cfg.type === '3.x') {
    // Gemini 3.x models: use extra_body.google.thinking_config.thinking_level
    // Valid values: "minimal" | "low" | "medium" | "high"
    // Cannot be disabled — "minimal" is the floor
    body.extra_body.google.thinking_config = {
      thinking_level: cfg.thinking_level
    };
  }

  return body;
}

// ─── Upstream call with key rotation ─────────────────────────────────────────
async function callWithRetry(origBody, poolName, pool, env) {
  const totalKeys = pool.keys.filter(k => Boolean(env[k])).length;
  if (totalKeys === 0) throw new Error(`No keys for pool "${poolName}"`);

  // Apply model name + thinking config before forwarding
  let body = { ...origBody, model: pool.model };
  body = applyThinkingConfig(body, pool);
  const bodyStr = JSON.stringify(body);

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
      if (response.status >= 500) continue; // retry on server errors
      const errText = await response.text().catch(() => '');
      const err = new Error(`Upstream error: ${errText}`);
      err.status = response.status;
      throw err;
    }

    // Stream-safe passthrough
    const respHeaders = new Headers({
      'Content-Type':               response.headers.get('Content-Type') || 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    if (body.stream) {
      respHeaders.set('Cache-Control', 'no-cache');
      respHeaders.set('Connection',    'keep-alive');
    }

    return new Response(response.body, { status: 200, headers: respHeaders });
  }

  // All keys failed
  const now = Date.now();
  const expiries = pool.keys.map(k => env[k]).filter(Boolean)
    .map(k => rateLimits.get(k)).filter(Boolean);
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

// Relaxed validation: content can be string OR array (tool results, multimodal)
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

    // CORS preflight
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

    // Health check
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

    // Auth
    const auth        = request.headers.get('Authorization') || '';
    const expectedAuth = `Bearer ${env.MASTER_KEY}`;

    if (env.DEBUG_AUTH) {
      console.log(`AUTH_DEBUG matches=${auth === expectedAuth} headerLen=${auth.length}`);
    }

    if (auth !== expectedAuth) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    // Parse body
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

    // Block tool calls on high-thinking pool
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
        if (err.earliestExpiry)        resp.renew_at       = new Date(err.earliestExpiry).toISOString();
        return jsonResponse(resp, 429);
      }
      return jsonResponse({ error: err.message || 'Request failed' }, err?.status || 500);
    }
  }
};