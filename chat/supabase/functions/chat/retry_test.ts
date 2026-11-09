// Тестове за retry слоя — без мрежа и без реално чакане.
//
// `sleep` се инжектира и само записва паузите; `random` е фиксиран, за да е
// детерминистичен жулитът. Така проверяваме политиката, не таймера.

import { assert, assertEquals } from "./test_assert.ts";
import {
  backoffDelayMs,
  DEFAULT_RETRY,
  fetchWithRetry,
  isRetryableStatus,
  type RetryPolicy,
} from "./retry.ts";

const POLICY: RetryPolicy = { attempts: 3, baseDelayMs: 100, maxDelayMs: 1000 };

function resp(status: number, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : "body", { status, headers });
}

Deno.test("isRetryableStatus: 429 и 5xx се повтарят, 4xx не", () => {
  assertEquals(isRetryableStatus(429), true);
  assertEquals(isRetryableStatus(500), true);
  assertEquals(isRetryableStatus(503), true);
  assertEquals(isRetryableStatus(400), false);
  assertEquals(isRetryableStatus(401), false);
  assertEquals(isRetryableStatus(404), false);
  assertEquals(isRetryableStatus(200), false);
});

Deno.test("backoffDelayMs расте експоненциално", () => {
  // random=0 → без жули, чиста експонента.
  const zero = () => 0;
  assertEquals(backoffDelayMs(1, POLICY, undefined, zero), 100);
  assertEquals(backoffDelayMs(2, POLICY, undefined, zero), 200);
  assertEquals(backoffDelayMs(3, POLICY, undefined, zero), 400);
});

Deno.test("backoffDelayMs уважава Retry-After", () => {
  assertEquals(backoffDelayMs(1, POLICY, 2, () => 0), 2000 > POLICY.maxDelayMs ? POLICY.maxDelayMs : 2000);
  assertEquals(backoffDelayMs(1, POLICY, 0, () => 0), 0);
});

Deno.test("backoffDelayMs не надхвърля maxDelayMs", () => {
  const big = backoffDelayMs(10, POLICY, undefined, () => 1);
  assert(big <= POLICY.maxDelayMs, `очаквано <= ${POLICY.maxDelayMs}, получено ${big}`);
});

Deno.test("fetchWithRetry: успех от първия опит не чака", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const fetchImpl = (() => {
    calls++;
    return Promise.resolve(resp(200));
  }) as typeof fetch;

  const r = await fetchWithRetry(fetchImpl, "https://x.test", {}, POLICY, {
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  assertEquals(r.status, 200);
  assertEquals(calls, 1);
  assertEquals(sleeps, []);
});

Deno.test("fetchWithRetry: 429 после 200 → един повторен опит", async () => {
  const sleeps: number[] = [];
  const statuses = [429, 200];
  let calls = 0;
  const fetchImpl = (() => Promise.resolve(resp(statuses[calls++]))) as typeof fetch;

  const r = await fetchWithRetry(fetchImpl, "https://x.test", {}, POLICY, {
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0,
  });
  assertEquals(r.status, 200);
  assertEquals(calls, 2);
  assertEquals(sleeps, [100]);
});

Deno.test("fetchWithRetry: изчерпани опити връща последния отговор", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const fetchImpl = (() => {
    calls++;
    return Promise.resolve(resp(503));
  }) as typeof fetch;

  const r = await fetchWithRetry(fetchImpl, "https://x.test", {}, POLICY, {
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0,
  });
  assertEquals(r.status, 503);
  assertEquals(calls, 3, "трябва да опита точно attempts пъти");
  assertEquals(sleeps.length, 2, "пауза само между опитите");
});

Deno.test("fetchWithRetry: 400 не се повтаря", async () => {
  let calls = 0;
  const fetchImpl = (() => {
    calls++;
    return Promise.resolve(resp(400));
  }) as typeof fetch;

  const r = await fetchWithRetry(fetchImpl, "https://x.test", {}, POLICY, {
    sleep: () => Promise.resolve(),
  });
  assertEquals(r.status, 400);
  assertEquals(calls, 1);
});

Deno.test("fetchWithRetry: мрежова грешка се повтаря и накрая хвърля", async () => {
  let calls = 0;
  const fetchImpl = (() => {
    calls++;
    return Promise.reject(new Error("мрежата падна"));
  }) as typeof fetch;

  let threw = false;
  try {
    await fetchWithRetry(fetchImpl, "https://x.test", {}, POLICY, {
      sleep: () => Promise.resolve(),
    });
  } catch {
    threw = true;
  }
  assert(threw, "трябва да хвърли след изчерпани опити");
  assertEquals(calls, 3);
});

Deno.test("fetchWithRetry: onRetry се вика с нарастваща пауза", async () => {
  const seen: Array<{ attempt: number; status: number; delayMs: number }> = [];
  let calls = 0;
  const fetchImpl = (() => {
    calls++;
    return Promise.resolve(resp(429));
  }) as typeof fetch;

  await fetchWithRetry(fetchImpl, "https://x.test", {}, POLICY, {
    sleep: () => Promise.resolve(),
    random: () => 0,
    onRetry: (info) => seen.push(info),
  });
  assertEquals(seen.length, 2);
  assertEquals(seen[0].status, 429);
  assertEquals(seen[0].delayMs, 100);
  assertEquals(seen[1].delayMs, 200);
});

Deno.test("DEFAULT_RETRY има разумни стойности", () => {
  assertEquals(DEFAULT_RETRY.attempts, 3);
  assert(DEFAULT_RETRY.baseDelayMs > 0);
  assert(DEFAULT_RETRY.maxDelayMs >= DEFAULT_RETRY.baseDelayMs);
});
