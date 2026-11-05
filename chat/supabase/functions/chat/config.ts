// Конфигурация на чат функцията — само от environment.
// Стойностите идват от `supabase secrets set` (деплой) или от
// `--env-file ./supabase/functions/.env` (локално). Никога не се хардкодват.
//
// ВАЖНО: този модул НЕ чете env при import. Всичко минава през loadConfig(),
// за да могат тестовете да подадат собствен env (или никакъв) и да не
// гърмят при import. Ключовете са параметри, не глобални константи.

export type EnvReader = (name: string) => string | undefined;

const defaultEnv: EnvReader = (name) => Deno.env.get(name);

function str(env: EnvReader, name: string, fallback?: string): string {
  const v = env(name);
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required env: ${name}`);
  }
  return v;
}

function num(env: EnvReader, name: string, fallback: number): number {
  const v = env(name);
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// --- retrieval настройки -----------------------------------------------------
export interface RagTuning {
  vectorThreshold: number;
  weakTop: number;
  confidentTop: number;
  minHits: number;
  fetchFactor: number;
  fetchLimit: number;
  maxTerms: number;
  minTermLen: number;
}

export const DEFAULT_TUNING: RagTuning = {
  vectorThreshold: 0.2,
  weakTop: 0.38,
  confidentTop: 0.62,
  minHits: 2,
  fetchFactor: 4,
  fetchLimit: 200,
  maxTerms: 8,
  minTermLen: 3,
};

// --- зависимости на retrieval слоя -------------------------------------------
// Всичко, което rag.ts ползва, идва оттук. Тестовете подават фалшив fetch и
// фалшиви URL-и; продукцията подава истинските.
export interface RagDeps {
  fetch: typeof fetch;
  supabaseUrl: string;
  supabaseAnonKey: string;
  openRouterApiKey: string;
  openRouterBase: string;
  embedModel: string;
  embedDimensions: number;
  tuning: RagTuning;
}

export interface AppConfig {
  supabase: { url: string; anonKey: string };
  openRouter: { apiKey: string; base: string };
  models: { chat: string; embed: string; embedDimensions: number };
  rag: RagTuning;
  limits: {
    maxMessages: number;
    maxMessageChars: number;
    maxTokens: number;
    topK: number;
  };
  cors: { allowedOrigin: string };
  turnstile: { secretKey: string };
}

export function loadConfig(env: EnvReader = defaultEnv): AppConfig {
  return {
    supabase: {
      url: str(env, "SUPABASE_URL"),
      anonKey: str(env, "SUPABASE_ANON_KEY"),
    },
    openRouter: {
      apiKey: str(env, "OPENROUTER_API_KEY"),
      base: "https://openrouter.ai/api/v1",
    },
    models: {
      chat: str(env, "CHAT_LLM_MODEL", "google/gemma-4-26b-a4b-it:free"),
      embed: str(env, "CHAT_EMBED_MODEL", "openai/text-embedding-3-small"),
      embedDimensions: num(env, "CHAT_EMBED_DIMENSIONS", 768),
    },
    rag: {
      vectorThreshold: num(env, "RAG_VECTOR_THRESHOLD", DEFAULT_TUNING.vectorThreshold),
      weakTop: num(env, "RAG_HYBRID_WEAK_TOP", DEFAULT_TUNING.weakTop),
      confidentTop: num(env, "RAG_HYBRID_CONFIDENT_TOP", DEFAULT_TUNING.confidentTop),
      minHits: num(env, "RAG_HYBRID_MIN_HITS", DEFAULT_TUNING.minHits),
      fetchFactor: num(env, "RAG_HYBRID_FETCH_FACTOR", DEFAULT_TUNING.fetchFactor),
      fetchLimit: num(env, "RAG_HYBRID_FETCH_LIMIT", DEFAULT_TUNING.fetchLimit),
      maxTerms: num(env, "RAG_HYBRID_MAX_TERMS", DEFAULT_TUNING.maxTerms),
      minTermLen: num(env, "RAG_HYBRID_MIN_TERM_LEN", DEFAULT_TUNING.minTermLen),
    },
    limits: {
      maxMessages: num(env, "CHAT_MAX_MESSAGES", 20),
      maxMessageChars: num(env, "CHAT_MAX_MESSAGE_CHARS", 4000),
      maxTokens: num(env, "CHAT_MAX_TOKENS", 1200),
      topK: num(env, "CHAT_TOP_K", 6),
    },
    cors: {
      allowedOrigin: str(env, "CHAT_ALLOWED_ORIGIN", "https://karadere.one"),
    },
    turnstile: {
      secretKey: env("TURNSTILE_SECRET_KEY") ?? "",
    },
  };
}

// Сглобява зависимостите за rag.ts от заредена конфигурация.
export function ragDeps(
  cfg: AppConfig,
  fetchImpl: typeof fetch = fetch,
): RagDeps {
  return {
    fetch: fetchImpl,
    supabaseUrl: cfg.supabase.url,
    supabaseAnonKey: cfg.supabase.anonKey,
    openRouterApiKey: cfg.openRouter.apiKey,
    openRouterBase: cfg.openRouter.base,
    embedModel: cfg.models.embed,
    embedDimensions: cfg.models.embedDimensions,
    tuning: cfg.rag,
  };
}
