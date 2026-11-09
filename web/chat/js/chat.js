// DOM връзка за /chat — свързва формата със SSE клиента (sse.js).
//
// Чистата логика (парсер + streamChat) живее в sse.js и се тества офлайн.
// Тук е само DOM-ът: четене на входа, рендиране на съобщенията и цитатите,
// състояния (стримиране / грешка / стоп).
//
// За да е модулът тестваем, DOM-достъпът е само вътре в initChat(); чистите
// помощни функции са изнесени и се покриват от chat_test.js.

import { streamChat } from "./sse.js";

// Колко съобщения пазим в историята, която пращаме към бекенда.
export const MAX_HISTORY = 20;

// Подготвя тялото на заявката към Edge Function.
// `turnstileToken` е незадължителен: когато widget-ът не е конфигуриран
// (локално), полето просто отсъства и бекендът прескача проверката.
export function buildRequestBody(history, mode = "auto", turnstileToken = "") {
  const body = {
    messages: history.map((m) => ({ role: m.role, content: m.content })),
    mode,
  };
  if (typeof turnstileToken === "string" && turnstileToken !== "") {
    body.turnstileToken = turnstileToken;
  }
  return body;
}

// Чете текущия Turnstile токен. Widget-ът рендира скрит input
// `cf-turnstile-response` вътре в контейнера; той носи еднократния токен.
// Връща "", ако widget няма (локално) — тогава бекендът не изисква токен.
export function readTurnstileToken(root = document) {
  const el = root.querySelector?.('input[name="cf-turnstile-response"]');
  return el && typeof el.value === "string" ? el.value : "";
}

// Нулира Turnstile widget-а. Токенът е еднократен — след всяка заявка трябва
// нов, иначе следващата ще бъде отказана с 403. Безопасно е и когато widget
// липсва (локално): тогава просто няма какво да нулираме.
export function resetTurnstile(root = document) {
  const el = root.getElementById?.("chat-turnstile");
  if (!el) return;
  const api = globalThis.turnstile;
  if (api && typeof api.reset === "function") api.reset(el);
}

// Пази само последните `max` съобщения — по-старата история не помага и само
// хаби токени. Не пипа подадения масив.
export function trimHistory(history, max = MAX_HISTORY) {
  if (history.length <= max) return history.slice();
  return history.slice(history.length - max);
}

