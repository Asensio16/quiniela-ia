// Backtest con las jornadas ya jugadas de la Quiniela de esta temporada:
// compara el modelo propio, las cuotas (mercado) y la mezcla, usando en cada partido solo datos anteriores.
// Uso: npx tsx scripts/backtest-market.ts [--json]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fetchResults, fetchText, parseJornadaPage } from "../src/data";
import { fitLeague, predictMatch, signOf, type LeagueModel } from "../src/engine";
import { blend, parseMarket, parseScores, type Market } from "../src/market";
import { buildTeamIndex, resolveTeam } from "../src/names";
import { publicShare } from "../src/pipeline";
import type { League, Probs, Sign } from "../src/types";

const DIR = ".cache/el";
mkdirSync(DIR, { recursive: true });
const URL_J = "https://www.eduardolosilla.es/quiniela/ayudas/escrutinio/jornada_";

async function page(j: number): Promise<string> {
  const f = `${DIR}/j${j}.html`;
  if (existsSync(f)) return readFileSync(f, "utf8");
  const html = await fetchText(`${URL_J}${j}`);
  writeFileSync(f, html);
  return html;
}

const results = await fetchResults(true);
const cur = results.filter((r) => r.round >= 1);
const idx = buildTeamIndex([...new Set(cur.flatMap((r) => [r.home, r.away]))]);
const models = new Map<string, LeagueModel>();
const modelFor = (lg: League, round: number) => {
  const k = `${lg}:${round}`;
  if (!models.has(k)) models.set(k, fitLeague(results.filter((r) => r.league === lg && r.round < round)));
  return models.get(k)!;
};

type Row = { j: number; n: number; real: Sign; model?: Probs; market?: Probs; lae?: Probs };
const rows: Row[] = [];
const home = await page(999).catch(() => "");
void home;
const last = Number(process.argv.find((a) => a.startsWith("--last="))?.slice(7) ?? 20);
for (let j = 1; j <= last; j++) {
  let html: string;
  try { html = await page(j); } catch (e) { console.error(`J${j}: ${e}`); continue; }
  let pg; try { pg = parseJornadaPage(html); } catch { continue; }
  if (Number(pg.name.replace(/\D/g, "")) !== j) { console.error(`J${j}: la página devuelve ${pg.name}`); continue; }
  const mk: Market | null = parseMarket(html, j);
  const sc = parseScores(html);
  for (const f of pg.matches) {
    const s = sc[f.n];
    if (!s) continue;
    const row: Row = { j, n: f.n, real: signOf(s[0], s[1]), market: mk?.real[f.n], lae: mk?.lae[f.n] };
    const rh = resolveTeam(f.home, idx), ra = resolveTeam(f.away, idx);
    if (rh.ok && ra.ok) {
      const r = cur.find((x) => x.home === rh.team && x.away === ra.team);
      if (r && r.hg === s[0] && r.ag === s[1]) {
        const pr = predictMatch(modelFor(r.league, r.round), r.home, r.away);
        if (pr) row.model = pr.probs;
      }
    }
    rows.push(row);
  }
}

const key = (s: Sign) => (s === "1" ? "p1" : s === "X" ? "px" : "p2") as keyof Probs;
const best = (p: Probs): Sign => (p.p1 >= p.px && p.p1 >= p.p2 ? "1" : p.p2 >= p.px ? "2" : "X");
function score(name: string, rs: Row[], f: (r: Row) => Probs | undefined) {
  let n = 0, hit = 0, ll = 0;
  for (const r of rs) { const p = f(r); if (!p) continue; n++; if (best(p) === r.real) hit++; ll += -Math.log(Math.max(p[key(r.real)], 1e-6)); }
  console.log(`${name.padEnd(34)} n=${String(n).padStart(3)}  acierto=${(100 * hit / n).toFixed(1)}%  logloss=${(ll / n).toFixed(4)}`);
  return { n, acc: hit / n, ll: ll / n };
}

const js = [...new Set(rows.map((r) => r.j))];
console.log(`Jornadas con datos: ${js.length} (${js[0]}–${js.at(-1)}) · partidos: ${rows.length} · con cuotas: ${rows.filter((r) => r.market).length} · con modelo: ${rows.filter((r) => r.model).length}`);
const both = rows.filter((r) => r.model && r.market);
console.log("\n— Partidos con modelo y cuotas —");
score("Modelo propio", both, (r) => r.model);
score("Cuotas (mercado)", both, (r) => r.market);
for (const w of [0.3, 0.5, 0.6, 0.7, 0.8, 0.9]) score(`Mezcla (${Math.round(w * 100)}% cuotas)`, both, (r) => blend(r.model!, r.market, w));
console.log("\n— Todos los partidos con cuotas (incluye selecciones y femenino) —");
score("Cuotas (mercado)", rows.filter((r) => r.market), (r) => r.market);
score("Lo más jugado (LAE)", rows.filter((r) => r.lae), (r) => r.lae);

// ¿Se parece la estimación de "lo que juega la gente" al dato real de LAE?
let d1 = 0, d2 = 0, nn = 0;
for (const r of rows) if (r.lae && r.market) {
  const est = publicShare(r.market);
  for (const k of ["p1", "px", "p2"] as const) { d1 += Math.abs(est[k] - r.lae[k]); d2 += Math.abs(r.market[k] - r.lae[k]); nn++; }
}
console.log(`\nError medio de la estimación antigua de % apostado frente al real: ${(100 * d1 / nn).toFixed(1)} puntos (usar la probabilidad tal cual: ${(100 * d2 / nn).toFixed(1)})`);

// Simulación del boleto: aciertos por jornada del signo más probable de la mezcla
const W = Number(process.argv.find((a) => a.startsWith("--w="))?.slice(4) ?? 0.7);
const sim = js.map((j) => {
  const rs = rows.filter((r) => r.j === j);
  const hits = rs.filter((r) => { const p = r.model && r.market ? blend(r.model, r.market, W) : r.market ?? r.model; return p ? best(p) === r.real : false; }).length;
  return { j, n: rs.length, hits };
});
console.log(`\nSimulación del boleto seguro (mezcla ${W}): ${sim.map((s) => `J${s.j}:${s.hits}/${s.n}`).join(" ")}`);
const full = sim.filter((s) => s.n === 14);
console.log(`Media: ${(full.reduce((a, s) => a + s.hits, 0) / full.length).toFixed(2)} de 14 en ${full.length} jornadas completas · mejor ${Math.max(...full.map((s) => s.hits))} · peor ${Math.min(...full.map((s) => s.hits))}`);
if (process.argv.includes("--json")) writeFileSync(".cache/sim.json", JSON.stringify(sim));

// Partidos que el modelo propio no cubre: ¿qué se ganaba con las cuotas frente a jugar siempre el 1?
const un = rows.filter((r) => !r.model && r.market);
console.log(`\n— Partidos sin modelo propio (${un.length}) —`);
console.log(`Siempre "1": ${(100 * un.filter((r) => r.real === "1").length / un.length).toFixed(1)}%`);
score("Cuotas (mercado)", un, (r) => r.market);
for (const w of [0.85, 1]) score(`Mezcla (${Math.round(w * 100)}% cuotas)`, both, (r) => blend(r.model!, r.market, w));
