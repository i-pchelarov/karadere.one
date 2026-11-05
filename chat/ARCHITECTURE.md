# Чат за сайта karadere.one — Архитектура и план

Документ с взетите решения и плана за разработка на уеб чат, който
обогатява отговорите си със знание от нашия RAG (Supabase pgvector хранилище,
търсене чрез `rag/rag_query.mjs`).

**Статус:** план, одобрен за изпълнение. Кодът живее в тази (`chat/`)
директория — бекенд + фронтенд заедно; по-късно ще бъдат разделени за деплой.

---

## 1. Взети решения

| # | Решение | Стойност |
| - | - | - |
| 1 | Къде живее бекендът | **Supabase Edge Function** (serverless, Deno) |
| 2 | Провайдер за LLM | **OpenRouter** |
| 3 | LLM модел по подразбиране | `google/gemma-4-26b-a4b-it:free` (конфигурируем от бекенда) |
| 4 | Поток на заявка | 1 заявка → валидация → обогатяване с правни цитати + системен промпт → LLM + история → отговор по **SSE** |
| 5 | Къде живее чатът | Отделна **`/chat`** страница |
| 6 | Стрийминг | Да — **SSE** (`text/event-stream`) |
| 7 | Ключ за retrieval | **anon + read RLS** политика (не `service_role`) |
| 8 | Rate limit | Собствена таблица в Postgres — **отложено** за етапа „втвърдяване“ |
| 9 | Anti-abuse | **Cloudflare Turnstile** — **отложено** за етапа „втвърдяване“ |
| 10 | Навигация | Линк „Чат“ в хедъра — **по-късно** |
| 11 | Секрети | `OPENROUTER_API_KEY`, `CHAT_LLM_MODEL` и др. — само в бекенда (Edge Function secrets) |

---

## 2. Архитектура

```
Браузър (/chat)  --POST-->  Edge Function "chat"  --embeddings-->  OpenRouter
      ^                         |       |                            (text-embedding-3-small, 768d)
      |  SSE (text/event-stream)|       +--pgvector RPC / PostgREST ilike--> Supabase DB
      +-------------------------+       +--chat/completions stream:true-------> OpenRouter (LLM)
```

- Целият retrieval и LLM достъп са **само server-side**; клиентът никога не вижда ключове.
- Хибридното търсене (вектор + keyword fallback) се пренася от `rag/rag_query.mjs`
  в `chat/supabase/functions/chat/rag.ts` — същата логика, tuning и escape правила.

---

## 3. Поток на една заявка (SSE)

1. **Валидация** — схема на тялото `{ messages: [{role, content}], sessionId? }`;
   лимити за брой/дължина на съобщения; отхвърляне на прекомерна история.
2. **Rate limit** *(Ф.4)* — по IP (`x-forwarded-for`) + по `sessionId`.
3. **Retrieval** — embed на последния потребителски въпрос (768d) →
   `match_document_sections`; ако резултатът е слаб → keyword fallback през
   PostgREST `ilike` (същата хибридна логика и tuning env като в `.mjs`).
4. **Контекст** — топ пасажите се вкарват в системния промпт с етикети за
   цитиране (член/глава от `metadata`); дисклеймър „не е правен съвет“.
5. **LLM** — `POST /chat/completions` с `stream: true` към OpenRouter.
6. **SSE обратно** — `event: sources` (цитатите първо) → `event: delta` (токените)
   → `event: done`; при грешка `event: error`. Периодични keepalive коментари
   (`: ping`), за да не удари idle timeout-а.

---

## 4. Структура на директорията

```
karadere.one/
└── chat/                              ← тази директория (бекенд + фронтенд)
    ├── ARCHITECTURE.md                ← този документ
    ├── README.md                      ← локално пускане / деплой
    ├── supabase/
    │   ├── config.toml                ← verify_jwt = false за chat
    │   ├── migrations/
    │   │   └── *_anon_read_policy.sql ← read RLS върху document_sections
    │   └── functions/chat/
    │       ├── deno.json              ← import map / npm specifiers
    │       ├── index.ts               ← CORS, валидация, retrieval, LLM, SSE
    │       ├── config.ts              ← env: OPENROUTER_API_KEY, CHAT_LLM_MODEL, лимити
    │       ├── rag.ts                 ← порт на rag_query.mjs (embed + hybrid)
    │       ├── prompt.ts              ← системен промпт + сборка на контекста с цитати
    │       ├── ratelimit.ts           ← (Ф.4) таблица в БД
    │       ├── turnstile.ts           ← (Ф.4) siteverify
    │       └── *_test.ts              ← Deno тестове за retrieval
    └── web/
        ├── pages/chat.html            ← /chat (ползва _layouts/default.html)
        ├── js/chat.js                 ← fetch + ReadableStream SSE клиент
        └── css/chat.css
```

