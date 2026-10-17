import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, schema } from "@/lib/db/client";
import {
  MissingApiKeyError,
  injuryReport,
  type InjuryReport,
} from "@/lib/injuries/report";

/**
 * Injury report for one game, generated on demand.
 *
 * Every call here costs real money and takes several seconds of web search,
 * so the result is cached and concurrent callers share one request. Without
 * that, double-clicking a row bills twice for the same answer.
 */

/** Injury news moves on a daily cadence; an hour of staleness is invisible. */
const TTL_MS = 60 * 60 * 1000;

interface Entry {
  /** Held as the promise so concurrent callers join the in-flight request. */
  report: Promise<InjuryReport>;
  at: number;
}

/**
 * Module-level, so it dies with the dev server -- which is the right lifetime
 * for a single-user local tool. A persistent cache would need invalidation
 * when the injury report itself changes, which is the thing we cannot observe.
 */
const cache = new Map<string, Entry>();

export async function POST(request: Request) {
  let body: {
    season?: unknown;
    week?: unknown;
    team?: unknown;
    opponent?: unknown;
    refresh?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const season = typeof body.season === "number" ? body.season : null;
  const week = typeof body.week === "number" ? body.week : null;
  const team = typeof body.team === "string" ? body.team : null;
  const opponent = typeof body.opponent === "string" ? body.opponent : null;
  if (season === null || week === null || !team || !opponent) {
    return NextResponse.json(
      { error: "season, week, team and opponent are required." },
      { status: 400 },
    );
  }

  /**
   * The game is resolved from the two teams rather than from a game id sent by
   * the caller. The id has a composed shape (`2026_07_IND_MIN`), and rebuilding
   * it in the browser would hard-code that format into the UI -- a silent
   * breakage the day the schedule ingest changes it. Two team codes and a week
   * identify a game just as uniquely, and survive that change.
   */
  const candidates = await db
    .select()
    .from(schema.games)
    .where(and(eq(schema.games.season, season), eq(schema.games.week, week)));

  const game = candidates.find(
    (g) =>
      (g.homeTeam === team && g.awayTeam === opponent) ||
      (g.awayTeam === team && g.homeTeam === opponent),
  );

  if (!game) {
    return NextResponse.json(
      { error: `No week ${week} game between ${team} and ${opponent}.` },
      { status: 404 },
    );
  }

  const gameId = game.gameId;

  const names = await db
    .select({ abbr: schema.teams.abbr, name: schema.teams.name })
    .from(schema.teams);
  const nameOf = new Map(names.map((t) => [t.abbr, t.name]));

  const force = body.refresh === true;
  const hit = cache.get(gameId);
  if (hit && !force && Date.now() - hit.at < TTL_MS) {
    try {
      return NextResponse.json({ ...(await hit.report), cached: true });
    } catch {
      // A cached rejection must not be served forever: fall through and retry.
      cache.delete(gameId);
    }
  }

  const pending = injuryReport({
    awayTeam: game.awayTeam,
    homeTeam: game.homeTeam,
    awayName: nameOf.get(game.awayTeam) ?? game.awayTeam,
    homeName: nameOf.get(game.homeTeam) ?? game.homeTeam,
    week: game.week,
    season: game.season,
    kickoffUtc: game.kickoffUtc,
  });
  cache.set(gameId, { report: pending, at: Date.now() });

  try {
    return NextResponse.json({ ...(await pending), cached: false });
  } catch (err) {
    cache.delete(gameId);
    if (err instanceof MissingApiKeyError) {
      // A configuration state, not a failure -- same treatment the refresh
      // route gives a missing ODDS_API_KEY.
      return NextResponse.json(
        {
          error:
            "No ANTHROPIC_API_KEY set. Add one to .env to enable injury reports.",
          configuration: true,
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Injury lookup failed." },
      { status: 502 },
    );
  }
}
