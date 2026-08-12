// Smallest thing that fails if the model breaks. Loads the model half of
// index.html (everything above the rendering section) against the real
// data.json and asserts the invariants that actually matter.
//
//   node test_model.mjs
import { readFileSync } from 'fs';
import assert from 'assert';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
new Function(script);   // compile-only: catches syntax errors in the render half too

const body = script.slice(script.indexOf('const CFG'), script.indexOf('// rendering'));
const model = body.slice(0, body.lastIndexOf('// ---'));

const D0 = JSON.parse(readFileSync(new URL('./data.json', import.meta.url), 'utf8'));
const ctx = new Function('DATA', `
  const document = { querySelector: () => ({ append(){}, replaceChildren(){}, set textContent(_){}, set innerHTML(_){}, style:{} }) };
  const fetch = () => ({ then: () => ({ then: () => ({ catch: () => {} }) }) });
  ${model}
  D = DATA; build();
  return { T, CFG, predict, pGame, bo3, bo5, heroEdge, runSims, confidence, h2h, PATCHES, HEROES,
           BRACKET, BY_ID, boWin, seriesDist };
`)(D0);

const { T, predict, bo3, bo5, heroEdge, runSims, PATCHES, HEROES,
        BRACKET, BY_ID, boWin, seriesDist } = ctx;
const by = n => T.find(t => t.name === n);
let checks = 0;
const ok = (label, cond) => { assert.ok(cond, label); checks++; };

// --- ratings
ok('16 teams built', T.length === 16);
ok('ratings are sane Elo numbers', T.every(t => t.rating > 800 && t.rating < 2200));
ok('ratings sorted desc', T.every((t, i) => i === 0 || T[i - 1].rating >= t.rating));
ok('merged rosters keep their history', by('1w Team').n > 300 && by('LGD Gaming').n > 300);
ok('thin/new orgs get wider sigma than established ones',
  by('HULIGANI').sigma > by('Team Falcons').sigma);
ok('an org rename is not a roster break', !by('Nigma Galaxy').rosterBreak && !by('1w Team').rosterBreak);
ok('a real player change is a roster break', by('OG').rosterBreak && by('OG').sigma > by('Team Liquid').sigma);
ok('confidence is ceilinged below certainty', T.every(t => ctx.confidence(t) <= 95));

// --- probabilities
const [a, b] = [T[0], T[15]];
const p = predict(a, b).p, pr = predict(b, a).p;
ok('win probs are complementary', Math.abs(p + pr - 1) < 0.02);
ok('better rating favoured', p > 0.5);
ok('probability bounded', T.every(x => T.every(y => x === y || (predict(x, y).p > 0 && predict(x, y).p < 1))));
ok('self-match is a coin flip', Math.abs(predict(T[3], T[3]).p - 0.5) < 1e-9);
ok('bo3 amplifies a map edge', bo3(0.6) > 0.6 && bo5(0.6) > bo3(0.6));
ok('bo3/bo5 fixed at 0.5', Math.abs(bo3(0.5) - 0.5) < 1e-12 && Math.abs(bo5(0.5) - 0.5) < 1e-12);

// --- H2H residual is capped
for (const x of T) for (const y of T) if (x !== y) {
  const r = predict(x, y);
  assert.ok(Math.abs(r.h2hAdj) <= ctx.CFG.h2hMaxSwing + 1e-9, `h2h cap ${x.name}/${y.name}`);
}
checks++;

// --- draft
const heroIds = Object.keys(HEROES).map(Number);
const strong = heroIds.map(h => heroEdge(a, h)).filter(h => h.raw >= 10).sort((x, y) => y.edge - x.edge);
ok('team has hero data across the last 3 patches', strong.length > 5 && PATCHES.length === 3);
const withDraft = predict(a, b, strong.slice(0, 5).map(h => h.heroId), []);
ok('a favourable draft helps', withDraft.p > predict(a, b).p);
ok('draft effect is capped', Math.abs(withDraft.eloAdj) <= ctx.CFG.draftMaxElo + 1e-9);
ok('empty draft is a no-op', predict(a, b, [], []).p === predict(a, b).p);

// --- confidence measures data quality, not lopsidedness
ok('thin-data team is less confident', ctx.confidence(by('HULIGANI')) < ctx.confidence(by('Team Falcons')));

// --- bracket simulation
const sim = runSims(3000);
const res = sim.teams;
const sum = k => res.reduce((s, r) => s + r[k], 0);
ok('exactly one champion per run', Math.abs(sum('champ') - 1) < 1e-9);
ok('3 teams take the Swiss top 3', Math.abs(sum('swiss3') - 3) < 1e-9);
ok('8 teams reach the Main Event', Math.abs(sum('main') - 8) < 1e-9);
ok('4 teams reach the top 4', Math.abs(sum('top4') - 4) < 1e-9);
ok('3 teams are cut in the Swiss', Math.abs(sum('out') - 3) < 1e-9);
ok('champion implies Main Event', res.every(r => r.champ <= r.main + 1e-9));
ok('champion implies top 4', res.every(r => r.champ <= r.top4 + 1e-9));
ok('mean Swiss record fits the round count', res.every(r => r.swissWins >= 0 && r.swissWins <= ctx.CFG.swissRounds));
ok('favourite is more likely champion than the bottom seed',
  res.find(r => r.t === T[0]).champ > res.find(r => r.t === T[15]).champ);

