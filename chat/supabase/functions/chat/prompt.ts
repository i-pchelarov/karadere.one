// Системен промпт и сглобяване на контекста за LLM — ЗАМЕСТИТЕЛ (Ф.2).
//
// Минимална, но работеща версия: достатъчна, за да мине e2e потокът
// (retrieval → контекст → LLM → SSE). Пълната версия идва във Ф.4 — тон,
// ограничения, формат на цитатите, поведение при „няма намерени разпоредби“,
// ограничаване на дължината на контекста.

import type { Hit } from "./rag.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export const SYSTEM_PROMPT =
  `Ти си асистент на karadere.one — сайт за защитените територии и Черноморското крайбрежие.
Отговаряй на български, кратко и по същество.
Ако по-долу има извадки от нормативни актове, основавай отговора на тях и цитирай члена (напр. „Чл. 10а“).
Ако извадките не съдържат отговор, кажи го ясно и не измисляй разпоредби.`;

// Извлича номера на члена от metadata — `article_number`, иначе `article`.
// Маха водещо „Чл.“/„чл.“ и завършваща точка.
export function articleOf(hit: Hit): string | null {
  const meta = (hit.metadata ?? {}) as Record<string, unknown>;
  const raw = meta.article_number ?? meta.article;
  if (raw === undefined || raw === null) return null;
  const cleaned = String(raw)
    .trim()
    .replace(/^[Чч]л\.?\s*/, "")
    .replace(/\.$/, "")
    .trim();
  return cleaned === "" ? null : cleaned;
}

// Номерата на намерените членове, без повторения и без празни стойности.
// Хибридният retrieval може да върне един и същ член и по векторния, и по
// keyword пътя; в `meta` той трябва да се появи веднъж.
export function uniqueArticles(hits: Hit[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hit of hits) {
    const article = articleOf(hit);
    if (article === null || seen.has(article)) continue;
    seen.add(article);
    out.push(article);
  }
  return out;
}

// Сглобява извадките в четим за модела блок. Номерирани са, за да може
// моделът да цитира по номер, а не да преписва заглавия.
export function buildContext(hits: Hit[]): string {
  if (hits.length === 0) return "";
  const parts: string[] = [];
  hits.forEach((hit, i) => {
    const article = articleOf(hit);
    const heading = article ? `Чл. ${article}` : (hit.title ?? "Извадка");
    const title = hit.title && article ? ` — ${hit.title}` : "";
    parts.push(`[${i + 1}] ${heading}${title}\n${hit.content.trim()}`);
  });
  return parts.join("\n\n");
}

// Сглобява финалния масив за OpenRouter: системен промпт (+ контекст, ако има),
// след това историята. Контекстът се слага в системното съобщение, не в
// потребителското — така не се смесва с въпроса и не се дублира при retry.
export function buildMessages(
  history: ChatMessage[],
  hits: Hit[],
): ChatMessage[] {
  const context = buildContext(hits);
  const system = context
    ? `${SYSTEM_PROMPT}\n\nИзвадки от нормативни актове:\n\n${context}`
    : SYSTEM_PROMPT;
  return [{ role: "system", content: system }, ...history];
}
