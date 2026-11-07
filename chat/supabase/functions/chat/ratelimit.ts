// Ограничение на трафика — ЗАМЕСТИТЕЛ (Ф.2).
//
// За сега винаги разрешава: целта е e2e потокът да работи, без да блокира
// разработката. Реалната реализация идва във Ф.4 — собствена таблица в
// Supabase, брояч по IP + прозорец във времето, `Retry-After` при отказ.
//
// Договорът, който index.ts вече очаква (и Ф.4 трябва да запази):
//   checkRateLimit(req, deps) → { allowed, remaining?, retryAfterSeconds? }
// Никога не хвърля — при вътрешна грешка връща allowed: true (fail-open),
// за да не събори чата заради проблем в самия лимитер.

export interface RateLimitResult {
  allowed: boolean;
  remaining?: number;
  retryAfterSeconds?: number;
}

export interface RateLimitDeps {
  fetch: typeof fetch;
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export async function checkRateLimit(
  _req: Request,
  _deps: RateLimitDeps,
): Promise<RateLimitResult> {
  // TODO(Ф.4): брояч по IP в таблица `chat_rate_limit`, прозорец от секунди,
  // праг от env (CHAT_RATE_LIMIT_PER_MIN), 429 + Retry-After при превишаване.
  return { allowed: true };
}
