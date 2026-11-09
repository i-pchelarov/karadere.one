// Проверка на Cloudflare Turnstile — сървърната половина (Ф.4).
//
// Поток: widget-ът на /chat (публичен site key) дава краткотраен токен →
// фронтендът го праща с чат заявката → тук го проверяваме срещу
// /turnstile/v0/siteverify със secret key. Токенът е еднократен, ~300s TTL.
//
// Защо: публичен endpoint без автентикация е цел за скриптове, които палят
// скъпи embeddings + LLM. Turnstile реже автоматизирания шум ПРЕДИ да сме
// похарчили токен, а не само след като rate limit-ът вече е ударен.
//
// Поведение при липсващ secret: проверката се прескача (ok: true). Така
// локалната разработка и тестовете вървят без Turnstile сметка, а продукцията
// включва защитата само като се зададе TURNSTILE_SECRET_KEY.

export interface TurnstileDeps {
  fetch: typeof fetch;
  secretKey: string;
  // Очакваното действие (data-action на widget-а). Пази от токен, издаден за
  // друга повърхност на същия site key. Празно/липсващо = без проверка.
  expectedAction?: string;
  // Разрешени hostname-и, върнати от siteverify. Пази от токен, издаден за
  // чужд домейн. Празен/липсващ списък = без проверка.
  expectedHostnames?: string[];
  // Инжектируем за тестове; продукцията ползва истинския endpoint.
  verifyUrl?: string;
}

export interface TurnstileResult {
  ok: boolean;
  // Защо е отказано — за лога, не за клиента.
  reason?: string;
}

const DEFAULT_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface SiteverifyResponse {
  success: boolean;
  action?: string;
  hostname?: string;
  "error-codes"?: string[];
}

// Проверява токена. Никога не хвърля: при мрежова грешка към Cloudflare
// връща ok: false (fail-closed), защото тук отказът е безопасната посока —
// за разлика от rate limit-а, където fail-open пази чата да работи.
export async function verifyTurnstile(
  token: string | undefined,
  ip: string,
  deps: TurnstileDeps,
): Promise<TurnstileResult> {
  // Не е конфигуриран → защитата е изключена (локално/тестове).
  if (deps.secretKey === "") return { ok: true };

  if (typeof token !== "string" || token.trim() === "") {
    return { ok: false, reason: "липсва turnstile токен" };
  }

  const form = new FormData();
  form.append("secret", deps.secretKey);
  form.append("response", token);
  if (ip !== "" && ip !== "unknown") form.append("remoteip", ip);

  try {
    const resp = await deps.fetch(deps.verifyUrl ?? DEFAULT_VERIFY_URL, {
      method: "POST",
      body: form,
    });
    if (!resp.ok) {
      return { ok: false, reason: `siteverify HTTP ${resp.status}` };
    }
    const outcome = await resp.json() as SiteverifyResponse;
    if (!outcome.success) {
      return {
        ok: false,
        reason: `siteverify отказа: ${(outcome["error-codes"] ?? []).join(",")}`,
      };
    }

    // Действието трябва да съвпада с data-action на widget-а. Токен, издаден
    // за друга повърхност, не бива да отваря чата.
    const expectedAction = deps.expectedAction ?? "";
    if (expectedAction !== "" && outcome.action !== expectedAction) {
      return {
        ok: false,
        reason: `siteverify action ${outcome.action ?? "липсва"} ≠ ${expectedAction}`,
      };
    }

    // Hostname-ът трябва да е в allowlist-а. Пази от токен, издаден за чужд
    // домейн, който ползва същия site key.
    const expectedHostnames = deps.expectedHostnames ?? [];
    if (
      expectedHostnames.length > 0 &&
      !expectedHostnames.includes(outcome.hostname ?? "")
    ) {
      return {
        ok: false,
        reason: `siteverify hostname ${outcome.hostname ?? "липсва"} не е разрешен`,
      };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `siteverify падна: ${String(err)}` };
  }
}
