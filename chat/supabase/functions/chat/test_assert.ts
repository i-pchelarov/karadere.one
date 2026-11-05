// Минимални assert-и без външни зависимости.
//
// Причина: `deno.land/std/assert` се тегли по мрежата и пада зад egress
// проксито с изтекъл/непознат CA. Тестовете трябва да вървят офлайн, така че
// suite-ът не зависи от нито един download.

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

export function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new AssertionError(msg);
}

export function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new AssertionError(
      msg ?? `очаквано ${e}, получено ${a}`,
    );
  }
}

export function assertNotEquals<T>(actual: T, expected: T, msg?: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    throw new AssertionError(msg ?? `неочаквано равенство: ${JSON.stringify(actual)}`);
  }
}

export function assertStringIncludes(
  actual: string,
  expected: string,
  msg?: string,
): void {
  if (!actual.includes(expected)) {
    throw new AssertionError(
      msg ?? `низът не съдържа „${expected}“: ${actual.slice(0, 200)}`,
    );
  }
}

export function assertThrows(
  fn: () => unknown,
  msg?: string,
): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new AssertionError(msg ?? "очаквано изключение, но няма");
}
