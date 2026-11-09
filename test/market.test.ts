import { test } from "node:test";
import assert from "node:assert/strict";
import { blend, parseMarket, parseScores } from "../src/market";
import { resolveEntry, upsertEntry } from "../src/record";
import { buildFromInputs, findSurprise } from "../src/pipeline";
import type { QuinielaResult, Record_, Result } from "../src/types";

const row = (n: number, a: number, x: number, b: number) => ({ orden: n, numero: n, porc_1: a, porc_X: x, porc_2: b });
function stateHtml(j: number) {
  const partidos = {
    real: [row(1, 50, 27, 23), row(2, 0, 0, 0), { numero: 15, porc_15L_0: 15, porc_15L_1: 28, porc_15L_2: 27, porc_15L_M: 30, porc_15V_0: 39, porc_15V_1: 37, porc_15V_2: 17, porc_15V_M: 7 }],
    lae: [row(1, 62, 20, 18), row(2, 100, 0, 0)],
    quinielista: [row(1, 84, 10, 6)],
  };
  const st = {
    datosGeneralesQuiniela: { jornada: j, fechaFinApuestas: 1800000000, ultimaJornadaEscrutada: { jornada: j - 1 } },
    [`probabilidades_${j}_2027`]: { numTemporada: "2027", numJornada: String(j), partidos },
  };
  return `<script id="eduardo-losilla-state" type="application/json">${JSON.stringify(st).replace(/"/g, "&q;")}</script>`;
}

test("parseMarket lee cuotas, % apostado y Pleno al 15, y descarta filas vacías", () => {
  const m = parseMarket(stateHtml(21), 21)!;
  assert.equal(m.jornada, 21);
  assert.ok(Math.abs(m.real[1].p1 - 0.5) < 1e-9);
  assert.equal(m.real[2], undefined); // todo ceros
  assert.equal(m.lae[2], undefined); // 100-0-0 no es un dato real
  assert.ok(Math.abs(m.lae[1].p1 - 0.62) < 1e-9);
  assert.ok(Math.abs(m.pleno.real!.h[3] - 0.3) < 1e-9);
  assert.equal(m.escrutada, 20);
  assert.equal(m.closing, 1800000000000);
  assert.equal(parseMarket(stateHtml(21), 22), null); // otra jornada
  assert.equal(parseMarket("<html></html>", 21), null);
});

test("parseScores lee los marcadores del escrutinio", () => {
  const p = (n: number, sc: string) => `<span aria-label="Partido número ${n}">${n}</span><div class="c-marcador-horario__match__score ng" id="x"> ${sc} </div>`;
  const html = p(1, "1-2") + p(2, "1-1") + `<span aria-label="Partido número 3">3</span><div class="c-marcador-horario__time">SAB</div>` + p(15, "3-0");
  assert.deepEqual(parseScores(html), { 1: [1, 2], 2: [1, 1], 15: [3, 0] });
});

test("blend mezcla y suma 1; sin cuotas devuelve el modelo", () => {
  const m = { p1: 0.4, px: 0.3, p2: 0.3 }, k = { p1: 0.6, px: 0.2, p2: 0.2 };
  const b = blend(m, k, 0.85);
  assert.ok(Math.abs(b.p1 + b.px + b.p2 - 1) < 1e-9);
  assert.ok(Math.abs(b.p1 - 0.57) < 1e-9);
  assert.deepEqual(blend(m, undefined, 0.85), m);
});

test("sorpresas con el % real apostado: vale el signo que la gente juega poco", () => {
  const s = findSurprise({ p1: 0.5, px: 0.27, p2: 0.23 }, "1", { p1: 0.62, px: 0.2, p2: 0.18 });
  assert.equal(s?.sign, "X");
  // si la gente ya juega mucho la X, no es sorpresa
  assert.equal(findSurprise({ p1: 0.5, px: 0.27, p2: 0.23 }, "1", { p1: 0.4, px: 0.35, p2: 0.25 }), undefined);
});

