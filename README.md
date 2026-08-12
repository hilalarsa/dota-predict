# TI 2026 Predictor

A single-page Dota 2 predictor for **The International 2026** (TI15, Shanghai,
13–23 Aug 2026): power rankings, per-team hero form over the last 3 patches,
head-to-head + draft matchup forecasting, a Monte Carlo simulation of the full
event — **both the Swiss group stage and the main-event double-elimination
bracket, drawn position by position** — and an **interactive bracket builder**
where you click winners and every series shows its scoreline odds (2–0 vs 2–1,
3–0 vs 3–2). Every number carries a data-quality confidence grade.

```bash
python3 fetch.py            # pull data.json from OpenDota (~25s, no API key)
python3 -m http.server 8000 # file:// blocks fetch(), so serve the folder
open http://localhost:8000
node test_model.mjs         # model self-check (29 assertions)
```

| File | What it is |
|---|---|
| [teams.py](teams.py) | The 16 TI 2026 teams → OpenDota team ids, incl. roster-transfer mappings |
| [fetch.py](fetch.py) | Pulls match history, hero picks per patch, and the pro meta into `data.json` |
| [index.html](index.html) | The whole app — model and UI, no dependencies |
| [test_model.mjs](test_model.mjs) | Runs the model against the real data and asserts its invariants |

---

## 1. Data sources

### Used by this project

#### OpenDota — everything except the team list
**Free, no key required.** This is the backbone.

- **Base:** `https://api.opendota.com/api`
- **Key:** optional. Get one at <https://www.opendota.com/api-keys> (Steam login →
  "API Keys" → add a card). The **free tier is 50,000 calls/month**; beyond that
  it's ~$0.01 per 100 calls. Pass it as `?api_key=...`, or here:
  `OPENDOTA_KEY=xxx python3 fetch.py`.
- **Limits without a key:** measured live from the response headers —
  `x-rate-limit-remaining-minute: 59` and a per-day budget of roughly 2,000.
  `fetch.py` makes ~25 calls, so a key is unnecessary for this workload.
- **Gotcha:** it 403s Python's default `urllib` User-Agent. Send any
  identifiable UA.

Endpoints this project uses:

| Endpoint | Gives |
|---|---|
| `/teams` | Every pro team + OpenDota's maintained Elo `rating`, W/L, logo |
| `/teams/{id}/matches` | Full match history: opponent, side, result, league, timestamp |
| `/constants/patch` | Patch names and release dates — how "last 3 patches" is defined |
| `/constants/heroes` | Hero id → name |
| `/leagues/{id}/matches` | Results at a given league (TI 2026 is `leagueid=19719`) |
| **`/explorer?sql=...`** | **Read-only SQL over their entire pro-match database** |

`/explorer` is the reason this project can answer "best heroes last 3 patches"
at all: the REST hero endpoint (`/teams/{id}/heroes`) is all-time only, with no
date filter. With SQL you get `picks_bans ⋈ matches ⋈ team_match` and can slice
by patch window. Tables: `matches`, `player_matches`, `picks_bans`, `team_match`,
`teams`, `leagues`, `heroes`, `notable_players`.

```bash
# every hero Team Falcons picked since patch 7.39, with wins, by patch
curl -sG https://api.opendota.com/api/explorer --data-urlencode "sql=
  select pb.hero_id, count(*) g,
         sum(case when (pb.team=0)=m.radiant_win then 1 else 0 end) w
  from picks_bans pb
  join matches m on m.match_id = pb.match_id
  join team_match tm on tm.match_id = m.match_id
  where pb.is_pick and tm.team_id = 9247354
    and ((pb.team=0 and tm.radiant) or (pb.team=1 and not tm.radiant))
    and m.start_time > 1747957000
  group by 1 order by g desc limit 10"
```

#### Liquipedia — the participant list and the format
**Free, no key.** The authoritative source for who is actually at TI and how the
bracket is shaped. Used once, by hand, to build [teams.py](teams.py).

- **Endpoint:** `https://liquipedia.net/dota2/api.php?action=parse&page=The_International/2026&prop=wikitext&format=json`
- **Two hard requirements**, or you get 403/406: a descriptive `User-Agent`
  including contact info, and `Accept-Encoding: gzip`.
- **Limits:** 1 request / 2s on `action=parse`, 1 / 30s on the LPDB API. Cache
  aggressively — this is a volunteer-run wiki. Terms: <https://liquipedia.net/api-terms-of-use>

