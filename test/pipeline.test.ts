import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTeamIndex, resolveTeam } from "../src/names";
import { applyAi, attackFactor, buildFromInputs, findPlayer, findSurprise, publicShare, roundTo100, surpriseScore } from "../src/pipeline";
import { extractHeadlines, parseCalendar, parseJornadaPage, parseMatchScorers } from "../src/data";
import { computeForms, sameName } from "../src/form";
import { buildPrompt, sanitize, askAI } from "../src/ai";
import type { PlayerStat, Result } from "../src/types";

const idx = buildTeamIndex(["Real Madrid", "Atlético", "Athletic", "Real Sociedad", "R. Sociedad B", "Real Oviedo", "Andorra", "Celta", "Celta Fortuna", "Sporting", "Barcelona"]);

test("nombres de la Quiniela → nombres de futbolfantasy", () => {
  const ok = (raw: string) => { const r = resolveTeam(raw, idx); return r.ok ? r.team : null; };
  assert.equal(ok("R.MADRID"), "Real Madrid");
  assert.equal(ok("AT.MADRID"), "Atlético");
  assert.equal(ok("ATH.CLUB"), "Athletic");
  assert.equal(ok("R.SOCIEDAD B"), "R. Sociedad B");
  assert.equal(ok("R.SOCIEDAD"), "Real Sociedad");
  assert.equal(ok("R.OVIEDO"), "Real Oviedo");
  assert.equal(ok("ANDORRA FC"), "Andorra");
  assert.equal(ok("CELTA"), "Celta");
  assert.equal(ok("BARCELONA"), "Barcelona");
  assert.deepEqual(resolveTeam("ALAVÉS (F)", idx), { ok: false, reason: "femenino" });
  assert.deepEqual(resolveTeam("ESPAÑA", idx), { ok: false, reason: "seleccion" });
});

test("roundTo100 siempre suma 100", () => {
  for (const p of [{ p1: 0.333, px: 0.333, p2: 0.334 }, { p1: 0.555, px: 0.222, p2: 0.223 }, { p1: 0.4449, px: 0.2775, p2: 0.2776 }]) {
    const r = roundTo100(p);
    assert.equal(r.p1 + r.px + r.p2, 100);
  }
});

test("parseCalendar lee jornada y resultados terminados", () => {
  const html = `<h3>Jornada 3</h3><a href="https://x.es/partidos/1-a-g" class="partido  terminado " data-tooltip="Alavés 3-0 Getafe"></a>
    <a href="https://x.es/partidos/2" class="partido " data-tooltip="Sevilla - Rayo"></a><h3 class="x">Jornada 4</h3>
    <a href="https://x.es/partidos/3" class="partido  terminado " data-tooltip="R. Sociedad B 1-1 Celta Fortuna"></a>`;
  const rs = parseCalendar(html, "laliga2");
  assert.equal(rs.length, 2);
  assert.deepEqual(rs[0], { league: "laliga2", round: 3, home: "Alavés", away: "Getafe", hg: 3, ag: 0, url: "https://x.es/partidos/1-a-g" });
  assert.equal(rs[1].home, "R. Sociedad B");
});

test("parseJornadaPage detecta 15 partidos y el estado de cierre", () => {
  let html = "Jornada 21 ";
  for (let n = 1; n <= 15; n++)
    html += `<p class="c-equipos u-clearfix" qtitulo="" title="LOCAL${n} - VISIT${n}"> <span class="c-equipos__number" aria-label="Partido número ${n}">${n}</span></p>`;
  html += "&q;jornada&q;:21,&q;fechaFinApuestas&q;:1800000000";
  const p = parseJornadaPage(html);
  assert.equal(p.matches.length, 14);
  assert.equal(p.pleno15.home, "LOCAL15");
  assert.equal(p.state?.jornada, 21);
});

