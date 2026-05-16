import { CHROME_UA } from './constants';

// ─────────────────────────────────────────────────────────────────────────────
// TEMP: Helicone observability — debug-only, remove before merge.
//
// Hardcoded key for a half-day cost-debug session. Routes Anthropic / Gemini /
// Groq / OpenRouter calls through Helicone's legacy proxy subdomains so we
// can see prompts, responses, token counts, and per-caller cost in their UI.
//
// Revert plan when done:
//   1. Delete this whole block + the helicone-specific URL/header logic below.
//   2. Drop the `caller?: string` field from the option types.
//   3. Drop the `caller:` argument at every call site.
//   4. Rotate this key in helicone.ai/developer (it WILL be in git history).
// ─────────────────────────────────────────────────────────────────────────────
const HELICONE_API_KEY = 'sk-helicone-ztvsi6a-azoevlq-rob3yty-5aj2cca';
const HELICONE_ENABLED = HELICONE_API_KEY.length > 0;

/** Returns Helicone-Auth + optional Helicone-Property-Caller headers, or {}
 *  if Helicone is disabled. Spread into the existing `headers:` object. */
function heliconeHeaders(caller?: string): Record<string, string> {
  if (!HELICONE_ENABLED) return {};
  const h: Record<string, string> = {
    'Helicone-Auth': `Bearer ${HELICONE_API_KEY}`,
  };
  if (caller) h['Helicone-Property-Caller'] = caller;
  return h;
}

export interface ProviderCredentials {
  apiUrl: string;
  model: string;
  headers: Record<string, string>;
  extraBody?: Record<string, unknown>;
}

const OLLAMA_HOST_ALLOWLIST = new Set([
  'localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal',
]);

function isSidecar(): boolean {
  return typeof process !== 'undefined' &&
    (process.env?.LOCAL_API_MODE || '').includes('sidecar');
}

export function getProviderCredentials(provider: string): ProviderCredentials | null {
  if (provider === 'ollama') {
    const baseUrl = process.env.OLLAMA_API_URL;
    if (!baseUrl) return null;

    if (!isSidecar()) {
      try {
        const hostname = new URL(baseUrl).hostname;
        if (!OLLAMA_HOST_ALLOWLIST.has(hostname)) {
          console.warn(`[llm] Ollama blocked: hostname "${hostname}" not in allowlist`);
          return null;
        }
      } catch {
        return null;
      }
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const apiKey = process.env.OLLAMA_API_KEY;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    return {
      apiUrl: new URL('/v1/chat/completions', baseUrl).toString(),
      model: process.env.OLLAMA_MODEL || 'llama3.1:8b',
      headers,
      extraBody: { think: false },
    };
  }

  if (provider === 'groq') {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return null;
    return {
      apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'llama-3.1-8b-instant',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    };
  }

  if (provider === 'openrouter') {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return null;
    return {
      apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'openrouter/free',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://worldmonitor.news',
        'X-Title': 'WorldMonitor',
      },
    };
  }

  return null;
}

export function stripThinkingTags(text: string): string {
  let s = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/<reflection>[\s\S]*?<\/reflection>/gi, '')
    .replace(/<\|begin_of_thought\|>[\s\S]*?<\|end_of_thought\|>/gi, '')
    .trim();

  s = s
    .replace(/<think>[\s\S]*/gi, '')
    .replace(/<\|thinking\|>[\s\S]*/gi, '')
    .replace(/<reasoning>[\s\S]*/gi, '')
    .replace(/<reflection>[\s\S]*/gi, '')
    .replace(/<\|begin_of_thought\|>[\s\S]*/gi, '')
    .trim();

  return s;
}