```bash
curl -s --compressed -A "yourapp/1.0 (you@example.com)" \
  "https://liquipedia.net/dota2/api.php?action=parse&page=The_International/2026&prop=wikitext&format=json"
```

### Free alternatives worth knowing

#### STRATZ — the best draft/hero data, GraphQL
Free, **requires a token**. Deeper than OpenDota on drafts specifically: pick
order, ban phase, hero-vs-hero matchup winrates, and per-position hero stats —
all things this model currently approximates.

- **Get a token:** <https://stratz.com/api> → sign in with Steam → "My Tokens".
- **Endpoint:** `https://api.stratz.com/graphql`, header
  `Authorization: Bearer <token>`.
- **Limits (free/individual token):** 20/sec, 250/min, 4,000/hour, 20,000/day.
- **Note:** requires `User-Agent: STRATZ_API` on some routes.

#### Steam Web API — the official one
Free, **requires a key** (any Steam account with a phone number attached).

- **Get a key:** <https://steamcommunity.com/dev/apikey>
- **Base:** `https://api.steampowered.com/IDOTA2Match_570/`
- Useful: `GetLiveLeagueGames` (live scoreboards and drafts — nothing else has
  this), `GetMatchHistory`, `GetMatchDetails`, `GetTeamInfoByTeamID`.
- Thin on aggregates: no winrates, no per-patch stats. Best as a live feed to
  layer on top of OpenDota.

#### PandaScore — schedules, odds, live
Commercial with a free developer tier (signup at <https://pandascore.co>,
token via `Authorization: Bearer`). Strong on *upcoming* match schedules and
betting odds, which none of the above provide. Verify current free-tier limits
at signup — they change.

#### Others
- **Valve's own TI site**, `https://www.dota2.com/esports/ti15` — has a live
  bracket JSON behind it, undocumented and prone to change mid-event.
- **Dotabuff** and **Datdota** — no public API. Scraping violates their ToS.
- **GosuGamers / BLAST.tv** — news and brackets, human-readable only.

---

## 2. The model

Everything is derived at page load from `data.json`; all tunable constants sit
in the `CFG` object at the top of the `<script>` in [index.html](index.html).

### Team rating
Seeded from OpenDota's maintained pro Elo, then a **time-decayed form pass**
over every pro match in the last 18 months — K halves every 240 days, so recent
results dominate while older ones still count.

Four TI teams are **transferred rosters** whose history lives under a different
`team_id`. Reading the current id alone gives a 15-game sample:

| At TI | Real history under | Same players? |
|---|---|---|
| 1w Team | Tundra Esports | yes — merged, no penalty |
| LGD Gaming | HEROIC | yes — merged, no penalty |
| TEAM VISION | PARIVISION (same id) | yes |
| Nigma Galaxy | two ids, org re-registered | yes — merged |
| OG | the older EU OG | **no** — new Filipino roster, flagged |
| BetBoom Team | plays as "BoomBoys" at TI | yes |

That distinction matters: an org rename is not a roster break, but a change of
*players* is, and only the latter widens the model's uncertainty.

### Match probability
Each team carries a **σ** (rating uncertainty), widened by a thin recent sample,
a thin overall history, or a real roster change. A Glicko *g*-factor uses it to
pull that team's predictions toward 50/50 — so HULIGANI's 21 games never produce
a confident number.

```
p = 1 / (1 + 10^(-g·(Ra − Rb + draft)/400))
g = 1 / √(1 + 3q²(σa² + σb²)/π²),   q = ln10/400
```

Then a **head-to-head residual**: only the part of the H2H record that the
ratings don't already explain, recency-weighted (300-day half-life), shrunk by
sample size, and capped at ±7 points. Series: Bo3 = p²(3−2p),
Bo5 = p³(6p²−15p+10).

### Draft
Per hero on a side: 55% "how far above its own baseline does *this team* play
this hero" + 45% "how strong is the hero in the current pro meta". Newer patches
weighted 1:2:3. Team winrates shrunk toward the team baseline with 8
pseudo-games, meta winrates toward 50% with 40 — so a 2-game 100% doesn't move
anything. Total draft effect capped at **±150 Elo**: a draft tilts a game, it
doesn't decide one.

