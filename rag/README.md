# RAG модул

Захранване (ингест) на документи в Supabase pgvector и семантично/хибридно
търсене върху тях. Двете операции са отделни CLI-та, които ползват само
публични HTTP endpoint-и — не е нужен Postgres драйвер.

## Компоненти

| Файл | Роля |
| --- | --- |
| `ingest_text.py` | **Запис** — текст/файл/Google Doc → embeddings → `document_sections` |
| `rag_query.py` | **Търсене** — същият pipeline на Python stdlib (`http.client`) |
| `rag_query.mjs` | **Търсене** — Node вариант (fetch + `NODE_USE_ENV_PROXY`) |
| `rag_schema.sql` | Схема: таблица + HNSW индекс + `match_document_sections()` RPC |

## Конфигурация (само от environment)

| Променлива | За какво |
| --- | --- |
| `OPENROUTER_API_KEY` | embeddings |
| `SUPABASE_URL` | напр. `https://<ref>.supabase.co/rest/v1/` |
| `SUPABASE_SERVICE_ROLE_KEY` | запис (заобикаля RLS) |

Embeddings минават през **OpenRouter** (`openai/text-embedding-3-small`,
`dimensions=768`), не директно през OpenAI. Egress-ът минава през OpenClaw
secrets proxy (`HTTP(S)_PROXY` вече е зададен в средата). Секретите се четат
само от environment и никога не се печатат.

## Запис (ингест)

```bash
# от файл
python3 ingest_text.py --file notes.txt --document-id doc-001 --title "Notes"

# от низ
python3 ingest_text.py --text "Текст" --document-id doc-002

# от stdin
cat notes.txt | python3 ingest_text.py --document-id doc-003

# от Google Doc (URL или id; title/document_id/url се попълват автоматично)
python3 ingest_text.py --google-doc "https://docs.google.com/document/d/<id>/edit"

# само embed, без запис
python3 ingest_text.py --file notes.txt --dry-run

# пре-ингест, заменяйки съществуващ документ
python3 ingest_text.py --file notes.txt --document-id doc-001 --replace

# smoke-test на търсене след запис
python3 ingest_text.py --document-id doc-001 --query "как се къмпингува"
```

**Юридическо разделяне:** при `--split auto` (по подразбиране) текстът се
разпознава като юридически, ако съдържа маркери за членове (`Чл. 4.`) и алинеи
(`(1)`) — тогава всеки член става отделен chunk, а етикетът на члена и
обхващащата `Глава`/`Раздел` отиват в `metadata` за цитиране.

Други флагове: `--model`, `--dimensions`, `--chunk-size` (1200),
`--chunk-overlap` (150), `--legal-max` (6000), `--split`, `--metadata`,
`--composio`.

## Търсене

```bash
python3 rag_query.py "въпрос" [n] [--mode auto|vector|keyword]
node    rag_query.mjs "въпрос" [n] [--mode auto|vector|keyword]
```

Позволени са и съкратените форми `--vector` / `--keyword`; `--mode` приема
стойността и с `=`, и с интервал.

**Хибридно търсене** (`--mode auto`, по подразбиране):

1. **Векторно** търсене (cosine) през RPC `match_document_sections`.
2. Ако резултатът е слаб — няма попадения, топ similarity под прага или
   твърде малко попадения — **fallback към keyword** търсене през PostgREST
   `ilike` OR филтри, ранкирано по брой съвпаднали термини.

Всеки резултат носи `matched_by` = `vector`/`keyword`, а `trace.path` показва
пътя: `vector` | `keyword` | `vector+keyword`.

**Настройване (env):**

| Променлива | По подразбиране | Значение |
| --- | --- | --- |
| `RAG_VECTOR_THRESHOLD` | `0.20` | минимална cosine близост за запазване на векторно попадение |
| `RAG_HYBRID_WEAK_TOP` | `0.38` | под този топ score векторният резултат е „слаб“ |
| `RAG_HYBRID_MIN_HITS` | `2` | минимален брой векторни попадения за добро покритие |
| `RAG_HYBRID_FETCH_FACTOR` | `4` | колко реда се дърпат за keyword ранкиране |
| `RAG_HYBRID_MAX_TERMS` | `8` | максимум различни термини в OR филтъра |
| `RAG_HYBRID_MIN_TERM_LEN` | `3` | най-къс термин, за който си струва търсене |

Keyword термини: BG+EN stopword списъци, числата се пазят (важни за номера на
членове), най-дългите първо, `ilike` стойностите са escape-нати.

## Схема

`document_sections` пази `content`, `embedding vector(768)` и `metadata`
(`url`, `article`, `chapter`, `chunk_index` и др.). HNSW индекс с
`vector_cosine_ops`; `match_document_sections(query_embedding,
match_threshold, match_count)` връща подредени по cosine близост редове.

## Бележки

- И двата query скрипта обработват TLS през OpenClaw egress proxy-то
  (изчистват `VERIFY_X509_STRICT`, ползват CA bundle-а на проксито). При
  `http.client` `HTTPSConnection` сочи към **проксито**, а `set_tunnel()` — към
  **целта**.

## Тестове

| Файл | Какво проверява |
| --- | --- |
| `test_rag_query.py` | Търсенето: къмпинг въпросът намира правилните членове |
| `test_ingest_pdf.py` | Извличането от PDF: думите не се разпадат на интервали |

```bash
python3 test_rag_query.py
python3 test_ingest_pdf.py
```

`test_ingest_pdf.py` има два слоя:

- **Херметичен** — генерира малък PDF **в паметта** (в git не влиза бинарен
  файл) с Type0 шрифт `CIDFontType2` **без `/W` и `/DW`** — точно дефектът,
  който тестът пази. Слой без мрежа и без ключове, върви винаги в CI. Включва
  и тест, който проверява, че pypdf по подразбиране **все още** разпада думите
  (иначе fixture-ът е спрял да възпроизвежда бъга).
- **Жив** — пуска същия `ingest_pdf.py --drive-file <линк> --dry-run`, който
  операторът пуска ръчно, и проверява резултата (`split: legal`, чист текст,
  `768`-мерен embedding). Иска Composio CLI и `OPENROUTER_API_KEY`; без тях се
  **skip-ва**, не пада.

Настройки: `RAG_TEST_DRIVE_URL` (друг Drive PDF), `COMPOSIO_BIN` (път до CLI-я).

### CI

`.github/workflows/rag-tests.yml` пуска и двата теста при промяна в `rag/**`.
Инсталира `pypdf`; живият Drive тест се skip-ва на runner-а (няма Composio).
