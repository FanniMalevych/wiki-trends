// Every command prints exactly one JSON envelope on stdout so an agent can
// parse results without scraping text.

export interface Envelope<T = unknown> {
  ok: boolean;
  data: T | null;
  warnings: string[];
  errors: string[];
}

export function success<T>(data: T, warnings: string[] = []): Envelope<T> {
  return { ok: true, data, warnings, errors: [] };
}

export function failure(errors: string[], warnings: string[] = []): Envelope<null> {
  return { ok: false, data: null, warnings, errors };
}

export function emit(envelope: Envelope): void {
  process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
}