### Confidence score
Deliberately measures **data quality, not how lopsided the call is**. A 50/50
between two well-documented teams is a high-confidence 50/50; a 90/10 built on
20 games is not. Inputs: recent and total sample size, staleness, roster
continuity, and hero-sample depth when a draft is entered. Graded A ≥78 · B ≥62 ·
C ≥44 · D below, ceilinged at 95.

### Bracket simulation
20,000 Monte Carlo runs of the real TI 2026 format (per Liquipedia):

- **Swiss-16**, 5 rounds, all Bo3, score-group pairing with rematch avoidance
- Top 3 → straight to the Main Event; seeds 4–13 → elimination round (4v13,
  5v12, 6v11, 7v10, 8v9) where 5 advance; bottom 3 out
- **Main Event:** 8-team double elimination, Bo3, Bo5 grand final

Each run **redraws every team's rating from its own σ**, so roster and sample
uncertainty propagates into the final championship odds rather than being
reported next to them. The ± shown on the champion column is Monte-Carlo noise
(95%, from 10 independent batches), not model error.

### Reading the two bracket views

**Group stage.** A Swiss stage has no fixed tree — round 3's pairings depend on
rounds 1–2 — so drawing one is a lie. Instead: teams ordered by average seed,
with the two real cut lines (after 3rd, after 13th), P(top 3), P(eliminated),
and a heatmap of the full final-record distribution from 5–0 to 0–5. Then the
elimination round, whose pairings *are* fixed by seed (4v13 … 8v9), showing who
is most likely to land on each side.

**Main event.** The actual double-elimination tree — UB semifinals → UB final,
LB rounds 1–2 → LB semifinal → LB final, grand final, champion. **Every slot is
a distribution, not a name.** With a field this tight the upper-bracket final's
top seat is a 22 / 19 / 14% three-way answer, so each box lists its three most
likely occupants plus the combined tail. A box showing "+13 others 45%" is
telling you something true: that slot is genuinely wide open.

Both stages are driven by the same 20,000 runs as the summary table — the
simulation always walked these positions, it just used to discard them.

### Bracket builder (interactive)

The forecast above answers "what does the model think". The **Bracket builder**
answers "what if I think X" — a pick'em over the same 10-match main-event tree.

- Set the eight main-event seeds (defaults to the top 8 by rating; picking a
  team already seeded elsewhere swaps the two, so all eight stay distinct).
- **Click any team to advance it.** Downstream matchups recompute immediately —
  the double-elimination `lose` edges mean beating a team in the upper bracket
  also changes who *drops* into lower-bracket round 2. Picks that are no longer
  valid are voided rather than left stale.
- **Auto-pick favourites** fills the whole bracket with the model's choice (this
  is the state the section opens in); **Clear picks** empties it.

Each series shows its win probability *and its full scoreline distribution* —
`2–0 / 2–1 / 1–2 / 0–2` for Bo3, `3–0 / 3–1 / 3–2 / 2–3 / 1–3 / 0–3` for the Bo5
grand final:

```
P(A wins 2–0) = p²        P(A wins 3–0) = p³
P(A wins 2–1) = 2p²q      P(A wins 3–1) = 3p³q
                          P(A wins 3–2) = 6p³q²
```

Segments run decisive → close → close → decisive, blue for the top team and red
for the bottom, so the middle of the bar is the "goes the distance" region.
**These assume maps are independent at a constant p** — real series have
momentum, draft adaptation and side-selection effects, so treat sweep
probabilities as a touch optimistic.

Looking for Swiss records (5–0, 4–1, …)? Those are in the group-stage heatmap
above — Swiss pairings aren't fixed, so they can't be drawn as a tree.

---

## 3. Known limits

- No player-level modelling, no stand-in detection, no LAN-vs-online split.
- Team form is not patch-specific — the rating pass decays by time, not by patch.
- Hero edges are **pick winrates**, not draft-order or ban-phase modelling.
  STRATZ has the data to fix this.
- The rating pass re-walks matches OpenDota's own Elo already counted, so it is
  a form adjustment on top of a global baseline, not a clean-room Elo.
- Non-TI opponents are seeded from OpenDota's rating and only updated on games
  against the TI pool.
- Swiss pairing models score-group pairing with rematch avoidance; Valve's exact
  seeding rules may differ, as may Main Event seeding.
- Re-run `python3 fetch.py` during the event — once TI matches are played they
  enter the teams' match history and flow into the ratings automatically.