---

## 5. Фази на изпълнение

- **Ф.0 Конфиг и секрети** — `supabase init` в `chat/`, `config.toml`,
  `supabase secrets set OPENROUTER_API_KEY=... CHAT_LLM_MODEL=...`.
- **Ф.1 Порт на retrieval** — `rag.ts` + Deno тестове, париращи `test_rag_query.py`.
- **Ф.2 Edge Function** — валидация → retrieval (anon+RLS) → системен промпт →
  OpenRouter stream → SSE.
- **Ф.3 Фронтенд** — `/chat` страница + SSE клиент (цитати, стрийминг).
- **Ф.4 Втвърдяване** — rate limit (БД), Turnstile, CORS allowlist, token caps,
  error/retry пътища, CI (Deno type-check + тестове).
- **Ф.5 Деплой** — `supabase functions deploy chat` + проверка на живо от `/chat`.

---

## 6. Детайли за Supabase Edge Functions (Deno runtime)

- Runtime: **Deno** (не Node), изолирани **V8 изолати**, по един на заявка.
  Входна точка `Deno.serve(handler)` (web-standard `Request` → `Response`).
  npm пакети през `npm:` specifier-и; предпочитаме web API-та.
- Автоматично инжектирани env: `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`. Собствените секрети не може да
  започват с `SUPABASE_`.
- Деплой: `supabase functions deploy chat` → CLI бъндира в **ESZip** и го
  разпространява по edge възлите (нисък latency, милисекунди cold start).
- Публичен чат → без JWT: `--no-verify-jwt` / `verify_jwt = false` в `config.toml`.
- Локален сървър: `supabase functions serve chat --env-file ./supabase/functions/.env`
  (**изисква работещ Docker**).

### Лимити (важни за SSE потока)

| Лимит | Стойност |
| - | - |
| Памет | 256 MB |
| Wall-clock | 150s (free) / 400s (платено) |
| CPU на заявка | 2s (I/O не се брои) |
| Request idle timeout | 150s → нужни keepalive коментари в SSE |

Струящият SSE е I/O, не CPU, така че дълъг отговор е ок — стига да пускаме
keepalive. `text/html` не се сервира от функцията освен на custom домейн
(при нас е без значение: `/chat` се сервира от GitHub Pages).

---

## 7. Cloudflare Turnstile (отложено — Ф.4)

- Безплатна, privacy-preserving алтернатива на CAPTCHA; **без пъзел**.
- Невидими, неинтерактивни JS предизвикателства (proof-of-work, proof-of-space,
  проверки за Web API-та и човешко поведение). Типове: Managed / Non-interactive
  / Invisible. WCAG 2.2 AA. Не изисква трафик през Cloudflare CDN.
- Поток: widget на `/chat` (public site key) → краткотраен **token** → фронтендът
  го праща с чат заявката → бекендът го проверява срещу
  `https://challenges.cloudflare.com/turnstile/v0/siteverify` със **secret key**.
  Токенът е еднократен, ~300s TTL. Пускаме retrieval + LLM само при `success: true`.
- Защо: публичен endpoint без автентикация е цел за скриптове, които палят скъпи
  embeddings + LLM. Turnstile реже автоматизирания шум преди да сме похарчили
  токен и пази rate limit-а от това да е единствена защита.

---

## 8. Слаби места / рискове, които следим

- **EventSource не поддържа POST** → фронтендът чете потока през `fetch` +
  `ReadableStream`, не през `EventSource`.
- **Дублиране на retrieval логиката** (`rag_query.mjs` ↔ `rag.ts`) → риск от
  разминаване; държим и двете синхронни и покриваме с тестове.
- **Wall-clock / idle timeout** на Edge Function → keepalive в SSE.
- **CORS** — сайтът е на GitHub Pages (различен origin) → строг allowlist за
  `https://karadere.one`.
- **Цена / abuse** — публичен endpoint; нужни лимити за дължина и честота
  (Ф.4). Free моделът на OpenRouter има по-агресивни rate limit-и и данните
  обикновено могат да се ползват за обучение — компромис, който трябва да знаем.
- **Правна отговорност** — съдържанието е правно (Заповед № РД-354 и др.);
  отговорите цитират конкретен член/глава и носят дисклеймър, че не са правен съвет.
- **Идентичност на вложението** — размерът на embedding трябва да е точно 768
  (схемата е `vector(768)`).
- **Jekyll билдва от корена** → `chat/` трябва да е в `exclude` на `_config.yml`,
  иначе `.ts`/`config.toml` влизат в сайта като статични файлове.

---

## 9. Отворени въпроси

- Няма блокиращи. Линк „Чат“ в хедъра, Turnstile и rate limit са отложени
  съзнателно за по-късни етапи.
