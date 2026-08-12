"""TI 2026 participants -> OpenDota team ids.

Source: https://liquipedia.net/dota2/The_International/2026 (Participants section).

`ids` is ordered [current, ...predecessor rosters]. Several TI teams are
transferred rosters whose competitive history lives under a different
team_id -- reading only the current id would give a ~15-game sample.

`roster_break` is the separate question, and the one the model cares about:
did the *players* change, so that the merged history no longer describes the
team playing at TI? An org rename or a re-registered team_id is not a break.
"""

TI2026 = [
    # name,              ids,                     qual,     break, note
    ("Team Falcons",     [9247354],               "invite", False, None),
    ("Team Liquid",      [2163],                  "invite", False, None),
    ("1w Team",          [10182357, 8291895],     "invite", False, "Tundra Esports roster transferred to 1w Team (2026-06-01); history merged from Tundra."),
    ("Aurora Gaming",    [9467224, 9255706],      "invite", False, None),
    ("Team Yandex",      [9823272],               "invite", False, None),
    ("BetBoom Team",     [8255888],               "invite", False, "Competes at TI as 'BoomBoys' (Valve gambling-sponsor rule)."),
    ("Xtreme Gaming",    [8261500],               "invite", False, None),
    ("Team Spirit",      [7119388],               "qual",   False, None),
    ("TEAM VISION",      [9572001],               "qual",   False, "PARIVISION competing as TEAM VISION; same roster and team_id."),
    ("Nigma Galaxy",     [10136357, 7554697],     "qual",   False, "Two OpenDota ids (org re-registered); history merged."),
    ("HULIGANI",         [10149530],              "qual",   False, "New org with a short match history -> wide uncertainty."),
    ("GamerLegion",      [9964962],               "qual",   False, None),
    ("Vici Gaming",      [726228],                "qual",   False, None),
    ("Team Resilience",  [5017210],               "qual",   False, "Thin recent history -> wide uncertainty."),
    ("OG",               [2586976],               "qual",   True,  "All-Filipino roster under the OG banner; the team_id history is the older EU OG, so prior form describes different players."),
    ("LGD Gaming",       [10150538, 9303484],     "qual",   False, "Ex-HEROIC roster now under LGD Gaming; history merged from HEROIC."),
]

LEAGUE_ID = 19719  # The International 2026 (OpenDota / Valve leagueid)
