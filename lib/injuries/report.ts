import Anthropic from "@anthropic-ai/sdk";

/**
 * Injury-report lookup for a single game, via Claude with web search.
 *
 * WHY WEB SEARCH IS NOT OPTIONAL: an injury report is a fact about this week,
 * and the model's training data ends long before it. Asked without a search
 * tool, Claude will answer from a stale prior and sound exactly as confident
 * as it does when it is right. The `web_search` tool is what makes the answer
 * current; without it this feature is a hallucination generator.
 *
 * Everything here is server-only -- the API key must never reach the browser.
 */

/**
 * Opus, despite costing 2.5x more per token.
 *
 * Measured, not assumed: Sonnet 5 was tried here and came out ~5x MORE
 * expensive per call ($1.43 in tokens vs ~$0.30 all-in), because it pulled far
 * more search content into context -- 618k input tokens against Opus's modest
 * usage for the same kind of game. Per-token price is not the lever on this
 * task; context volume is. Sonnet also leaked its between-search commentary
 * ahead of the first heading, which the modal's parser has nowhere to put.
 */
const MODEL = "claude-opus-5";

/** Short enough for a modal, long enough to cover a real report. */
const MAX_TOKENS = 16_000;

/**
 * Guards a pathological loop. Each pause costs a round trip, and a game that
 * genuinely needs more than this many resumes is a bug, not a thorough search.
 */
const MAX_RESUMES = 4;

export type Impact = "NONE" | "MINOR" | "MODERATE" | "MAJOR";

/**
 * Published per-token rates for the model above, in dollars per million.
 * Hard-coded because there is no pricing endpoint; if the model changes, this
 * must change with it, which is why the model id sits right above.
 */
const INPUT_PER_MTOK = 5;
const OUTPUT_PER_MTOK = 25;

export interface ReportUsage {
  inputTokens: number;
  outputTokens: number;
  /** Server-side searches. Billed per search, SEPARATELY from tokens. */
  webSearches: number;
  /**
   * Token cost only, in dollars. Deliberately NOT a total: web search is
   * billed per request at a rate this code has no way to look up, so calling
   * this the cost of the call would understate every bill. The search count
   * is reported beside it so the gap is visible rather than hidden.
   */
  tokenCostUsd: number;
}

export interface InjuryReport {
  /** The model's prose, in the format the system prompt pins down. */
  summary: string;
  /** Pages the model actually consulted, for the "trust but verify" footer. */
  sources: Array<{ title: string; url: string }>;
  model: string;
  /** When this was generated, so the modal can age it. */
  generatedAt: string;
  usage: ReportUsage;
}

export class MissingApiKeyError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY is not set");
    this.name = "MissingApiKeyError";
  }
}

/**
 * The format contract. Kept verbatim and first in the request so it is a
 * stable cache prefix if this ever grows past the caching minimum.
 *
 * The IMPACT line is parsed by the UI for its severity chip. The parse is
 * deliberately tolerant -- a missing or malformed line costs a chip, not the
 * report -- but the instruction is explicit so it is normally there.
 */
const SYSTEM = `You are an NFL injury analyst embedded in a survivor-pool tool. The user is deciding whether to stake their entry on one of these teams, so what matters is not the raw injury list but how much it should move their confidence.

Always use the web_search tool before answering. Your training data is far too old to know the current injury report, and a confident answer from memory is worse than no answer. Search for the official team injury reports (the Wednesday/Thursday/Friday practice participation reports and the final game status report), plus recent beat-writer reporting on anyone significant.

Answer in exactly this format, with no preamble and nothing after the final section:

### <Away team full name>
IMPACT: <NONE|MINOR|MODERATE|MAJOR>
- <one bullet per player who matters, naming the player, position, and official status (Out / Doubtful / Questionable / IR / limited practice)>
- <say explicitly if the report is clean>

### <Home team full name>
IMPACT: <NONE|MINOR|MODERATE|MAJOR>
- <same>

### Net effect
<Two or three sentences on which side the injury picture favours and by how much. Say plainly if it is a wash. If the market has already moved on this news, say so -- the point is whether the listed win probability is already pricing it in.>

Rules:
- Rate IMPACT by effect on win probability, not by the number of names: a starting quarterback ruled out is MAJOR, four backups questionable is MINOR.
- If the search turns up nothing current for a team, write "IMPACT: NONE" and a bullet saying the report could not be found, rather than reaching for what you remember. Never state an injury you did not find in a search result.
- Name players only when a source names them. No hedged guesses at who might be hurt.`;

