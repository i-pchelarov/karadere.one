// SSE клиент за чата — чете `text/event-stream` през fetch + ReadableStream.
//
// Защо не EventSource: той не поддържа POST, а ние пращаме тялото на заявката
// (историята на чата) в POST. Затова четем потока ръчно.
//
// Модулът е чист — без DOM, без глобални константи. `fetch` се инжектира, така
// че тестовете вървят офлайн (виж sse_test.js). DOM-връзката (писане в
// страницата) живее отделно в chat.js.
//
// Протоколът от бекенда (index.ts) е SSE с именувани събития:
//   event: meta    → { articles, hits, trace }
//   event: delta   → { text }
//   event: warning → { message }
//   event: done    → { finish }
//   event: error   → { message }

// Разделя байтовия поток на SSE кадри и вика onEvent(име, данни).
// Държи вътрешен буфер, за да понася кадър, разцепен между два chunk-а.
export function createSseParser(onEvent) {
  let buffer = "";
  let eventName = "";
  let dataLines = [];

  function dispatch() {
    if (dataLines.length > 0) {
      onEvent(eventName || "message", dataLines.join("\n"));
    }
    eventName = "";
    dataLines = [];
  }

  function handleLine(rawLine) {
    let line = rawLine;
    if (line.endsWith("\r")) line = line.slice(0, -1); // CRLF

    if (line === "") {
      dispatch(); // празен ред = край на кадър
      return;
    }
    if (line.startsWith(":")) return; // коментар / keepalive (`: ping`)

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
    // останалите полета (id, retry) не ни трябват
  }

  return {
    push(chunk) {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        handleLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    },
    // Извиква се в края. По SSE спецификацията непълният последен кадър се
    // изхвърля, но ние сме по-снизходителни: ако потокът свърши без финален
    // празен ред, последният ред и кадърът пак се доставят — иначе `done`
    // се губи при сървър, който не слага завършващ `\n\n`.
    flush() {
      if (buffer !== "") {
        handleLine(buffer);
        buffer = "";
      }
      dispatch();
    },
  };
}

// Чете SSE потока от `url` и вика съответния callback за всяко събитие.
//
// Връща { ok, done, status?, error? }:
//   ok    — потокът приключи без фатална грешка
//   done  — видяхме ли `event: done` (сървърът затвори нормално)
//   error — текст на фаталната грешка, ако има
export async function streamChat({
  url,
  body,
  fetchImpl = fetch,
  signal,
  headers = {},
  onMeta,
  onDelta,
  onWarning,
  onDone,
  onError,
}) {
  let resp;
  try {
    resp = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    const message = String(err);
    if (onError) onError({ message, fatal: true });
    return { ok: false, done: false, error: message };
  }

  if (!resp.ok) {
    let detail = "";
    try {
      detail = (await resp.text()).slice(0, 300);
    } catch {
      // тялото може да липсва — не е фатално за съобщението за грешка
    }
    const message = `HTTP ${resp.status}${detail ? `: ${detail}` : ""}`;
    if (onError) onError({ message, status: resp.status, fatal: true });
    return { ok: false, done: false, status: resp.status, error: message };
  }

  if (!resp.body) {
    const message = "отговорът няма тяло";
    if (onError) onError({ message, fatal: true });
    return { ok: false, done: false, error: message };
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let sawDone = false;
  let fatal = null;

  const parser = createSseParser((event, data) => {
    let payload = {};
    if (data !== "") {
      try {
        payload = JSON.parse(data);
      } catch {
        payload = { raw: data }; // не-JSON данни — не чупим потока
      }
    }
    switch (event) {
      case "meta":
        if (onMeta) onMeta(payload);
        break;
      case "delta":
        if (onDelta) onDelta(payload);
        break;
      case "warning":
        if (onWarning) onWarning(payload);
        break;
      case "done":
        sawDone = true;
        if (onDone) onDone(payload);
        break;
      case "error":
        fatal = payload.message ?? "грешка";
        if (onError) onError({ ...payload, fatal: true });
        break;
      default:
        break; // непознато събитие — прескачаме
    }
  });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode()); // изпразва decoder-а
    parser.flush();
  } catch (err) {
    const message = String(err);
    if (onError) onError({ message, fatal: true });
    return { ok: false, done: sawDone, error: message };
  } finally {
    reader.releaseLock();
  }

  return { ok: fatal === null, done: sawDone, error: fatal };
}