test("sorpresas: la X en un partido abierto vale más que en uno de favorito claro", () => {
  const pub = publicShare({ p1: 0.45, px: 0.3, p2: 0.25 });
  assert.ok(pub.px < 0.3); // el público juega poco la X
  const s = findSurprise({ p1: 0.45, px: 0.3, p2: 0.25 }, "1");
  assert.equal(s?.sign, "X");
  assert.equal(findSurprise({ p1: 0.8, px: 0.15, p2: 0.05 }, "1"), undefined);
  assert.ok(surpriseScore({ prob: 0.32, value: 1.4 }) > surpriseScore({ prob: 0.27, value: 1.4 }));
});

test("bajas: se casa el jugador y el ataque pierde como mucho un 12 %", () => {
  const players: PlayerStat[] = [
    { name: "Ante Budimir", team: "Osasuna", position: "Delantero", games: 12, minutes: 900, goals: 8, assists: 1 },
    { name: "Otro Jugador", team: "Osasuna", position: "Medio", games: 12, minutes: 900, goals: 1, assists: 0 },
  ];
  assert.equal(findPlayer("Budimir", "Osasuna", players)?.name, "Ante Budimir");
  const ab = [{ team: "Osasuna", player: "Ante Budimir", kind: "Lesión" as const, reason: "x", status: "Baja" }];
  const f = attackFactor("Osasuna", ab, players, 15);
  assert.ok(f < 1 && f >= 0.88);
  assert.equal(attackFactor("Osasuna", [], players, 15), 1);
});

test("IA: sanitize descarta basura y normaliza probabilidades", () => {
  const o = sanitize({ reasons: { "1": "ok", x: "no", "2": 5 }, guesses: { "10": { p1: 50, px: 30, p2: 20 }, "11": { p1: -1, px: 1, p2: 1 } }, pleno: { homeGoals: "m", awayGoals: "9" }, analysis: "hola" });
  assert.deepEqual(Object.keys(o.reasons), ["1"]);
  assert.ok(Math.abs(o.guesses[10].p1 + o.guesses[10].px + o.guesses[10].p2 - 100) < 1e-9);
  assert.equal(o.guesses[11], undefined);
  assert.equal(o.pleno?.homeGoals, "M");
  assert.equal(o.pleno?.awayGoals, undefined);
});

