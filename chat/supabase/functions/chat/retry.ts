// Повторен опит с експоненциален backoff при 429/5xx.
//
// OpenRouter връща 429, когато всички модели във веригата са изчерпани
// (rate limit). Единичен опит губи заявката; кратко изчакване я спасява.
//
// Повтаряме само докато НЕ сме започнали да четем тялото: веднъж започнал
// поток не може да се поднови, без да дублираме вече пратените делти. Затова
// retry-ът обгражда само първоначалния fetch, не четенето на потока.

export interface RetryPolicy {
  attempts: number; // общо опити, включително първия
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 4000,
};

export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Дали отговорът заслужава повторен опит: 429 (rate limit) и 5xx (срив).
// 4xx (освен 429) са трайни — повторението само хаби време.
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

// Пауза преди повторен опит `attempt` (1-базиран: 1 = първият повторен опит).
// Уважава Retry-After (секунди), иначе експоненциално base * 2^(attempt-1).
// Добавя до 20% жули, за да не се удрят едновременно много клиенти, и
// ограничава всичко до maxDelayMs.
export function backoffDelayMs(
  attempt: number,
  policy: RetryPolicy,
  retryAfterSeconds?: number,
  random: () => number = Math.random,
): number {
  if (retryAfterSeconds !== undefined && retryAfterSeconds >= 0) {
    return Math.min(retryAfterSeconds * 1000, policy.maxDelayMs);
  }
  const exp = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exp, policy.maxDelayMs);
  const jitter = capped * 0.2 * random();
  return Math.round(Math.min(capped + jitter, policy.maxDelayMs));
}

function retryAfterOf(resp: Response): number | undefined {
  const raw = resp.headers.get("Retry-After");
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export interface RetryDeps {
  sleep?: Sleep;
  random?: () => number;
  onRetry?: (info: { attempt: number; status: number; delayMs: number }) => void;
}

// Изпълнява fetch и повтаря при 429/5xx. Връща последния отговор (дори
// неуспешен), ако опитите се изчерпят — викащият решава как да го превърне в
// грешка. Хвърля само ако всички опити са паднали с мрежова грешка.
export async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  policy: RetryPolicy,
  deps: RetryDeps = {},
): Promise<Response> {
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  let lastResp: Response | null = null;
  let lastErr: unknown = null;

  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    if (attempt > 1) {
      const delay = backoffDelayMs(
        attempt - 1,
        policy,
        lastResp ? retryAfterOf(lastResp) : undefined,
        random,
      );
      deps.onRetry?.({ attempt, status: lastResp?.status ?? 0, delayMs: delay });
      // Освобождаваме неизчетеното тяло, преди да пуснем нов опит.
      if (lastResp?.body) {
        try {
          await lastResp.body.cancel();
        } catch {
          // вече затворено/заключено — няма значение
        }
      }
      await sleep(delay);
    }

    try {
      const resp = await fetchImpl(url, init);
      if (!isRetryableStatus(resp.status)) return resp;
      lastResp = resp;
      lastErr = null;
    } catch (err) {
      lastErr = err;
      lastResp = null;
    }
  }

  if (lastResp) return lastResp;
  throw lastErr;
}
