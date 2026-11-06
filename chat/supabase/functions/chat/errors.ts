// Грешка с две лица.
//
// `detail` (наследеното `message`) е пълният, суров текст — тяло от доставчик,
// име на модел, метаданни. Остава САМО в логовете.
//
// `publicMessage` е единственото, което може да излезе към клиента: кратко,
// без име на доставчик и без сурови метаданни. Така upstream тялото не изтича
// по мрежата, а причината пак е видима за оператора в лога.

export class ChatError extends Error {
  readonly publicMessage: string;

  constructor(
    publicMessage: string,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(detail, options);
    this.name = "ChatError";
    this.publicMessage = publicMessage;
  }
}

// Безопасното съобщение за клиента. За неочаквани (не-ChatError) грешки връща
// `fallback` — никога `String(err)`, защото то може да носи суров отговор от
// доставчик.
export function publicMessageOf(err: unknown, fallback: string): string {
  return err instanceof ChatError ? err.publicMessage : fallback;
}
