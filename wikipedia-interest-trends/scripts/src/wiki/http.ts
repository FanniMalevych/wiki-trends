import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { SKILL_ROOT } from "../meta.js";
import { userAgent } from "./useragent.js";

// WIT_HTTP_MODE:
//   live   (default) talk to the network
//   record talk to the network and save responses as fixtures
//   replay serve responses from fixtures only; never touch the network
export type HttpMode = "live" | "record" | "replay";

export interface HttpResponse {
  status: number;
  body: unknown;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status: number | undefined,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

interface Fixture {
  url: string;
  status: number;
  body: unknown;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;
const MAX_DELAY_MS = 30_000;
const TIMEOUT_MS = 30_000;

const stats = { network: 0, replayed: 0, retries: 0 };

export function httpStats(): Readonly<typeof stats> {
  return { ...stats };
}

export function httpMode(): HttpMode {
  const mode = process.env.WIT_HTTP_MODE ?? "live";
  if (mode === "live" || mode === "record" || mode === "replay") return mode;
  throw new Error(`Invalid WIT_HTTP_MODE "${mode}". Use live, record or replay.`);
}

function fixturesDir(): string {
  return process.env.WIT_FIXTURES_DIR || join(SKILL_ROOT, "tests", "fixtures", "http");
}

function fixturePath(url: string): string {
  return join(fixturesDir(), createHash("sha256").update(url).digest("hex").slice(0, 16) + ".json");
}

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  const base = Number(process.env.WIT_HTTP_RETRY_BASE_MS ?? 1000);
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : base * 2 ** attempt;
  return Math.min(delay, MAX_DELAY_MS);
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function fromNetwork(url: string): Promise<HttpResponse> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      stats.network++;
      res = await fetch(url, {
        headers: { "User-Agent": userAgent(), "Api-User-Agent": userAgent(), Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt + 1 >= MAX_ATTEMPTS) {
        throw new HttpError(`Network error for ${url}: ${(err as Error).message}`, url, undefined);
      }
      stats.retries++;
      await sleep(retryDelayMs(attempt, null));
      continue;
    }
    if (RETRYABLE.has(res.status) && attempt + 1 < MAX_ATTEMPTS) {
      stats.retries++;
      await res.body?.cancel();
      await sleep(retryDelayMs(attempt, res.headers.get("retry-after")));
      continue;
    }
    return { status: res.status, body: await readBody(res) };
  }
}

async function get(url: string): Promise<HttpResponse> {
  const mode = httpMode();
  if (mode === "replay") {
    let fixture: Fixture;
    try {
      fixture = JSON.parse(readFileSync(fixturePath(url), "utf8")) as Fixture;
    } catch {
      throw new HttpError(`No recorded fixture for ${url} (WIT_HTTP_MODE=replay).`, url, undefined);
    }
    stats.replayed++;
    return { status: fixture.status, body: fixture.body };
  }

  const response = await fromNetwork(url);
  if (mode === "record" && (response.status === 200 || response.status === 404)) {
    mkdirSync(fixturesDir(), { recursive: true });
    const fixture: Fixture = { url, ...response };
    writeFileSync(fixturePath(url), JSON.stringify(fixture, null, 1) + "\n");
  }
  return response;
}

// Wikimedia asks clients to send requests one at a time, so every call joins a single queue.
let queue: Promise<unknown> = Promise.resolve();

export function getJson(url: string): Promise<HttpResponse> {
  const next = queue.then(() => get(url));
  queue = next.catch(() => undefined);
  return next;
}