const PROVIDER_CHAIN = ['ollama', 'groq', 'openrouter'] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic Claude — Messages API (different shape from OpenAI-compat)
// Used by the live-news location enrichment pipeline. Reusable wherever a
// structured JSON response from Claude is needed.
// ─────────────────────────────────────────────────────────────────────────────

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export interface ClaudeCallOptions {
  /** Pass an explicit system prompt to keep `messages` purely user content. */
  system?: string;
  /** Single user-turn prompt. Multi-turn use cases should call the helper directly. */
  prompt: string;
  /** Default `claude-haiku-4-5` — cheap, fast, plenty for structured extraction. */
  model?: string;
  /** Cap output tokens. JSON-only outputs rarely need more than 2 000. */
  maxTokens?: number;
  /** Lower for deterministic JSON. Default 0.2. */
  temperature?: number;
  /** Hard timeout for the HTTPS round-trip. */
  timeoutMs?: number;
  /**
   * Override the env var name used to look up the Anthropic API key.
   * Defaults to `ANTHROPIC_API_KEY`. Pass a different name (e.g.
   * `ANTHROPIC_API_KEY_PARAPHRASE`) so that distinct features can bill
   * against separate keys for cost visibility in Anthropic's dashboard.
   * Falls back to `ANTHROPIC_API_KEY` if the specified env var is unset,
   * so a missing config doesn't silently kill the feature.
   */
  apiKeyEnv?: string;
  /**
   * TEMP (Helicone debug): tag identifying which feature/cron is making this
   * call. Surfaced in the Helicone dashboard as the `Caller` property so we
   * can group spend by call site. Examples: `live-news:enrich-combined`,
   * `intel-news:enrich-conflict`. Optional — calls without it just show as
   * "(none)" in the dashboard. Remove with the rest of the Helicone block.
   */
  caller?: string;
}

export interface ClaudeCallResult {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Call Claude with a single user prompt and return the trimmed text content.
 * Returns null on any failure (missing key, HTTP error, malformed response,
 * timeout). Callers decide whether null is fatal — for enrichment pipelines
 * it's typically a soft fail (item just doesn't get a location).
 */
