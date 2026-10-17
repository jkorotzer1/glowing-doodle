"use client";

import { useMemo, useState } from "react";
import { scoreTeams } from "@/lib/model/engine";
import { DEFAULT_CONFIG, type ModelConfig } from "@/lib/model/types";
import {
  deserializeMatrix,
  type SerializedMatchups,
  type SerializedMatrix,
} from "@/lib/model/serialize";
import { ScorecardTable } from "./scorecard-table";
import { ScheduleGrid } from "./schedule-grid";
import { PicksPanel } from "./picks-panel";
import { PlanTable } from "./plan-table";
import { SourcesTable } from "./sources-table";
import { SettingsBar } from "./settings-bar";
import { coverageFor } from "@/lib/model/coverage";
import { FreshnessBanner } from "./freshness-banner";
import type { SourceSummary } from "@/lib/db/repo/sources";

export interface UsedPick {
  week: number;
  team: string;
  result: string | null;
}

interface Props {
  season: number;
  currentWeek: number;
  matrix: SerializedMatrix;
  matchups: Record<string, SerializedMatchups>;
  available: string[];
  used: UsedPick[];
  allTeams: string[];
  sources: SourceSummary;
  freshness: {
    odds: string | null;
    silver: string | null;
    silverFetchedAt: string | null;
    silverMethod: string | null;
  };
  initialConfig: { lambda: number; wVegas: number; wSilver: number; horizon: number };
}

type Tab = "scorecard" | "plan" | "grid" | "sources" | "picks";

export function Dashboard(props: Props) {
  const [tab, setTab] = useState<Tab>("scorecard");
  const [lambda, setLambda] = useState(props.initialConfig.lambda);
  const [wVegas, setWVegas] = useState(props.initialConfig.wVegas);
  const [horizon, setHorizon] = useState(props.initialConfig.horizon);
  const [week, setWeek] = useState(props.currentWeek);

  // Rehydrate once; the raw object never changes after the server render.
  const matrix = useMemo(() => deserializeMatrix(props.matrix), [props.matrix]);

  /**
   * The horizon can reach the end of the season, so its ceiling depends on
   * which week you are looking at: 16 more weeks from week 2, none from 18.
   *
   * The raw preference is kept in state and only clamped for use, so stepping
   * to a late week and back does not silently forget a long window.
   */
  const maxHorizon = Math.max(1, 18 - week);
  const effectiveHorizon = Math.min(horizon, maxHorizon);

  const config: ModelConfig = useMemo(
    () => ({
      ...DEFAULT_CONFIG,
      lambda,
      horizon: effectiveHorizon,
      weights: { vegas: wVegas, silver: 1 - wVegas },
    }),
    [lambda, effectiveHorizon, wVegas],
  );

  // Read off the matrix, so it tracks ESPN publishing more weeks by itself.
  const coverage = useMemo(
    () => coverageFor(matrix, week, 18),
    [matrix, week],
  );

  const weekMatchups = useMemo(
    () => new Map(Object.entries(props.matchups[String(week)] ?? {})),
    [props.matchups, week],
  );

  // The whole point of shipping the matrix to the browser: this is a pure
  // function over data we already hold, so dragging lambda re-ranks instantly.
  const rows = useMemo(
    () => scoreTeams(matrix, week, props.available, weekMatchups, config),
    [matrix, week, props.available, weekMatchups, config],
  );

  /**
   * Weeks the plan covers: the selected week plus `horizon` weeks of lookahead,
   * capped by however far the data actually reaches. The Horizon control drives
   * both the Scorecard's PickLater and the Plan, so the two views always reason
   * over the same window.
   *
   * The horizon now runs to the end of the season, so the binding constraint
   * is usually the data rather than the setting: this stops at the first week
   * with no probabilities at all. It does NOT stop where the market stops --
   * ELWAY covers every remaining week, so a long window keeps going on ELWAY
   * alone. The coverage note under the Horizon control says where that
   * boundary falls.
   */
  const planWeeks = useMemo(() => {
    const weeks: number[] = [];
    const lastWeek = Math.min(18, week + effectiveHorizon);
    // Starts from the selected week, not necessarily the current one, so you
    // can look at what the rest of the season looks like from any point.
    for (let w = week; w <= lastWeek; w++) {
      const teams = matrix.get(w);
      if (!teams) break;
      const hasData = [...teams.values()].some(
        (i) => i.vegas !== undefined || i.silver !== undefined,
      );
      if (!hasData) break;
      weeks.push(w);
    }
    return weeks;
  }, [matrix, week, effectiveHorizon]);

  const hasForwardData = useMemo(() => {
    for (let w = week + 1; w <= week + effectiveHorizon; w++) {
      for (const inputs of matrix.get(w)?.values() ?? []) {
        if (inputs.silver !== undefined || inputs.vegas !== undefined) return true;
      }
    }
    return false;
  }, [matrix, week, effectiveHorizon]);

  /** Pool rule: three lives, and a loss burns one. Mirrors livesRemaining(). */
  const livesLeft = useMemo(
    () => Math.max(0, 3 - props.used.filter((u) => u.result === "loss").length),
    [props.used],
  );

  return (
    <main className="mx-auto max-w-[1600px] px-6 py-6">
      <header className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">NFL Survivor</h1>
          <p className="text-sm text-slate-400">
            Season {props.season} &middot; {props.available.length} teams available
            &middot; {livesLeft} lives
          </p>
        </div>
        <nav className="flex gap-1 rounded-lg bg-slate-900 p-1">
          {(["scorecard", "plan", "grid", "sources", "picks"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-md px-3 py-1.5 text-sm capitalize transition ${
                tab === t
                  ? "bg-slate-700 text-white"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {t}
            </button>
          ))}
        </nav>
      </header>

      <FreshnessBanner {...props.freshness} hasForwardData={hasForwardData} />

      <SettingsBar
        lambda={lambda}
        onLambda={setLambda}
        wVegas={wVegas}
        onWVegas={setWVegas}
        horizon={effectiveHorizon}
        onHorizon={setHorizon}
        maxHorizon={maxHorizon}
        week={week}
        onWeek={setWeek}
        currentWeek={props.currentWeek}
        coverage={coverage}
      />

      <div className="mt-5">
        {tab === "scorecard" && (
          <ScorecardTable
            rows={rows}
            week={week}
            horizon={effectiveHorizon}
            season={props.season}
          />
        )}
        {tab === "plan" && (
          <PlanTable
            matrix={matrix}
            matchups={props.matchups}
            available={props.available}
            weeks={planWeeks}
            config={config}
            livesLeft={livesLeft}
          />
        )}
        {tab === "grid" && (
          <ScheduleGrid
            matrix={matrix}
            matchups={props.matchups}
            allTeams={props.allTeams}
            available={new Set(props.available)}
            currentWeek={week}
            horizon={effectiveHorizon}
            weights={config.weights}
          />
        )}
        {tab === "sources" && (
          <SourcesTable
            summary={props.sources}
            currentWeek={props.currentWeek}
          />
        )}
        {tab === "picks" && (
          <PicksPanel
            season={props.season}
            used={props.used}
            available={props.available}
            currentWeek={props.currentWeek}
          />
        )}
      </div>
    </main>
  );
}
