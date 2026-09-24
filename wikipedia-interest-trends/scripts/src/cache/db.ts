import { accessSync, constants, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { SKILL_ROOT } from "../meta.js";
import type { Point, SeriesKey } from "../wiki/pageviews.js";

// Each entry upgrades the schema by one version; never edit a shipped entry.
const MIGRATIONS = [
  `CREATE TABLE series (
     id INTEGER PRIMARY KEY,
     kind TEXT NOT NULL,
     project TEXT NOT NULL,
     article TEXT NOT NULL,
     access TEXT NOT NULL,
     agent TEXT NOT NULL,
     granularity TEXT NOT NULL,
     UNIQUE (kind, project, article, access, agent, granularity)
   );
   CREATE TABLE points (
     series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
     period TEXT NOT NULL,
     views INTEGER NOT NULL,
     fetched_at INTEGER NOT NULL,
     PRIMARY KEY (series_id, period)
   ) WITHOUT ROWID;`,
  // v2: raw MediaWiki/Wikidata responses, keyed by request URL
  `CREATE TABLE responses (
     url TEXT PRIMARY KEY,
     body TEXT NOT NULL,
     fetched_at INTEGER NOT NULL
   );`,
];

export interface CachedPoint {
  views: number;
  fetchedAt: number;
}

function isWritableDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * WIT_CACHE_DIR if set; otherwise <skill>/.cache, falling back to the user's
 * cache directory when the skill is installed read-only.
 */
export function defaultCachePath(): string {
  const local = join(SKILL_ROOT, ".cache");
  const dir =
    process.env.WIT_CACHE_DIR ||
    (isWritableDir(local) ? local : join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "wikipedia-interest-trends"));
  return join(dir, "wit.sqlite");
}

/**
 * Loads node:sqlite on first use. Node 22 prints an ExperimentalWarning to
 * stderr when it loads; agents often read stderr together with stdout, so that
 * one warning is filtered while loading. (A static import cannot be guarded
 * this way: ES modules load built-ins before any module code runs.)
 */
function openDatabase(path: string): DatabaseSync {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === "string" ? warning : warning.message;
    if (!message.includes("SQLite is an experimental feature")) Reflect.apply(emitWarning, process, [warning, ...rest]);
  }) as typeof process.emitWarning;
  try {
    const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
    return new sqlite.DatabaseSync(path);
  } finally {
    process.emitWarning = emitWarning;
  }
}

/**
 * Stores every period of every series fetched so far, including zero-view
 * periods, so "which periods are missing?" is a plain lookup.
 */
export class Cache {
  readonly path: string;
  private db: DatabaseSync;

  constructor(path = defaultCachePath()) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.db = openDatabase(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    const { user_version } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (user_version > MIGRATIONS.length) {
      throw new Error(`Cache at ${this.path} was written by a newer version (schema v${user_version}). Delete the file.`);
    }
    for (let v = user_version; v < MIGRATIONS.length; v++) {
      this.db.exec(`BEGIN; ${MIGRATIONS[v]} PRAGMA user_version = ${v + 1}; COMMIT;`);
    }
  }

  private seriesId(key: SeriesKey, create: boolean): number | undefined {
    const params = [key.kind, key.project, key.article, key.access, key.agent, key.granularity] as const;
    if (create) {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO series (kind, project, article, access, agent, granularity) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(...params);
    }
    const row = this.db
      .prepare("SELECT id FROM series WHERE kind = ? AND project = ? AND article = ? AND access = ? AND agent = ? AND granularity = ?")
      .get(...params) as { id: number } | undefined;
    return row?.id;
  }

  load(key: SeriesKey, start: string, end: string): Map<string, CachedPoint> {
    const out = new Map<string, CachedPoint>();
    const id = this.seriesId(key, false);
    if (id === undefined) return out;
    const rows = this.db
      .prepare("SELECT period, views, fetched_at FROM points WHERE series_id = ? AND period BETWEEN ? AND ? ORDER BY period")
      .all(id, start, end) as Array<{ period: string; views: number; fetched_at: number }>;
    for (const r of rows) out.set(r.period, { views: r.views, fetchedAt: r.fetched_at });
    return out;
  }

  save(key: SeriesKey, points: Point[], fetchedAt: number): void {
    if (points.length === 0) return;
    const id = this.seriesId(key, true)!;
    const upsert = this.db.prepare(
      "INSERT INTO points (series_id, period, views, fetched_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT (series_id, period) DO UPDATE SET views = excluded.views, fetched_at = excluded.fetched_at",
    );
    this.db.exec("BEGIN");
    try {
      for (const p of points) upsert.run(id, p.period, p.views, fetchedAt);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getResponse(url: string): { body: unknown; fetchedAt: number } | undefined {
    const row = this.db.prepare("SELECT body, fetched_at FROM responses WHERE url = ?").get(url) as
      | { body: string; fetched_at: number }
      | undefined;
    return row && { body: JSON.parse(row.body) as unknown, fetchedAt: row.fetched_at };
  }

  putResponse(url: string, body: unknown, fetchedAt: number): void {
    this.db
      .prepare(
        "INSERT INTO responses (url, body, fetched_at) VALUES (?, ?, ?) " +
          "ON CONFLICT (url) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at",
      )
      .run(url, JSON.stringify(body), fetchedAt);
  }

  stats() {
    const totals = this.db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM series) AS series, (SELECT COUNT(*) FROM points) AS points, " +
          "(SELECT COUNT(*) FROM responses) AS lookups",
      )
      .get() as { series: number; points: number; lookups: number };
    const projects = this.db
      .prepare(
        `SELECT s.project, s.granularity,
                COUNT(DISTINCT CASE WHEN s.kind = 'article' THEN s.id END) AS articles,
                COUNT(p.period) AS points,
                MIN(p.period) AS first, MAX(p.period) AS last
           FROM series s LEFT JOIN points p ON p.series_id = s.id
          GROUP BY s.project, s.granularity ORDER BY s.project, s.granularity`,
      )
      .all();
    let bytes = 0;
    for (const suffix of ["", "-wal"]) {
      try {
        bytes += statSync(this.path + suffix).size;
      } catch {
        // WAL file may not exist
      }
    }
    return { path: this.path, bytes, ...totals, projects };
  }

  /**
   * Deletes cached series and title lookups (all, or one project's).
   * Wikidata lookups span every edition, so they are only removed by a full clear.
   */
  clear(project?: string): { series: number; lookups: number } {
    const series = project
      ? this.db.prepare("DELETE FROM series WHERE project = ?").run(project)
      : this.db.prepare("DELETE FROM series").run();
    const lookups = project
      ? this.db.prepare("DELETE FROM responses WHERE url LIKE ?").run(`https://${project}.org/%`)
      : this.db.prepare("DELETE FROM responses").run();
    this.db.exec("VACUUM");
    return { series: Number(series.changes), lookups: Number(lookups.changes) };
  }

  close(): void {
    this.db.close();
  }
}
