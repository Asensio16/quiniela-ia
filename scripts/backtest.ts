// Backtest: para cada jornada r, ajusta el modelo solo con las jornadas < r y predice la r.
// Uso:  npm run backtest        (resultado con los parámetros por defecto)
//       npm run tune            (busca los mejores parámetros)
import { fetchResults } from "../src/data";
import { DEFAULT_PARAMS, fitLeague, predictMatch, chooseSigns, signOf, type Params } from "../src/engine";
import type { Result } from "../src/types";

const MIN = Number(process.argv.find((a) => a.startsWith('--min='))?.slice(6) ?? 5);
const WITH_PREV = !process.argv.includes("--no-prev");
const results = await fetchResults(WITH_PREV);

type Score = { n: number; hits: number; hitsDouble: number; logloss: number; brier: number; fixed: number; fixedHits: number };

function run(params: Params, minRound = MIN): Score {
  const s: Score = { n: 0, hits: 0, hitsDouble: 0, logloss: 0, brier: 0, fixed: 0, fixedHits: 0 };
  for (const league of ["laliga", "laliga2"] as const) {
    const rs = results.filter((r) => r.league === league);
    const maxRound = Math.max(...rs.map((r) => r.round));
    for (let round = minRound; round <= maxRound; round++) {
      const train = rs.filter((r) => r.round < round);
      const test = rs.filter((r) => r.round === round);
      if (!test.length) continue;
      const model = fitLeague(train, params);
      for (const m of test) {
        const pr = predictMatch(model, m.home, m.away);
        if (!pr) continue;
        const real = signOf(m.hg, m.ag);
        const { pick, alt, advice } = chooseSigns(pr.probs);
        const p = real === "1" ? pr.probs.p1 : real === "X" ? pr.probs.px : pr.probs.p2;
        s.n++;
        s.logloss += -Math.log(Math.max(p, 1e-6));
        s.brier += (pr.probs.p1 - +(real === "1")) ** 2 + (pr.probs.px - +(real === "X")) ** 2 + (pr.probs.p2 - +(real === "2")) ** 2;
        if (pick === real) s.hits++;
        if (pick === real || alt === real) s.hitsDouble++;
        if (advice === "fijo") { s.fixed++; if (pick === real) s.fixedHits++; }
      }
    }
  }
  return s;
}

function baseline(minRound = 5) {
  let n = 0, home = 0, nll = 0;
  for (const league of ["laliga", "laliga2"] as const) {
    const rs = results.filter((r) => r.league === league);
    const maxRound = Math.max(...rs.map((r) => r.round));
    for (let round = minRound; round <= maxRound; round++) {
      const train = rs.filter((r) => r.round < round && r.round >= 1);
      const f = { "1": 0, X: 0, "2": 0 };
      for (const r of train) f[signOf(r.hg, r.ag)]++;
      const tot = train.length || 1;
      for (const m of rs.filter((r) => r.round === round)) {
        n++;
        const real = signOf(m.hg, m.ag);
        if (real === "1") home++;
        nll += -Math.log(Math.max(f[real] / tot, 1e-6));
      }
    }
  }
  return { n, homeAcc: home / n, logloss: nll / n };
}

const fmt = (s: Score) =>
  `n=${s.n}  acierto=${((100 * s.hits) / s.n).toFixed(1)}%  con dobles=${((100 * s.hitsDouble) / s.n).toFixed(1)}%  ` +
  `fijos=${s.fixed} (${s.fixed ? ((100 * s.fixedHits) / s.fixed).toFixed(1) : "-"}%)  logloss=${(s.logloss / s.n).toFixed(4)}  brier=${(s.brier / s.n).toFixed(4)}`;

const b = baseline(MIN);
console.log(`Partidos: ${results.length} (jornadas ≥${MIN} evaluadas: ${b.n})`);
console.log(`Referencia "siempre 1": ${(100 * b.homeAcc).toFixed(1)}%   · frecuencias históricas logloss=${b.logloss.toFixed(4)}`);

if (process.argv.includes("--tune")) {
  const rows: { p: Params; s: Score }[] = [];
  for (const halfLife of [6, 12, 20, 40, Infinity])
    for (const prior of [2, 4, 8])
      for (const rho of [0, -0.08, -0.15])
        rows.push({ p: { ...DEFAULT_PARAMS, halfLife, prior, rho }, s: run({ ...DEFAULT_PARAMS, halfLife, prior, rho }) });
  rows.sort((a, b) => a.s.logloss - b.s.logloss);
  for (const r of rows.slice(0, 8)) console.log(JSON.stringify(r.p), fmt(r.s));
  console.log("… peor:", JSON.stringify(rows.at(-1)!.p), fmt(rows.at(-1)!.s));
} else {
  console.log("Modelo (parámetros por defecto):", fmt(run(DEFAULT_PARAMS)));
}
