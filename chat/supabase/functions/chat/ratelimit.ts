// Ограничение на честотата — брояч по IP в Postgres (Ф.4).
//
// Защо в базата, а не в паметта: Edge Function-ите са изолати без споделено
// състояние — всеки студен старт е чист лист, а паралелните изолати не се
// виждат. Брояч в паметта би пропуснал точно това, което трябва да хване.
//
// Защо не Upstash/Redis: архитектурното решение (#8) е собствена таблица в
// Supabase — без още един външен доставчик, ключ и сметка за един брояч.
//
// Договорът, който index.ts очаква:
//   checkRateLimit(req, deps) → { allowed, remaining?, retryAfterSeconds? }
// Никога не хвърля — при вътрешна грешка връща allowed: true (fail-open), за
// да не събори чата заради проблем в самия лимитер.

export interface RateLimitConfig {
  windowSeconds: number;
  limit: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining?: number;
  retryAfterSeconds?: number;
}

export interface RateLimitDeps {
  fetch: typeof fetch;
  supabaseUrl: string;
  // Ключът за RPC-то. Функцията `chat_rate_limit_hit` е достъпна само за
  // service_role (виж миграцията) — иначе всеки би могъл през PostgREST да
  // надува или нулира чужди броячи.
  serviceRoleKey: string;
  config: RateLimitConfig;
}

// Извлича IP-то на клиента от заявката.
//
// Редът на доверие е важен: `x-forwarded-for` е списък, който клиентът може да
// подправи, като добави стойности отпред. Затова:
//   1. `cf-connecting-ip` — слага го Cloudflare, клиентът не може да го подправи;
//   2. последният елемент на `x-forwarded-for` — най-близкият доверен прокси
//      го добавя последен, значи е най-достоверният в списъка;
//   3. `x-real-ip` — резерва.
// Ако нищо не е налично, връщаме "unknown" — всички такива заявки делят един
// брояч, което е по-безопасно от това да ги пропуснем без лимит.
export function clientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf && cf.trim() !== "") return cf.trim();

  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter((s) => s !== "");
    if (parts.length > 0) return parts[parts.length - 1];
  }

  const real = req.headers.get("x-real-ip");
  if (real && real.trim() !== "") return real.trim();

  return "unknown";
}

interface RpcRow {
  allowed: boolean;
  remaining: number;
  retry_after_seconds: number;
}

export async function checkRateLimit(
  req: Request,
  deps: RateLimitDeps,
): Promise<RateLimitResult> {
  const { windowSeconds, limit } = deps.config;

  // Изключен лимит (0) или липсващ ключ → не пипаме базата.
  if (limit <= 0 || windowSeconds <= 0) return { allowed: true };
  if (deps.serviceRoleKey === "") return { allowed: true };

  const ip = clientIp(req);
  const base = deps.supabaseUrl.replace(/\/+$/, "");

  try {
    const resp = await deps.fetch(`${base}/rpc/chat_rate_limit_hit`, {
      method: "POST",
      headers: {
        apikey: deps.serviceRoleKey,
        Authorization: `Bearer ${deps.serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_ip: ip,
        p_window_seconds: windowSeconds,
        p_limit: limit,
      }),
    });

    if (!resp.ok) {
      // Лимитерът не е критичен за работата на чата — по-добре да пуснем
      // заявката, отколкото да върнем 500 заради него.
      console.error(`chat: rate limit RPC HTTP ${resp.status}`);
      return { allowed: true };
    }

    const rows = await resp.json() as RpcRow[];
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row || typeof row.allowed !== "boolean") {
      console.error("chat: rate limit RPC върна неочакван отговор");
      return { allowed: true };
    }

    if (row.allowed) {
      return { allowed: true, remaining: row.remaining };
    }
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: row.retry_after_seconds,
    };
  } catch (err) {
    console.error("chat: rate limit RPC падна:", err);
    return { allowed: true };
  }
}