test("marcador: guarda el boleto antes del cierre y cuenta aciertos", () => {
  const r = { num: 21, closing: 2000, ticketSafe: { signs: Array(14).fill("1") }, ticketValue: { signs: Array(14).fill("X") }, pleno15: { homeGoals: "M", awayGoals: "0" } } as unknown as QuinielaResult;
  let rec: Record_ = { entries: [] };
  rec = upsertEntry(rec, r, 1000);
  assert.equal(rec.entries.length, 1);
  assert.equal(rec.entries[0].pleno, "M-0");
  // tras el cierre no se cambia
  const r2 = { ...r, ticketSafe: { signs: Array(14).fill("2") } } as unknown as QuinielaResult;
  assert.deepEqual(upsertEntry(rec, r2, 3000), rec);
  assert.equal(upsertEntry(rec, r2, 1500).entries[0].safe[0], "2");
  const scores: Record<number, [number, number]> = { 15: [4, 0] };
  for (let n = 1; n <= 14; n++) scores[n] = n <= 9 ? [2, 0] : n <= 12 ? [1, 1] : [0, 1];
  const done = resolveEntry(rec.entries[0], scores);
  assert.equal(done.hitsSafe, 9);
  assert.equal(done.hitsValue, 3);
  assert.equal(done.played, 14);
  assert.equal(done.score15, "M-0");
  assert.equal(done.plenoHit, true);
  // una jornada ya resuelta no se pisa
  rec = { entries: [done] };
  assert.deepEqual(upsertEntry(rec, r2, 1500), rec);
});

test("con cuotas, un partido sin estadísticas propias (femenino) tiene pronóstico real", () => {
  const results: Result[] = [];
  const teams = ["A", "B", "C", "D"];
  let round = 1;
  for (let k = 0; k < 6; k++) for (const [h, a] of [["A", "B"], ["C", "D"], ["A", "C"], ["B", "D"]]) results.push({ league: "laliga", round: round++, home: h, away: a, hg: 2, ag: 1 });
  void teams;
  const matches = Array.from({ length: 14 }, (_, i) => ({ n: i + 1, home: i === 0 ? "A" : `X${i} (F)`, away: i === 0 ? "B" : `Y${i} (F)` }));
  const real: Record<number, { p1: number; px: number; p2: number }> = { 1: { p1: 0.2, px: 0.2, p2: 0.6 }, 2: { p1: 0.2, px: 0.25, p2: 0.55 } };
  const { result } = buildFromInputs({
    jornada: { name: "Jornada 5", num: 5, matches, pleno15: { home: "ESPAÑA", away: "ITALIA" },
      market: { jornada: 5, temporada: 2027, real, lae: { 2: { p1: 0.5, px: 0.3, p2: 0.2 } }, quinielista: {}, pleno: { real: { h: [0.1, 0.2, 0.3, 0.4], a: [0.5, 0.3, 0.1, 0.1] } }, escrutada: 4, closing: 0 } },
    results, players: [], absences: [], headlines: {},
  });
  const [m1, m2, m3] = result.matches;
  assert.equal(m1.covered, true);
  assert.equal(m1.pick, "2"); // mandan las cuotas aunque el modelo vea favorito al local
  assert.equal(m1.source, "modelo+cuotas");
  assert.equal(m2.covered, false);
  assert.equal(m2.priced, true);
  assert.equal(m2.pick, "2");
  assert.equal(m2.publicSrc, "lae");
  assert.equal(m3.priced, false); // sin cuotas ni datos: genérico
  assert.equal(result.pleno15.homeGoals, "M");
  assert.equal(result.pleno15.awayGoals, "0");
  assert.equal(result.ticketSafe.signs.length, 14);
  for (const m of result.matches) assert.equal(m.probs.p1 + m.probs.px + m.probs.p2, 100);
});