export async function callClaude(opts: ClaudeCallOptions): Promise<ClaudeCallResult | null> {
  // Resolve which env var to read. If the caller asked for a specific one
  // (e.g. ANTHROPIC_API_KEY_PARAPHRASE) and it's set, use that. Otherwise
  // fall back to the default ANTHROPIC_API_KEY so a missing optional key
  // doesn't silently break the feature.
  const preferredEnvName = opts.apiKeyEnv;
  const preferredKey = preferredEnvName ? process.env[preferredEnvName] : undefined;
  const fallbackKey = process.env.ANTHROPIC_API_KEY;
  const apiKey = preferredKey || fallbackKey;

  if (!apiKey) {
    console.warn(`[llm:claude] ${preferredEnvName ?? 'ANTHROPIC_API_KEY'} missing (and ANTHROPIC_API_KEY also unset) — skipping`);
    return null;
  }

  if (preferredEnvName && !preferredKey) {
    console.warn(`[llm:claude] ${preferredEnvName} unset — falling back to ANTHROPIC_API_KEY (cost will land on the default key)`);
  }

  const {
    system,
    prompt,
    model = 'claude-haiku-4-5',
    maxTokens = 2000,
    temperature = 0.2,
    timeoutMs = 25_000,
  } = opts;

  // TEMP (Helicone): swap to the Anthropic proxy subdomain when enabled.
  // Helicone forwards the request unchanged to api.anthropic.com after
  // logging it. Reverts to the direct URL when HELICONE_ENABLED is false.
  const requestUrl = HELICONE_ENABLED
    ? 'https://anthropic.helicone.ai/v1/messages'
    : ANTHROPIC_API_URL;

  try {
    const resp = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
        ...heliconeHeaders(opts.caller),
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.warn(`[llm:claude] HTTP ${resp.status} ${body.slice(0, 200)}`);
      return null;
    }

    const data = (await resp.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      model?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const text = (data.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text!.trim())
      .join('\n')
      .trim();

    if (!text) {
      console.warn('[llm:claude] empty response body');
      return null;
    }

    return {
      content: text,
      model: data.model ?? model,
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    };
  } catch (err) {
    console.warn(`[llm:claude] ${(err as Error).message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Google Gemini — generateContent API (Google AI Studio, key-auth)
//
// Designed as a drop-in cost-replacement for `callClaude`: same option shape,
// same return shape. Roughly 10–25× cheaper than Claude Haiku at comparable
// quality for structured-extraction tasks (location, summarization, dedup).
//
// Pricing reference (as of 2025-Q4) for gemini-2.5-flash-lite:
//   $0.10 / 1M input tokens   (vs Haiku $1.00)
//   $0.40 / 1M output tokens  (vs Haiku $5.00)
//
// Quality reference: noticeably weaker than Claude on creative writing
// or nuanced reasoning, on par or faster than Claude on structured-output
// tasks (JSON extraction, classification, fixed-schema summarization).
//
// Failure handling: returns null on any error (missing key, HTTP fail,
// malformed response, timeout). Mirrors `callClaude` semantics exactly so
// existing call-site try/catch patterns work unchanged.
// ─────────────────────────────────────────────────────────────────────────────

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiCallOptions {
  /** System prompt — mapped to `system_instruction` in the request body. */
  system?: string;
  /** Single user-turn prompt. */
  prompt: string;
  /** Default `gemini-2.5-flash-lite`. Override only if a specific feature
   *  needs a stronger / different model. */
  model?: string;
  /** Cap output tokens. */
  maxTokens?: number;
  /** Lower for deterministic JSON. Default 0.2. */
  temperature?: number;
  /** Hard timeout for the HTTPS round-trip. */
  timeoutMs?: number;
  /**
   * Override the env var name used to look up the Gemini API key.
   * Defaults to `GEMINI_API_KEY`. Pass a different name (e.g.
   * `GEMINI_API_KEY_PARAPHRASE`) for billing-separation parity with
   * the Claude call path. Falls back to `GEMINI_API_KEY` if the
   * specified env var is unset.
   */
  apiKeyEnv?: string;
  /**
   * When true, sets `responseMimeType: "application/json"` so Gemini
   * guarantees a syntactically valid JSON response. Use this for any
   * call site that asks the model to return JSON — eliminates the
   * "wrapped in code fences" failure mode common with free-form prompts.
   */
  jsonMode?: boolean;
  /**
   * Sets `thinkingConfig.thinkingBudget`. Gemini 2.5 models do internal
   * "thinking" that draws down the same `maxOutputTokens` budget as the
   * response — for a large fixed-schema JSON output this can starve the
   * actual answer and truncate it into invalid JSON. Pass `0` to disable
   * thinking on structured-extraction calls. Omit to keep the model default.
   */
  thinkingBudget?: number;
  /** TEMP (Helicone debug): tag identifying which feature/cron is making
   *  this call. See identical field on ClaudeCallOptions for details. */
  caller?: string;
}

export interface GeminiCallResult {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export async function callGemini(opts: GeminiCallOptions): Promise<GeminiCallResult | null> {
  const preferredEnvName = opts.apiKeyEnv;
  const preferredKey = preferredEnvName ? process.env[preferredEnvName] : undefined;
  const fallbackKey = process.env.GEMINI_API_KEY;
  const apiKey = preferredKey || fallbackKey;

  if (!apiKey) {
    console.warn(`[llm:gemini] ${preferredEnvName ?? 'GEMINI_API_KEY'} missing (and GEMINI_API_KEY also unset) — skipping`);
    return null;
  }

  if (preferredEnvName && !preferredKey) {
    console.warn(`[llm:gemini] ${preferredEnvName} unset — falling back to GEMINI_API_KEY (cost will land on the default key)`);
  }

  const {
    system,
    prompt,
    model = 'gemini-2.5-flash-lite',
    maxTokens = 2000,
    temperature = 0.2,
    timeoutMs = 25_000,
    jsonMode = false,
    thinkingBudget,
  } = opts;

  // TEMP (Helicone): Gemini's proxy lives at gateway.helicone.ai/v1beta and
  // requires an extra `Helicone-Target-URL` header so the gateway knows which
  // upstream to forward to. The user's Gemini key still goes in the `?key=`
  // query param exactly as before.
  const apiBase = HELICONE_ENABLED
    ? 'https://gateway.helicone.ai/v1beta'
    : GEMINI_API_BASE;
  const url = `${apiBase}/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;

  const generationConfig: Record<string, unknown> = {
    temperature,
    maxOutputTokens: maxTokens,
  };
  if (jsonMode) {
    generationConfig.responseMimeType = 'application/json';
  }
  if (thinkingBudget !== undefined) {
    generationConfig.thinkingConfig = { thinkingBudget };
  }

  const body: Record<string, unknown> = {
    contents: [
      { role: 'user', parts: [{ text: prompt }] },
    ],
    generationConfig,
  };
  if (system) {
    body.system_instruction = { parts: [{ text: system }] };
  }

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...heliconeHeaders(opts.caller),
        ...(HELICONE_ENABLED
          ? { 'Helicone-Target-URL': 'https://generativelanguage.googleapis.com' }
          : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      console.warn(`[llm:gemini] HTTP ${resp.status} ${errBody.slice(0, 200)}`);
      return null;
    }

    const data = (await resp.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };

    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();

    if (!text) {
      console.warn(`[llm:gemini] empty response body (finish=${data.candidates?.[0]?.finishReason ?? 'unknown'})`);
      return null;
    }

    return {
      content: text,
      model,
      inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    };
  } catch (err) {
    console.warn(`[llm:gemini] ${(err as Error).message}`);
    return null;
  }
}

export interface LlmCallOptions {
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  provider?: string;
  stripThinkingTags?: boolean;
  validate?: (content: string) => boolean;
  /** TEMP (Helicone debug): tag identifying which feature is making this
   *  call. See identical field on ClaudeCallOptions for details. */
  caller?: string;
}

export interface LlmCallResult {
  content: string;
  model: string;
  provider: string;
  tokens: number;
}

export async function callLlm(opts: LlmCallOptions): Promise<LlmCallResult | null> {
  const {
    messages,
    temperature = 0.3,
    maxTokens = 1500,
    timeoutMs = 25_000,
    provider: forcedProvider,
    stripThinkingTags: shouldStrip = true,
    validate,
  } = opts;

  const providers = forcedProvider ? [forcedProvider] : [...PROVIDER_CHAIN];

  for (const providerName of providers) {
    const creds = getProviderCredentials(providerName);
    if (!creds) {
      if (forcedProvider) return null;
      continue;
    }

    // TEMP (Helicone): swap to the per-provider proxy subdomain when enabled.
    // Ollama is local-only so it stays on the original URL even with Helicone
    // on (the gateway can't reach localhost).
    let requestUrl = creds.apiUrl;
    let extraHeaders: Record<string, string> = {};
    if (HELICONE_ENABLED) {
      if (providerName === 'groq') {
        requestUrl = 'https://groq.helicone.ai/openai/v1/chat/completions';
        extraHeaders = heliconeHeaders(opts.caller);
      } else if (providerName === 'openrouter') {
        requestUrl = 'https://openrouter.helicone.ai/api/v1/chat/completions';
        extraHeaders = heliconeHeaders(opts.caller);
      }
      // ollama: skip — local
    }

    try {
      const resp = await fetch(requestUrl, {
        method: 'POST',
        headers: { ...creds.headers, 'User-Agent': CHROME_UA, ...extraHeaders },
        body: JSON.stringify({
          ...creds.extraBody,
          model: creds.model,
          messages,
          temperature,
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!resp.ok) {
        console.warn(`[llm:${providerName}] HTTP ${resp.status}`);
        if (forcedProvider) return null;
        continue;
      }

      const data = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { total_tokens?: number };
      };

      let content = data.choices?.[0]?.message?.content?.trim() || '';
      if (!content) {
        if (forcedProvider) return null;
        continue;
      }

      const tokens = data.usage?.total_tokens ?? 0;

      if (shouldStrip) {
        content = stripThinkingTags(content);
        if (!content) {
          if (forcedProvider) return null;
          continue;
        }
      }

      if (validate && !validate(content)) {
        console.warn(`[llm:${providerName}] validate() rejected response, trying next`);
        if (forcedProvider) return null;
        continue;
      }

      return { content, model: creds.model, provider: providerName, tokens };
    } catch (err) {
      console.warn(`[llm:${providerName}] ${(err as Error).message}`);
      if (forcedProvider) return null;
      continue;
    }
  }

  return null;
}