// Слива новите членове с вече показаните — без дубликати, в реда на идване.
export function mergeArticles(prev, next) {
  const out = prev.slice();
  for (const a of next) {
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

// Инициализира чата върху даден DOM корен. Връща handle за тестове/дебъг или
// null, ако задължителните елементи липсват.
export function initChat({ root = document, streamChatImpl = streamChat } = {}) {
  const form = root.getElementById("chat-form");
  const input = root.getElementById("chat-input");
  const log = root.getElementById("chat-log");
  const sendBtn = root.getElementById("chat-send");
  const stopBtn = root.getElementById("chat-stop");
  const sourcesEl = root.getElementById("chat-sources");
  const statusEl = root.getElementById("chat-status");
  const chatRoot = root.getElementById("chat-root");

  if (!form || !input || !log) return null;

  // Endpoint-ът идва от data-атрибут — нищо инфраструктурно не се хардкодва
  // във фронтенда.
  const endpoint = chatRoot?.dataset?.endpoint ?? "";

  const history = [];
  let controller = null;
  let streaming = false;
  let articles = [];

  function setStatus(text, kind = "") {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = "chat-status" + (kind ? ` chat-status--${kind}` : "");
  }

  function setStreaming(on) {
    streaming = on;
    if (sendBtn) sendBtn.disabled = on;
    if (stopBtn) stopBtn.classList.toggle("hidden", !on);
    input.disabled = on;
  }

  function renderSources() {
    if (!sourcesEl) return;
    sourcesEl.innerHTML = "";
    if (articles.length === 0) {
      sourcesEl.classList.add("hidden");
      return;
    }
    sourcesEl.classList.remove("hidden");
    const label = document.createElement("span");
    label.className = "chat-sources__label";
    label.textContent = "Цитирани разпоредби:";
    sourcesEl.appendChild(label);
    for (const a of articles) {
      const chip = document.createElement("span");
      chip.className = "chat-chip";
      chip.textContent = `Чл. ${a}`;
      sourcesEl.appendChild(chip);
    }
  }

  // Създава балон за съобщение и връща функция за допълване на текста му
  // (използва се при стрийминг на отговора).
  //
  // Делтите идват по 1-2 токена — стотици на отговор. Ако пишем в DOM-а и
  // скролваме при всяка, браузърът прави стотици reflow-а и текстът трепти.
  // Затова трупаме в буфер и изписваме веднъж на кадър.
  function addBubble(role, text = "") {
    const wrap = document.createElement("div");
    wrap.className = `chat-msg chat-msg--${role}`;
    const body = document.createElement("div");
    body.className = "chat-msg__body";
    body.textContent = text;
    wrap.appendChild(body);
    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;

    let pending = "";
    let frame = 0;

    function flushNow() {
      frame = 0;
      if (pending === "") return;
      body.textContent += pending;
      pending = "";
      log.scrollTop = log.scrollHeight;
    }

    return {
      append(chunk) {
        pending += chunk;
        if (frame === 0) frame = requestAnimationFrame(flushNow);
      },
      set(text2) {
        pending = "";
        if (frame !== 0) {
          cancelAnimationFrame(frame);
          frame = 0;
        }
        body.textContent = text2;
        log.scrollTop = log.scrollHeight;
      },
      // Изписва остатъка веднага — вика се при край на потока, за да не се
      // загуби последното парче, ако кадърът още не е дошъл.
      flush() {
        if (frame !== 0) {
          cancelAnimationFrame(frame);
          frame = 0;
        }
        flushNow();
      },
      el: wrap,
    };
  }

  async function send(text) {
    const question = text.trim();
    if (question === "" || streaming) return;

    if (endpoint === "") {
      setStatus("Липсва endpoint (data-endpoint).", "error");
      return;
    }

    history.push({ role: "user", content: question });
    addBubble("user", question);
    input.value = "";
    articles = [];
    renderSources();
    setStreaming(true);
    setStatus("Търся в нормативната база…");

    const answer = addBubble("assistant", "");
    let gotFirstToken = false;
    controller = new AbortController();

    const res = await streamChatImpl({
      url: endpoint,
      body: buildRequestBody(trimHistory(history), "auto", readTurnstileToken(root)),
      signal: controller.signal,
      onMeta: (meta) => {
        articles = mergeArticles(articles, meta.articles ?? []);
        renderSources();
        setStatus(
          meta.hits > 0
            ? `Намерени ${meta.hits} извадки — генерирам отговор…`
            : "Няма намерени разпоредби — отговарям по общи познания…",
        );
      },
      onDelta: (d) => {
        if (!gotFirstToken) {
          gotFirstToken = true;
          setStatus("Генерирам отговор…");
        }
        answer.append(d.text ?? "");
      },
      onWarning: (w) => {
        setStatus(`Внимание: ${w.message}`, "warn");
      },
      onError: (e) => {
        setStatus(`Грешка: ${e.message}`, "error");
      },
    });

    if (res.ok && res.done) {
      setStatus("");
      // Изписваме остатъка от буфера ПРЕДИ да четем текста за историята —
      // иначе последните делти (до един кадър) се губят от контекста.
      answer.flush();
      history.push({ role: "assistant", content: answer.el.textContent });
    } else if (res.error) {
      answer.flush();
      setStatus(`Грешка: ${res.error}`, "error");
    } else {
      answer.flush();
    }

    controller = null;
    setStreaming(false);
    // Токенът е изразходван — взимаме нов за следващия въпрос.
    resetTurnstile(root);
    input.focus();
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    send(input.value);
  });

  // Enter праща, Shift+Enter е нов ред.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input.value);
    }
  });

  if (stopBtn) {
    stopBtn.addEventListener("click", () => {
      if (controller) controller.abort();
      setStatus("Спряно.", "warn");
    });
  }

  setStreaming(false);
  setStatus("");

  return { send, history, get articles() { return articles; } };
}

// Автоматично вдигане в браузъра (не при import от тест).
if (typeof document !== "undefined" && typeof window !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => initChat());
}
