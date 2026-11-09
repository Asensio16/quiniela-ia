import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseSigns, fitLeague, grid1x2, plenoScore, predictMatch, scoreGrid, signOf } from "../src/engine";
import type { Result } from "../src/types";

// Liga sintética: "Fuerte" gana casi todo, "Flojo" pierde casi todo
function league(): Result[] {
  const teams = ["Fuerte", "Medio1", "Medio2", "Flojo"];
  const out: Result[] = [];
  let round = 1;
  for (let rep = 0; rep < 4; rep++)
    for (const h of teams)
      for (const a of teams) {
        if (h === a) continue;
        const sh = h === "Fuerte" ? 3 : h === "Flojo" ? 0 : 1;
        const sa = a === "Fuerte" ? 2 : a === "Flojo" ? 0 : 1;
        out.push({ league: "laliga", round: round++ % 12 + 1, home: h, away: a, hg: sh, ag: sa === 2 && sh === 3 ? 0 : sa });
      }
  return out;
}

test("la cuadrícula de marcadores suma 1 y las probabilidades 1X2 también", () => {
  const g = scoreGrid(1.6, 1.1, -0.08);
  const tot = g.p.flat().reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(tot - 1) < 1e-9);
  const p = grid1x2(g);
  assert.ok(Math.abs(p.p1 + p.px + p.p2 - 1) < 1e-9);
  assert.ok(p.p1 > p.p2); // el que más marca, más gana
});

test("el modelo ve favorito al equipo fuerte y lo penaliza fuera de casa", () => {
  const model = fitLeague(league());
  const casa = predictMatch(model, "Fuerte", "Flojo")!;
  const fuera = predictMatch(model, "Flojo", "Fuerte")!;
  assert.ok(casa.probs.p1 > 0.6, `p1=${casa.probs.p1}`);
  assert.ok(fuera.probs.p2 > fuera.probs.p1);
  assert.ok(casa.probs.p1 > fuera.probs.p2 - 0.2);
  assert.equal(predictMatch(model, "Fuerte", "Inexistente"), null);
});

test("la ventaja de casa es mayor que 1 en una liga donde gana el local", () => {
  const rs: Result[] = [];
  const t = ["A", "B", "C", "D"];
  let r = 1;
  for (const h of t) for (const a of t) if (h !== a) rs.push({ league: "laliga", round: r++, home: h, away: a, hg: 2, ag: 1 });
  const m = fitLeague(rs);
  assert.ok(m.home > 1.2);
});

test("chooseSigns: fijo, doble y triple según el reparto", () => {
  assert.equal(chooseSigns({ p1: 0.6, px: 0.22, p2: 0.18 }).advice, "fijo");
  const d = chooseSigns({ p1: 0.42, px: 0.33, p2: 0.25 });
  assert.equal(d.advice, "doble");
  assert.equal(d.pick, "1");
  assert.equal(d.alt, "X");
  assert.equal(chooseSigns({ p1: 0.36, px: 0.32, p2: 0.32 }).advice, "triple");
});

test("signOf y plenoScore", () => {
  assert.equal(signOf(2, 1), "1");
  assert.equal(signOf(1, 1), "X");
  assert.equal(signOf(0, 3), "2");
  const s = plenoScore(scoreGrid(0.4, 0.3, 0));
  assert.equal(s.h, "0");
  assert.equal(s.a, "0");
  const big = plenoScore(scoreGrid(4.5, 0.2, 0));
  assert.equal(big.h, "M");
});

test("la forma y la clasificación salen solo de la temporada actual", () => {
  const rs = league().concat([{ league: "laliga", round: -10, home: "Flojo", away: "Fuerte", hg: 5, ag: 0 }]);
  const m = fitLeague(rs);
  assert.ok(m.teams.get("Fuerte")!.pos === 1);
  assert.ok(m.teams.get("Flojo")!.pos === 4);
  assert.equal(m.teams.get("Fuerte")!.form.length, 5);
});
