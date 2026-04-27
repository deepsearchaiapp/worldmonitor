import { CHROME_UA } from './constants';

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
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[llm:claude] ANTHROPIC_API_KEY missing — skipping');
    return null;
  }

  const {
    system,
    prompt,
    model = 'claude-haiku-4-5',
    maxTokens = 2000,
    temperature = 0.2,
    timeoutMs = 25_000,
  } = opts;

  try {
    const resp = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
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

export interface LlmCallOptions {
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  provider?: string;
  stripThinkingTags?: boolean;
  validate?: (content: string) => boolean;
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

    try {
      const resp = await fetch(creds.apiUrl, {
        method: 'POST',
        headers: { ...creds.headers, 'User-Agent': CHROME_UA },
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
