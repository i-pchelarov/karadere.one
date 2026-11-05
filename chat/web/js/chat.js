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
export function buildRequestBody(history, mode = "auto") {
  return {
    messages: history.map((m) => ({ role: m.role, content: m.content })),
    mode,
  };
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
  function addBubble(role, text = "") {
    const wrap = document.createElement("div");
    wrap.className = `chat-msg chat-msg--${role}`;
    const body = document.createElement("div");
    body.className = "chat-msg__body";
    body.textContent = text;
    wrap.appendChild(body);
    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;
    return {
      append(chunk) {
        body.textContent += chunk;
        log.scrollTop = log.scrollHeight;
      },
      set(text2) {
        body.textContent = text2;
        log.scrollTop = log.scrollHeight;
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
      body: buildRequestBody(trimHistory(history)),
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
      history.push({ role: "assistant", content: answer.el.textContent });
    } else if (res.error) {
      setStatus(`Грешка: ${res.error}`, "error");
    }

    controller = null;
    setStreaming(false);
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