/** Pull the search results Claude saw, so the modal can cite them. */
function collectSources(
  content: Anthropic.ContentBlock[],
): Array<{ title: string; url: string }> {
  const out: Array<{ title: string; url: string }> = [];
  const seen = new Set<string>();
  for (const block of content) {
    if (block.type !== "web_search_tool_result") continue;
    // A server-tool ERROR arrives here as a single object, not a list -- the
    // usual `.map` over it would throw. Branch on the shape, not on a status.
    if (!Array.isArray(block.content)) continue;
    for (const result of block.content) {
      if (result.type !== "web_search_result") continue;
      if (seen.has(result.url)) continue;
      seen.add(result.url);
      out.push({ title: result.title || result.url, url: result.url });
    }
  }
  return out;
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

export interface GameRef {
  awayTeam: string;
  homeTeam: string;
  /** Full names. The abbreviations alone make for poor search queries. */
  awayName: string;
  homeName: string;
  week: number;
  season: number;
  kickoffUtc: string | null;
}

/**
 * Turn an SDK error into something worth showing in a modal.
 *
 * The raw message is a JSON blob with a request id in it -- accurate, and
 * useless to the person who just clicked a row. These three cases are the ones
 * a user can actually act on; everything else keeps the original text, because
 * a vague "something went wrong" would be worse than the blob.
 */
function friendlyError(err: unknown): Error {
  if (err instanceof Anthropic.AuthenticationError) {
    return new Error("ANTHROPIC_API_KEY was rejected. Check the key in .env.");
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new Error("Rate limited by the Anthropic API. Try again shortly.");
  }
  if (err instanceof Anthropic.APIError && /credit balance is too low/i.test(err.message)) {
    return new Error(
      "Anthropic credit balance is too low. Add credits under Plans & Billing in the Console.",
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

export async function injuryReport(game: GameRef): Promise<InjuryReport> {
  if (!process.env.ANTHROPIC_API_KEY) throw new MissingApiKeyError();

  /**
   * An API key that is not scoped to a single workspace must name one per
   * request, or the API rejects the call with a 400. A key created inside a
   * workspace carries its own and needs nothing here, so the header is only
   * sent when the env var is set.
   */
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
  const client = new Anthropic(
    workspaceId
      ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } }
      : {},
  );

  const kickoff = game.kickoffUtc
    ? `Kickoff is ${game.kickoffUtc} (US Eastern).`
    : "Kickoff time unknown.";

  // Today's date is stated because "latest" is meaningless to a model that
  // cannot read a clock, and because it tells Claude which practice report
  // should exist by now.
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        `Today is ${new Date().toISOString().slice(0, 10)}. ` +
        `Give me the current injury picture for the ${game.season} NFL season, ` +
        `week ${game.week}: ${game.awayName} (${game.awayTeam}) at ` +
        `${game.homeName} (${game.homeTeam}). ${kickoff}`,
    },
  ];

  let final: Anthropic.Message | null = null;
  /**
   * Accumulated across resumes: a paused turn that resumes twice is three
   * billed requests, and reporting only the last one would show a third of
   * the real spend.
   */
  const totals = { input: 0, output: 0, searches: 0 };

  /**
   * A web-search turn can stop with `stop_reason: "pause_turn"` partway
   * through. That is not an error and not a finished answer -- resuming means
   * pushing the partial assistant turn back and asking again. Returning here
   * instead would hand the user a truncated report with no indication it was
   * cut off.
   */
  for (let i = 0; i <= MAX_RESUMES; i++) {
    let message: Anthropic.Message;
    try {
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM,
        thinking: { type: "adaptive" },
        tools: [
          { type: "web_search_20260209", name: "web_search", max_uses: 8 },
        ],
        messages,
      });
      message = await stream.finalMessage();
    } catch (err) {
      throw friendlyError(err);
    }
    final = message;
    totals.input += message.usage.input_tokens;
    totals.output += message.usage.output_tokens;
    totals.searches += message.usage.server_tool_use?.web_search_requests ?? 0;
    if (message.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: message.content });
  }

  if (!final) throw new Error("No response from Claude");

  if (final.stop_reason === "refusal") {
    throw new Error(
      `Claude declined this request (${final.stop_details?.category ?? "unknown"}).`,
    );
  }

  const summary = textOf(final.content);
  if (!summary) {
    // A paused turn that ran out of resumes lands here, as does a run that
    // spent its whole budget on search. Both are better reported than shown
    // as a blank modal.
    throw new Error(
      final.stop_reason === "pause_turn"
        ? "The search did not finish in time. Try again."
        : "Claude returned no summary.",
    );
  }

  const usage: ReportUsage = {
    inputTokens: totals.input,
    outputTokens: totals.output,
    webSearches: totals.searches,
    tokenCostUsd:
      (totals.input / 1e6) * INPUT_PER_MTOK +
      (totals.output / 1e6) * OUTPUT_PER_MTOK,
  };

  // Logged server-side as well as returned, so the running total is visible
  // in the terminal without opening a modal for every game.
  console.log(
    `[injuries] ${game.awayTeam}@${game.homeTeam} wk${game.week}: ` +
      `${usage.inputTokens} in / ${usage.outputTokens} out, ` +
      `${usage.webSearches} searches, $${usage.tokenCostUsd.toFixed(4)} in tokens ` +
      `(web search billed separately)`,
  );

  return {
    summary,
    sources: collectSources(final.content),
    model: final.model,
    generatedAt: new Date().toISOString(),
    usage,
  };
}