test("IA: sin clave no llama a nadie; con clave usa Gemini/Claude (fetch simulado)", async () => {
  const input = { jornada: "J1", matches: [], pleno15: { n: 15, home: "A", away: "B", covered: false, summary: "s", headlines: [] } };
  assert.deepEqual(await askAI({}, input), { out: null, provider: null });
  let called = "";
  const fakeGemini = (async (url: string) => { called = String(url); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"reasons":{"1":"hola"},"analysis":"ok"}' }] } }] })); }) as unknown as typeof fetch;
  const g = await askAI({ GEMINI_API_KEY: "k" }, input, fakeGemini);
  assert.ok(called.includes("generativelanguage"));
  assert.equal(g.out?.reasons[1], "hola");
  const fakeClaude = (async () => new Response(JSON.stringify({ content: [{ type: "text", text: 'Claro: {"reasons":{"2":"vale"}}' }] }))) as unknown as typeof fetch;
  const c = await askAI({ ANTHROPIC_API_KEY: "k" }, input, fakeClaude);
  assert.equal(c.out?.reasons[2], "vale");
  const bad = await askAI({ GEMINI_API_KEY: "k" }, input, (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch);
  assert.equal(bad.out, null);
  assert.match(bad.error ?? "", /500/);
  assert.ok(buildPrompt(input).includes("Pleno al 15"));
});

test("pipeline completo con datos sintéticos: 14 signos, boleto seguro y de sorpresas", () => {
  const teams = ["A", "B", "C", "D", "E", "F"];
  const results: Result[] = [];
  let round = 1;
  for (let rep = 0; rep < 3; rep++) for (const h of teams) for (const a of teams) if (h !== a) results.push({ league: "laliga2", round: (round++ % 10) + 1, home: h, away: a, hg: (h.charCodeAt(0) + rep) % 3, ag: (a.charCodeAt(0) + 1) % 2 });
  const matches = Array.from({ length: 14 }, (_, i) => ({ n: i + 1, home: i < 3 ? teams[i * 2 % 6] : "ALAVÉS (F)", away: i < 3 ? teams[(i * 2 + 1) % 6] : "EIBAR (F)" }));
  const { result } = buildFromInputs({ jornada: { name: "Jornada 1", matches, pleno15: { home: "ESPAÑA", away: "INGLATERRA" } }, results, players: [], absences: [], headlines: {} });
  assert.equal(result.matches.length, 14);
  assert.equal(result.ticketSafe.signs.length, 14);
  assert.equal(result.ticketValue.signs.length, 14);
  assert.ok(result.ticketValue.surprises.length <= 3);
  assert.ok(result.columns <= 16);
  for (const m of result.matches) assert.equal(m.probs.p1 + m.probs.px + m.probs.p2, 100);
  assert.equal(result.matches.filter((m) => m.covered).length, 3);
  const withAi = applyAi(result, { out: { reasons: { 1: "frase ia" }, guesses: { 10: { p1: 20, px: 30, p2: 50 } }, analysis: "extra" }, provider: "Test" });
  assert.equal(withAi.matches[0].reasoning, "frase ia");
  assert.equal(withAi.matches[9].pick, "2");
  assert.equal(withAi.aiUsed, "Test");
});

test("ficha de partido: goleadores de cada equipo (uno por gol)", () => {
  const html = `<div class="goleadores_wrapper"><div class="goleadores local"><div class="goleador"><a class="jugador">Giuliano Simeone</a> (10')</div></div>
    <div class="goleadores visitante"><div class="goleador">(45') <a class="jugador">Fermín López</a></div><div class="goleador">(66') <a class="jugador">Fermín López</a></div></div><div class="clearfix"></div></div>`;
  assert.deepEqual(parseMatchScorers(html), { home: ["Giuliano Simeone"], away: ["Fermín López", "Fermín López"] });
  assert.deepEqual(parseMatchScorers("<html></html>"), { home: [], away: [] });
});

test("rachas y sequías de goleadores", () => {
  const mk = (round: number, home: string, away: string): Result => ({ league: "laliga", round, home, away, hg: 0, ag: 0, url: `u${round}` });
  const results = [1, 2, 3, 4, 5, 6].map((r) => mk(r, "Osasuna", "Rival"));
  const scorers: Record<string, { home: string[]; away: string[] }> = {
    u6: { home: ["Ante Budimir"], away: [] }, u5: { home: ["Ante Budimir"], away: [] }, u4: { home: ["Ante Budimir", "Moi Gómez"], away: [] },
    u3: { home: [], away: [] }, u2: { home: [], away: [] }, u1: { home: [], away: [] },
  };
  const players = [
    { name: "Ante Budimir", team: "Osasuna", position: "Delantero", games: 6, minutes: 500, goals: 8, assists: 0 },
    { name: "Raúl García", team: "Osasuna", position: "Delantero", games: 6, minutes: 500, goals: 4, assists: 0 },
  ];
  const f = computeForms(results, scorers, players, ["Osasuna"]).get("Osasuna")!;
  const budimir = f.find((x) => sameName(x.player, "Ante Budimir"))!;
  assert.equal(budimir.tag, "racha");
  assert.equal(budimir.recent, 3);
  const raul = f.find((x) => x.player === "Raúl García")!;
  assert.equal(raul.tag, "sequia"); // 4 goles en la temporada y 0 en los últimos 6
  assert.ok(raul.note.includes("sin marcar"));
  assert.ok(!f.find((x) => x.player === "Moi Gómez")?.tag); // un solo gol: ni racha ni sequía
});

test("titulares: filtra ruido y código", () => {
  const html = `<script>var a={x:1};</script><h2>El Villarreal vence al Madrid con un gol de Pepe en el descuento</h2><p>Política de cookies</p><p>corto</p>`;
  const hs = extractHeadlines(html);
  assert.deepEqual(hs, ["El Villarreal vence al Madrid con un gol de Pepe en el descuento"]);
});
