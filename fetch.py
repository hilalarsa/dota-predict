#!/usr/bin/env python3
"""Fetch everything the TI 2026 predictor needs from OpenDota into data.json.

No API key required. OpenDota's free tier is 60 req/min & 2000 req/day; this
script makes ~25 requests. Set OPENDOTA_KEY to raise those limits (see README).

    python3 fetch.py

Output: data.json (a few MB) consumed by index.html.
"""
import json, os, sys, time, urllib.parse, urllib.request, gzip
from collections import defaultdict
from teams import TI2026, LEAGUE_ID

API = "https://api.opendota.com/api"
KEY = os.environ.get("OPENDOTA_KEY")
# OpenDota 403s the default urllib UA; anything identifiable works.
UA = "dota-predict/1.0 (+https://github.com/local/dota-predict)"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.json")

N_PATCHES = 3          # "last 3 patches", per the brief
FORM_WINDOW_DAYS = 540 # match history pulled into the rating pass


def get(path, **params):
    if KEY:
        params["api_key"] = KEY
    url = f"{API}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "gzip"})
            with urllib.request.urlopen(req, timeout=120) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                return json.loads(raw)
        except Exception as e:
            if attempt == 3:
                raise
            wait = 2 ** attempt * 3
            print(f"  ! {e} -- retry in {wait}s", file=sys.stderr)
            time.sleep(wait)


def sql(q):
    """OpenDota Explorer: read-only SQL against their pro-match database."""
    d = get("/explorer", sql=" ".join(q.split()))
    if d.get("err"):
        raise RuntimeError(d["err"])
    return d["rows"]


def main():
    now = int(time.time())
    print("patches...")
    patches = get("/constants/patch")
    # last N patches, newest first, as (name, start_ts, end_ts)
    recent = patches[-N_PATCHES:]
    windows = []
    for i, p in enumerate(recent):
        start = int(time.mktime(time.strptime(p["date"][:19], "%Y-%m-%dT%H:%M:%S")))
        end = int(time.mktime(time.strptime(recent[i + 1]["date"][:19], "%Y-%m-%dT%H:%M:%S"))) if i + 1 < len(recent) else now
        windows.append({"name": p["name"], "start": start, "end": end})
    print("  " + ", ".join(f"{w['name']} ({time.strftime('%Y-%m-%d', time.gmtime(w['start']))})" for w in windows))
    oldest_patch = windows[0]["start"]

    print("heroes...")
    heroes = {h["id"]: h["localized_name"] for h in get("/constants/heroes").values()}

    print("pro team ratings...")
    od_teams = {t["team_id"]: t for t in get("/teams")}

    all_ids = [i for _, ids, _, _, _ in TI2026 for i in ids]
    id_to_team = {i: name for name, ids, _, _, _ in TI2026 for i in ids}

    print(f"match history for {len(all_ids)} team ids...")
    matches = {}           # match_id -> canonical record
    per_team_matches = defaultdict(list)
    cutoff = now - FORM_WINDOW_DAYS * 86400
    for tid in all_ids:
        rows = get(f"/teams/{tid}/matches") or []
        kept = 0
        for m in rows:
            if m["start_time"] < cutoff or not m.get("opposing_team_id"):
                continue
            kept += 1
            win = m["radiant_win"] == m["radiant"]
            per_team_matches[tid].append({
                "t": m["start_time"], "opp": m["opposing_team_id"],
                "opp_name": m.get("opposing_team_name"), "win": win,
                "league": m.get("league_name"), "mid": m["match_id"],
            })
            matches[m["match_id"]] = {
                "t": m["start_time"],
                "a": tid if m["radiant"] else m["opposing_team_id"],
                "b": m["opposing_team_id"] if m["radiant"] else tid,
                "a_win": m["radiant_win"],
            }
        print(f"  {id_to_team[tid]:<18} id={tid:<9} {kept:>4} matches in window")
        time.sleep(0.4)  # stay well under 60 req/min

    print("hero picks per team per patch (Explorer SQL)...")
    ids_csv = ",".join(map(str, all_ids))
    case = " ".join(f"when m.start_time >= {w['start']} and m.start_time < {w['end']} then '{w['name']}'" for w in reversed(windows))
    team_heroes = sql(f"""
        select tm.team_id, pb.hero_id, case {case} end as patch,
               count(*) as games,
               sum(case when (pb.team = 0) = m.radiant_win then 1 else 0 end) as wins
        from picks_bans pb
        join matches m on m.match_id = pb.match_id
        join team_match tm on tm.match_id = m.match_id
        where pb.is_pick
          and tm.team_id in ({ids_csv})
          and ((pb.team = 0 and tm.radiant) or (pb.team = 1 and not tm.radiant))
          and m.start_time >= {oldest_patch}
        group by 1, 2, 3
    """)
    print(f"  {len(team_heroes)} team/hero/patch rows")

    print("global pro meta per patch (Explorer SQL)...")
    meta_heroes = sql(f"""
        select case {case} end as patch, pb.hero_id,
               count(*) as games,
               sum(case when (pb.team = 0) = m.radiant_win then 1 else 0 end) as wins
        from picks_bans pb
        join matches m on m.match_id = pb.match_id
        join leagues l on l.leagueid = m.leagueid
        where pb.is_pick
          and l.tier in ('premium', 'professional')
          and m.start_time >= {oldest_patch}
        group by 1, 2
    """)
    print(f"  {len(meta_heroes)} meta rows")

    print("TI 2026 results so far (if any)...")
    try:
        ti_matches = get(f"/leagues/{LEAGUE_ID}/matches") or []
    except Exception:
        ti_matches = []
    print(f"  {len(ti_matches)} matches played at leagueid {LEAGUE_ID}")

    out = {
        "generated": now,
        "league_id": LEAGUE_ID,
        "patches": windows,
        "heroes": heroes,
        "teams": [
            {
                "name": name, "ids": ids, "qual": qual, "note": note, "roster_break": brk,
                "od": {k: od_teams.get(ids[0], {}).get(k) for k in ("rating", "wins", "losses", "logo_url", "last_match_time")},
                "matches": sorted((m for i in ids for m in per_team_matches[i]), key=lambda m: m["t"]),
            }
            for name, ids, qual, brk, note in TI2026
        ],
        # every distinct match among the pool + opponents, for the rating pass
        "match_pool": sorted(matches.values(), key=lambda m: m["t"]),
        "opponent_ratings": {str(tid): t["rating"] for tid, t in od_teams.items()},
        "opponent_names": {str(tid): t["name"] for tid, t in od_teams.items()},
        "team_heroes": [r for r in team_heroes if r["patch"]],
        "meta_heroes": [r for r in meta_heroes if r["patch"]],
        "ti_matches": [
            {"a": m.get("radiant_team_id"), "b": m.get("dire_team_id"), "a_win": m.get("radiant_win"), "t": m.get("start_time")}
            for m in ti_matches
        ],
    }
    with open(OUT, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"\nwrote {OUT} ({os.path.getsize(OUT) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