// --- bracket slots: every position is occupied by exactly one team per run
for (const [name, arr] of Object.entries(sim.slots)) {
  assert.ok(Math.abs(arr.reduce((s, c) => s + c, 0) / sim.n - 1) < 1e-9, `slot ${name} filled exactly once`);
}
checks++;
ok('every rendered slot exists',
  ['S1', 'S4', 'S5', 'S8', 'ubfA', 'ubfB', 'lbr2A1', 'lbr2A2', 'lbr2B1', 'lbr2B2',
    'lbsfA', 'lbsfB', 'lbfA', 'lbfB', 'gfA', 'gfB'].every(k => sim.slots[k]));
ok('main-event seed 1 is the Swiss seed 1',
  T.every((t, i) => Math.abs(sim.slots.S1[i] / sim.n - sim.swissSeed[i][0]) < 1e-9));
ok('each Swiss seed is taken by exactly one team',
  sim.swissSeed[0].every((_, k) => Math.abs(sim.swissSeed.reduce((s, r) => s + r[k], 0) - 1) < 1e-9));
ok('each team lands on exactly one seed',
  sim.swissSeed.every(r => Math.abs(r.reduce((s, c) => s + c, 0) - 1) < 1e-9));
ok('record distribution sums to 1 per team',
  sim.swissRec.every(r => Math.abs(r.reduce((s, c) => s + c, 0) - 1) < 1e-9));
ok('record distribution agrees with the mean-wins tally', res.every(r => {
  const i = T.indexOf(r.t);
  return Math.abs(sim.swissRec[i].reduce((s, c, w) => s + c * w, 0) - r.swissWins) < 1e-9;
}));
ok('you cannot win TI without reaching the grand final',
  T.every((t, i) => res.find(r => r.t === t).champ <= (sim.slots.gfA[i] + sim.slots.gfB[i]) / sim.n + 1e-9));

// --- scoreline distributions
for (const bo of [3, 5]) for (const p of [0.5, 0.62, 0.87, 0.13, 0.02, 0.98]) {
  const d = seriesDist(p, bo);
  const tot = d.reduce((s, x) => s + x.p, 0);
  assert.ok(Math.abs(tot - 1) < 1e-12, `Bo${bo} p=${p} scorelines sum to 1 (got ${tot})`);
  assert.ok(d.every(x => x.p >= 0), `Bo${bo} p=${p} no negative scoreline`);
  const aWins = d.filter(x => x.c[0] === 'a').reduce((s, x) => s + x.p, 0);
  assert.ok(Math.abs(aWins - boWin(p, bo)) < 1e-12, `Bo${bo} p=${p} A-scorelines equal the series win prob`);
}
checks += 3;
ok('Bo3 has 4 possible scorelines, Bo5 has 6', seriesDist(0.5, 3).length === 4 && seriesDist(0.5, 5).length === 6);
ok('a 50/50 Bo5 is symmetric', (() => {
  const d = seriesDist(0.5, 5);
  return d.every((x, k) => Math.abs(x.p - d[d.length - 1 - k].p) < 1e-12);
})());
ok('a stronger team sweeps more often', seriesDist(0.8, 5)[0].p > seriesDist(0.6, 5)[0].p);
ok('scoreline labels match the format', seriesDist(0.5, 3).map(x => x.l).join() === '2–0,2–1,1–2,0–2'
  && seriesDist(0.5, 5).map(x => x.l).join() === '3–0,3–1,3–2,2–3,1–3,0–3');

// --- bracket topology: it must describe the same event the simulation runs
ok('10 main-event matches', BRACKET.length === 10);
ok('grand final is the only Bo5', BRACKET.filter(m => m.bo === 5).map(m => m.id).join() === 'gf');
ok('all 8 seeds enter exactly once', (() => {
  const seen = BRACKET.flatMap(m => [m.a, m.b]).filter(r => r.seed !== undefined).map(r => r.seed).sort();
  return seen.join() === '0,1,2,3,4,5,6,7';
})());
ok('every reference resolves to a real earlier match', BRACKET.every((m, k) =>
  [m.a, m.b].every(r => r.seed !== undefined ||
    BRACKET.findIndex(x => x.id === (r.win ?? r.lose)) < k)));
ok('both UB semifinal losers drop into the lower bracket',
  ['ubsf1', 'ubsf2'].every(id => BRACKET.some(m => m.a.lose === id || m.b.lose === id)));
ok('the UB final loser gets a second life in the LB final',
  BY_ID.lbf.b.lose === 'ubf');
ok('every match except the final feeds something', BRACKET.slice(0, -1).every(m =>
  BRACKET.some(x => [x.a, x.b].some(r => (r.win ?? r.lose) === m.id))));

console.log(`OK — ${checks} checks passed`);
console.log('\nchampion odds:');
res.slice().sort((x, y) => y.champ - x.champ).forEach(r =>
  console.log(`  ${r.t.name.padEnd(18)} ${(100 * r.champ).toFixed(1).padStart(5)}%   main ${(100 * r.main).toFixed(0).padStart(3)}%   elo ${Math.round(r.t.rating)} ±${Math.round(r.t.sigma)}`));
