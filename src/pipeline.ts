import { askAI, type AiMatchInput, type Env } from "./ai";
import {
  fetchAbsences, fetchHeadlines, fetchJornada, fetchMatchScorers, fetchPlayers, fetchResults,
  type Headline, type Jornada, type MatchScorers,
} from "./data";
import { computeForms, sameName, type PlayerForm } from "./form";
import {
  chooseSigns, fitLeague, plenoScore, predictMatch, type LeagueModel, type MatchAdjust,
} from "./engine";
import { blend } from "./market";
import { buildTeamIndex, norm, resolveTeam, type TeamIndex } from "./names";
import type { Absence, League, MatchPrediction, PlayerStat, Probs, QuinielaResult, Result, Sign, Ticket } from "./types";

export type Inputs = {
  jornada: Jornada;
  results: Result[];
  players: PlayerStat[];
  absences: Absence[];
  headlines: Record<string, Headline[]>;
  forms?: Map<string, PlayerForm[]>; // rachas y sequías de goleadores
};

const pct = (x: number) => Math.round(x * 100);

/** Peso de las cuotas en la mezcla con el modelo propio. En el backtest de las jornadas 1-20 de la
 *  temporada 2026-27 (141 partidos con las dos cosas) las cuotas solas dan logloss 0,935 y el modelo 0,981;
 *  cuanto más peso a las cuotas, mejor. Se deja un 15 % al modelo para que cuenten las bajas de última hora. */
export const MARKET_WEIGHT = 0.85;

/** Redondea tres probabilidades a enteros que suman exactamente 100. */
export function roundTo100(p: Probs): Probs {
  const v = [p.p1, p.px, p.p2].map((x) => x * 100);
  const f = v.map(Math.floor);
  let rest = 100 - f.reduce((a, b) => a + b, 0);
  const order = v.map((x, i) => [x - f[i], i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) { if (rest <= 0) break; f[i]++; rest--; }
  return { p1: f[0], px: f[1], p2: f[2] };
}

/* ───────────── Bajas: jugador ↔ estadísticas ───────────── */

export function findPlayer(name: string, team: string, players: PlayerStat[]): PlayerStat | null {
  const mine = players.filter((p) => p.team === team);
  const n = norm(name);
  const exact = mine.find((p) => norm(p.name) === n);
  if (exact) return exact;
  const tokens = name.trim().split(/\s+/);
  const last = norm(tokens[tokens.length - 1] ?? "");
  const first = norm(tokens[0] ?? "");
  if (last.length < 3) return null;
  const c = mine.filter((p) => norm(p.name).includes(last));
  if (c.length === 1) return c[0];
  if (c.length > 1) return c.find((p) => norm(p.name).startsWith(first)) ?? null;
  return null;
}

/** Cuánto pierde un equipo en ataque por sus goleadores ausentes (heurística acotada al 12 %). */
export function attackFactor(team: string, absences: Absence[], players: PlayerStat[], teamGoals: number): number {
  if (teamGoals < 5) return 1;
  let loss = 0;
  const seen = new Set<string>();
  for (const a of absences.filter((x) => x.team === team)) {
    const p = findPlayer(a.player, team, players);
    if (!p || seen.has(p.name)) continue;
    seen.add(p.name);
    const doubt = /duda/i.test(a.status) ? 0.5 : 1;
    loss += 0.4 * (p.goals / teamGoals) * doubt;
  }
  return 1 - Math.min(0.12, loss);
}

/* ───────────── Texto automático (sin IA) ───────────── */

const formStr = (f: string[]) => (f.length ? f.join("") : "—");
const ord = (n?: number) => (n ? `${n}º` : "");

export function explain(m: {
  home: string; away: string; probs: Probs; pick: Sign; xgHome: number; xgAway: number;
  formHome: string[]; formAway: string[]; posHome?: number; posAway?: number;
  absences: { team: string; player: string }[];
  topScorer?: { player: string; team: string; goals: number; out?: string };
}): string {
  const parts: string[] = [];
  const rec = (f: string[]) => `${f.filter((x) => x === "G").length}G-${f.filter((x) => x === "E").length}E-${f.filter((x) => x === "P").length}P`;
  if (m.pick === "X" || Math.abs(m.probs.p1 - m.probs.p2) < 0.05) {
    parts.push(`Partido muy igualado: se esperan ${m.xgHome.toFixed(1)}-${m.xgAway.toFixed(1)} goles y hay pocas diferencias entre los dos equipos.`);
  } else {
    const homeFav = m.pick === "1";
    const fav = homeFav ? m.home : m.away;
    const pos = homeFav ? m.posHome : m.posAway;
    const xf = homeFav ? m.xgHome : m.xgAway, xr = homeFav ? m.xgAway : m.xgHome;
    const fForm = homeFav ? m.formHome : m.formAway;
    parts.push(`${fav}${pos ? ` (${ord(pos)})` : ""} parte como favorito: se esperan ${xf.toFixed(1)} goles suyos por ${xr.toFixed(1)} del rival` + (fForm.length ? `; viene de ${rec(fForm)} en sus últimos 5.` : "."));
  }
  const ab = m.absences[0];
  if (ab) parts.push(`Baja: ${ab.player} (${ab.team}).`);
  else if (m.topScorer && !m.topScorer.out) parts.push(`Ojo a ${m.topScorer.player} (${m.topScorer.team}), ${m.topScorer.goals} goles.`);
  return parts.join(" ");
}


/* ───────────── Boleto con sorpresas ─────────────
 * En la Quiniela el premio se reparte entre los acertantes: si todo el mundo juega al favorito,
 * acertar los 14 toca a poco. Estimamos cuánto se juega cada signo (el público sobrevalora al
 * favorito y al local y juega poco la X) y buscamos signos "de valor": con probabilidad real
 * suficiente pero poco jugados. Es una estimación, no el porcentaje real de apuestas de SELAE. */
export function publicShare(p: Probs): Probs {
  const w1 = Math.pow(p.p1, 1.35) * 1.08, wx = Math.pow(p.px, 1.35) * 0.65, w2 = Math.pow(p.p2, 1.35);
  const t = w1 + wx + w2;
  return { p1: w1 / t, px: wx / t, p2: w2 / t };
}

const key = (s: Sign) => (s === "1" ? "p1" : s === "X" ? "px" : "p2") as keyof Probs;

export function findSurprise(probs: Probs, pick: Sign, pub: Probs = publicShare(probs)): { sign: Sign; prob: number; value: number } | undefined {
  let best: { sign: Sign; prob: number; value: number } | undefined;
  for (const sg of ["1", "X", "2"] as Sign[]) {
    if (sg === pick) continue;
    const prob = probs[key(sg)];
    if (prob < 0.26) continue;
    const value = prob / Math.max(0.02, pub[key(sg)]);
    if (value >= 1.1 && (!best || value > best.value)) best = { sign: sg, prob, value };
  }
  return best;
}

/** Prioriza sorpresas con probabilidad alta (partidos abiertos) y bien infravaloradas por el público. */
export const surpriseScore = (s: { prob: number; value: number }) => Math.pow(s.prob, 1.5) * s.value;

function ticketOf(preds: MatchPrediction[], signOf: (p: MatchPrediction) => Sign, surprises: number[]): Ticket {
  const cov = preds.filter((p) => p.priced);
  const prob = (p: MatchPrediction) => p.probs[key(signOf(p))] / 100;
  return {
    signs: preds.map(signOf),
    expectedHits: +cov.reduce((s, p) => s + prob(p), 0).toFixed(1),
    pAll: +(100 * cov.reduce((s, p) => s * prob(p), 1)).toFixed(6),
    surprises,
  };
}

/* ───────────── Construcción del resultado ───────────── */

function leagueOf(results: Result[]): Map<string, League> {
  const m = new Map<string, League>();
  for (const r of results.filter((x) => x.round >= 1)) { m.set(r.home, r.league); m.set(r.away, r.league); }
  return m;
}

export function buildFromInputs(inp: Inputs): { result: QuinielaResult; aiInput: { jornada: string; matches: AiMatchInput[]; pleno15: AiMatchInput } } {
  const { jornada, results, players, absences, headlines } = inp;
  const market = jornada.market ?? null;
  const publicOf = (n: number, p: Probs): { pub: Probs; src: "lae" | "quinielista" | "estimado" } =>
    market?.lae[n] ? { pub: market.lae[n], src: "lae" } : market?.quinielista[n] ? { pub: market.quinielista[n], src: "quinielista" } : { pub: publicShare(p), src: "estimado" };
  const forms = inp.forms ?? new Map<string, PlayerForm[]>();
  const models: Record<League, LeagueModel | null> = {
    laliga: results.some((r) => r.league === "laliga") ? fitLeague(results.filter((r) => r.league === "laliga")) : null,
    laliga2: results.some((r) => r.league === "laliga2") ? fitLeague(results.filter((r) => r.league === "laliga2")) : null,
  };
  const teamLeague = leagueOf(results);
  const idx: TeamIndex = buildTeamIndex([...teamLeague.keys()]);
  const teamGoals = (team: string, lg: League) => models[lg]?.teams.get(team)?.gf ?? 0;

  const buildOne = (n: number, homeRaw: string, awayRaw: string): { pred: MatchPrediction; grid?: ReturnType<typeof predictMatch>; summary: string; reason?: string } => {
    const rh = resolveTeam(homeRaw, idx), ra = resolveTeam(awayRaw, idx);
    const lgH = rh.ok ? teamLeague.get(rh.team) : undefined;
    const lgA = ra.ok ? teamLeague.get(ra.team) : undefined;
    const covered = rh.ok && ra.ok && lgH === lgA && !!lgH && !!models[lgH];

    const mk = n <= 14 ? market?.real[n] : undefined;
    if (!covered) {
      const why = !rh.ok ? rh.reason : !ra.ok ? ra.reason : "desconocido";
      const kind = why === "femenino" ? "fútbol femenino" : why === "seleccion" ? "selecciones" : "otra competición";
      const base: Probs = mk ?? { p1: 0.44, px: 0.28, p2: 0.28 };
      const r = roundTo100(base);
      const s = mk ? chooseSigns(mk) : { pick: "1" as Sign, alt: undefined, advice: "fijo" as const };
      const conf = r[key(s.pick)];
      const favTxt = s.pick === "X" ? `lo más probable es el empate (${conf}%)` : `favorito ${s.pick === "1" ? homeRaw : awayRaw} (${conf}%)`;
      const pred: MatchPrediction = {
        n, home: homeRaw, away: awayRaw, covered: false, priced: !!mk, probs: r, pick: s.pick, alt: s.alt, advice: s.advice,
        confidence: conf, xgHome: 0, xgAway: 0, likelyScore: "—", over25: 0, btts: 0,
        formHome: [], formAway: [], scorers: [], absences: [], news: [],
        marketProbs: mk ? r : undefined,
        reasoning: mk
          ? `Partido de ${kind}: no tenemos estadísticas propias, así que el pronóstico sale de las cuotas de las casas de apuestas: ${favTxt}.`
          : `Sin datos (${kind}) y todavía sin cuotas publicadas: probabilidades genéricas, juega con cautela.`,
        source: mk ? "cuotas" : "modelo",
      };
      return { pred, summary: mk ? `Sin estadísticas propias (${why}). Cuotas: 1=${r.p1}% X=${r.px}% 2=${r.p2}%.` : `Sin datos estadísticos (${why}).` };
    }

    const lg = lgH!;
    const model = models[lg]!;
    const home = (rh as { team: string }).team, away = (ra as { team: string }).team;
    const adj: MatchAdjust = lg === "laliga"
      ? { attHome: attackFactor(home, absences, players, teamGoals(home, lg)), attAway: attackFactor(away, absences, players, teamGoals(away, lg)) }
      : {};
    const out = predictMatch(model, home, away, adj)!;
    const th = model.teams.get(home)!, ta = model.teams.get(away)!;
    const final = blend(out.probs, mk, MARKET_WEIGHT);
    const signs = chooseSigns(final);
    const probs = roundTo100(final);
    const modelPick = chooseSigns(out.probs).pick;

    const matchAbs = absences
      .filter((a) => a.team === home || a.team === away)
      .filter((a) => findPlayer(a.player, a.team, players) || lg === "laliga2")
      .slice(0, 4)
      .map((a) => ({ team: a.team, player: a.player, reason: `${a.kind}: ${a.reason}${a.status ? ` — ${a.status}` : ""}` }));

    const scorers: MatchPrediction["scorers"] = [];
    for (const [team, lam] of [[home, out.lh], [away, out.la]] as const) {
      const tf = forms.get(team) ?? [];
      const seen = new Set<string>();
      const push = (player: string, goals: number, perGame: number, share: number, f?: PlayerForm) => {
        if (seen.has(norm(player))) return;
        seen.add(norm(player));
        const ab = absences.find((a) => a.team === team && sameName(a.player, player));
        scorers.push({
          player, team, goals, perGame, chance: ab ? 0 : pct(1 - Math.exp(-lam * share * (f?.tag === "racha" ? 1.15 : 1))),
          out: ab ? `${ab.kind}${ab.status ? ` — ${ab.status}` : ""}` : undefined,
          tag: ab ? undefined : f?.tag, recent: f?.recent, window: f?.window, note: ab ? undefined : f?.note || undefined,
        });
      };
      // 1) goleadores de la temporada (solo Primera: ahí hay estadísticas por jugador)
      if (lg === "laliga") {
        const tg = teamGoals(team, lg) || 1;
        for (const p of players.filter((x) => x.team === team && x.goals >= 2).sort((a, b) => b.goals - a.goals).slice(0, 2))
          push(p.name, p.goals, p.games ? +(p.goals / p.games).toFixed(2) : 0, p.goals / tg, tf.find((f) => sameName(f.player, p.name)));
      }
      // 2) jugadores en racha o en sequía (también en Segunda, donde solo conocemos los goles recientes)
      for (const f of tf.filter((x) => x.tag).slice(0, 3)) {
        const share = f.tag === "racha" ? Math.min(0.6, f.windowGoals / Math.max(1, f.teamWindowGoals)) : (f.seasonGoals ?? 3) / Math.max(1, teamGoals(team, lg) || 1);
        push(f.player, f.seasonGoals ?? f.windowGoals, 0, share, f);
      }
    }
    const topScorer = scorers.filter((x) => !x.out).sort((a, b) => b.goals - a.goals)[0];
    let reasoning = explain({
      home, away, probs: out.probs, pick: modelPick, xgHome: out.lh, xgAway: out.la,
      formHome: th.form, formAway: ta.form, posHome: th.pos, posAway: ta.pos,
      absences: matchAbs, topScorer,
    });
    if (mk && modelPick !== signs.pick)
      reasoning = `Las casas de apuestas ven más probable el ${signs.pick} (${probs[key(signs.pick)]}%) y pesan más que nuestras estadísticas. ${reasoning}`;
    else if (mk && signs.pick !== "X" && probs[key(signs.pick)] - roundTo100(out.probs)[key(signs.pick)] >= 8)
      reasoning = `Las casas de apuestas ven más favorito a ${signs.pick === "1" ? home : away} (${probs[key(signs.pick)]}%) que nuestras estadísticas. ${reasoning}`;
    const pred: MatchPrediction = {
      n, home: homeRaw, away: awayRaw, covered: true, priced: true, league: lg, probs, pick: signs.pick,
      modelProbs: roundTo100(out.probs), marketProbs: mk ? roundTo100(mk) : undefined,
      alt: signs.alt, advice: signs.advice, confidence: probs[signs.pick === "1" ? "p1" : signs.pick === "X" ? "px" : "p2"],
      xgHome: +out.lh.toFixed(2), xgAway: +out.la.toFixed(2),
      likelyScore: `${out.likely.h}-${out.likely.a}`, over25: pct(out.over25), btts: pct(out.btts),
      formHome: th.form, formAway: ta.form, posHome: th.pos, posAway: ta.pos,
      reasoning, scorers, absences: matchAbs, news: [...(headlines[home] ?? []), ...(headlines[away] ?? [])].slice(0, 3), source: mk ? "modelo+cuotas" : "modelo",
    };
    const summary =
      `Pronóstico: 1=${probs.p1}% X=${probs.px}% 2=${probs.p2}%${mk ? " (cuotas + modelo)" : ""} · goles esperados ${pred.xgHome}-${pred.xgAway} · ` +
      `${home} (${ord(th.pos)}, forma ${formStr(th.form)}) vs ${away} (${ord(ta.pos)}, forma ${formStr(ta.form)})` +
      (matchAbs.length ? ` · Bajas: ${matchAbs.map((a) => `${a.player} (${a.team})`).join(", ")}` : "") +
      (scorers.length ? ` · Goleadores: ${scorers.filter((s) => !s.out).slice(0, 4).map((s) => `${s.player} (${s.team}, ${s.goals} goles${s.tag === "racha" ? ", EN RACHA" : s.tag === "sequia" ? ", EN SEQUÍA" : ""})`).join(", ")}` : "");
    return { pred, grid: out, summary };
  };

  const built = jornada.matches.map((f) => buildOne(f.n, f.home, f.away));
  const p15 = buildOne(15, jornada.pleno15.home, jornada.pleno15.away);

  // Dobles: como mucho los 4 partidos más abiertos (el resto, fijos)
  const open = built
    .filter((b) => b.pred.priced && b.pred.alt)
    .sort((a, b) => a.pred.confidence - b.pred.confidence);
  const keep = new Set(open.slice(0, 4).map((b) => b.pred.n));
  for (const b of built) {
    if (!keep.has(b.pred.n)) { b.pred.advice = "fijo"; b.pred.alt = undefined; }
    else if (b.pred.advice === "triple") b.pred.advice = "doble";
  }

  // Sorpresas: las 3 de mayor valor entre los partidos con datos
  let publicSrc: "lae" | "quinielista" | "estimado" = "estimado";
  for (const b of built) if (b.pred.priced) {
    const pr = { p1: b.pred.probs.p1 / 100, px: b.pred.probs.px / 100, p2: b.pred.probs.p2 / 100 };
    const { pub, src } = publicOf(b.pred.n, pr);
    b.pred.publicPct = roundTo100(pub); b.pred.publicSrc = src;
    if (src !== "estimado") publicSrc = src;
    b.pred.surprise = findSurprise(pr, b.pred.pick, pub);
  }
  const picks = built.filter((b) => b.pred.surprise).sort((a, b) => surpriseScore(b.pred.surprise!) - surpriseScore(a.pred.surprise!)).slice(0, 3);
  for (const b of picks) b.pred.valuePick = true;

  const G = ["0", "1", "2", "M"] as const;
  const mp = market?.pleno.real;
  const top = (v: number[]) => G[v.indexOf(Math.max(...v))];
  const pleno = mp
    ? { h: top(mp.h), a: top(mp.a) }
    : p15.grid ? plenoScore(p15.grid.grid) : { h: "1" as const, a: "1" as const };

  const aiInput = {
    jornada: jornada.name,
    matches: built.map((b) => ({
      n: b.pred.n, home: b.pred.home, away: b.pred.away, covered: b.pred.covered, summary: b.summary,
      headlines: b.pred.news.map((n) => `${n.src}: ${n.title}`),
    })),
    pleno15: { n: 15, home: p15.pred.home, away: p15.pred.away, covered: p15.pred.covered, summary: p15.summary, headlines: [] as string[] },
  };

  const preds = built.map((b) => b.pred);
  const stats = preds.filter((p) => p.covered).length;
  const covered = preds.filter((p) => p.priced);
  const ones = preds.filter((p) => p.pick === "1").length;
  const xs = preds.filter((p) => p.pick === "X").length;
  const twos = preds.filter((p) => p.pick === "2").length;
  const expectedHits = covered.reduce((s, p) => s + p.confidence / 100, 0);
  const columns = preds.reduce((c, p) => c * (p.advice === "doble" ? 2 : p.advice === "triple" ? 3 : 1), 1);
  const lastRound: Record<string, number> = {};
  for (const lg of ["laliga", "laliga2"] as const) if (models[lg]) lastRound[lg] = Math.max(...results.filter((r) => r.league === lg && r.round >= 1).map((r) => r.round));

  const safest = covered.slice().sort((a, b) => b.confidence - a.confidence).slice(0, 2);
  const openest = covered.slice().sort((a, b) => a.confidence - b.confidence).slice(0, 2);
  const analysis = covered.length
    ? `Hay pronóstico real para ${covered.length} de los 14 partidos (${stats} con estadísticas propias${market ? `, ${Object.keys(market.real).length} con cuotas` : ""}) y se reparten los signos en ${ones} unos, ${xs} equis y ${twos} doses. ` +
      `Lo más claro: ${safest.map((p) => `${p.home}-${p.away} (${p.pick}, ${p.confidence}%)`).join(" y ")}. ` +
      `Lo más abierto: ${openest.map((p) => `${p.home}-${p.away} (${p.confidence}%)`).join(" y ")}.`
    : "Esta jornada no hay partidos con datos suficientes.";

  const notes: string[] = [];
  const nUncovered = 14 - covered.length;
  if (nUncovered > 0) notes.push(`${nUncovered} partido(s) sin datos ni cuotas todavía: probabilidades genéricas o estimación de la IA.`);
  if (!market || !Object.keys(market.real).length) notes.push("Aún no hay cuotas publicadas para esta jornada: el pronóstico usa solo el modelo propio.");
  notes.push(publicSrc === "lae" ? "Las sorpresas 💎 usan el porcentaje real de apuestas de cada signo (dato oficial de Loterías)."
    : publicSrc === "quinielista" ? "Las sorpresas 💎 usan lo que están jugando los quinielistas (el dato oficial de Loterías aún no ha salido)."
    : "Las sorpresas 💎 usan una estimación de lo que juega la gente (aún no hay porcentajes publicados).");

  const result: QuinielaResult = {
    jornada: jornada.name,
    matches: preds,
    pleno15: {
      home: p15.pred.home, away: p15.pred.away, homeGoals: pleno.h, awayGoals: pleno.a, covered: p15.pred.covered,
      priced: !!mp || p15.pred.covered,
      dist: mp ? { h: mp.h.map((x) => +x.toFixed(3)), a: mp.a.map((x) => +x.toFixed(3)) } : undefined,
      reasoning: mp
        ? `Lo más probable según las cuotas: ${p15.pred.home} marca ${pleno.h === "M" ? "más de 2" : pleno.h} (${pct(Math.max(...mp.h))}%) ${/^h?i/i.test(p15.pred.away) ? "e" : "y"} ${p15.pred.away} marca ${pleno.a === "M" ? "más de 2" : pleno.a} (${pct(Math.max(...mp.a))}%).`
        : p15.pred.covered
          ? `Marcador más probable según el modelo (${p15.pred.xgHome}-${p15.pred.xgAway} goles esperados).`
          : "Sin datos de este partido: marcador orientativo.",
    },
    signs: preds.map((p) => p.pick).join(" "),
    ticketSafe: ticketOf(preds, (p) => p.pick, []),
    ticketValue: ticketOf(preds, (p) => (p.valuePick ? p.surprise!.sign : p.pick), preds.filter((p) => p.valuePick).map((p) => p.n)),
    distribution: { ones, xs, twos },
    expectedHits: +expectedHits.toFixed(1),
    analysis,
    confidence: covered.length ? Math.round(covered.reduce((s, p) => s + p.confidence, 0) / covered.length) : 0,
    columns,
    generatedAt: new Date().toISOString(),
    dataAsOf: { lastRound, results: results.filter((r) => r.round >= 1).length },
    aiUsed: null,
    notes,
    source: "SELAE y porcentajes (eduardolosilla.es) · cuotas de casas de apuestas · futbolfantasy.com · modelo estadístico propio",
    num: jornada.num,
    closing: jornada.closing || undefined,
    escrutada: jornada.escrutada || undefined,
    market: { odds: market ? Object.keys(market.real).length : 0, publicSrc },
  };
  return { result, aiInput };
}

function resolveTeamName(raw: string, idx: TeamIndex): string | null {
  const r = resolveTeam(raw, idx);
  return r.ok ? r.team : null;
}

/** Aplica la salida de la IA (si la hay) sobre el resultado del motor. */
export function applyAi(result: QuinielaResult, ai: Awaited<ReturnType<typeof askAI>>): QuinielaResult {
  if (!ai.out) {
    if (ai.error) result.notes.push(`IA no disponible (${ai.error.slice(0, 120)}): textos automáticos del modelo.`);
    return result;
  }
  const out = ai.out;
  for (const m of result.matches) {
    if (out.reasons[m.n]) { m.reasoning = out.reasons[m.n]; if (m.covered) m.source = "modelo+ia"; }
    const g = out.guesses[m.n];
    if (!m.priced && g) {
      const probs = roundTo100({ p1: g.p1 / 100, px: g.px / 100, p2: g.p2 / 100 });
      const s = chooseSigns({ p1: g.p1 / 100, px: g.px / 100, p2: g.p2 / 100 });
      m.probs = probs; m.pick = s.pick; m.alt = undefined; m.advice = "fijo";
      m.confidence = probs[s.pick === "1" ? "p1" : s.pick === "X" ? "px" : "p2"];
      m.source = "ia";
      if (g.reasoning) m.reasoning = `Estimación de la IA (sin datos del modelo): ${g.reasoning}`;
    }
  }
  if (!result.pleno15.covered && !result.pleno15.priced && out.pleno) {
    if (out.pleno.homeGoals) result.pleno15.homeGoals = out.pleno.homeGoals as "0" | "1" | "2" | "M";
    if (out.pleno.awayGoals) result.pleno15.awayGoals = out.pleno.awayGoals as "0" | "1" | "2" | "M";
    if (out.pleno.reasoning) result.pleno15.reasoning = `Estimación de la IA: ${out.pleno.reasoning}`;
  }
  if (out.analysis) result.analysis = `${result.analysis} ${out.analysis}`;
  result.aiUsed = ai.provider;
  // recomputar resúmenes tras posibles cambios de signo
  const preds = result.matches;
  result.signs = preds.map((p) => p.pick).join(" ");
  result.ticketSafe = ticketOf(preds, (p) => p.pick, []);
  result.ticketValue = ticketOf(preds, (p) => (p.valuePick ? p.surprise!.sign : p.pick), preds.filter((p) => p.valuePick).map((p) => p.n));
  result.distribution = {
    ones: preds.filter((p) => p.pick === "1").length,
    xs: preds.filter((p) => p.pick === "X").length,
    twos: preds.filter((p) => p.pick === "2").length,
  };
  result.columns = preds.reduce((c, p) => c * (p.advice === "doble" ? 2 : p.advice === "triple" ? 3 : 1), 1);
  return result;
}

export type Cache = Record<string, MatchScorers>;

export async function buildQuiniela(env: Env, log: (s: string) => void = console.log, cache: Cache = {}): Promise<QuinielaResult> {
  const [jornada, results, players] = await Promise.all([
    fetchJornada(),
    fetchResults(true),
    fetchPlayers().catch((e) => { log(`Sin estadísticas de jugadores: ${e}`); return [] as PlayerStat[]; }),
  ]);
  const teams = [...new Set(results.filter((r) => r.round >= 1).flatMap((r) => [r.home, r.away]))];
  // equipos de esta jornada → sus últimos 6 partidos → quién marcó en cada uno
  const idx = buildTeamIndex(teams);
  const playing = new Set<string>();
  for (const f of [...jornada.matches, { n: 15, ...jornada.pleno15 }])
    for (const raw of [f.home, f.away]) { const r = resolveTeam(raw, idx); if (r.ok) playing.add(r.team); }
  const urls: string[] = [];
  for (const t of playing)
    urls.push(...results.filter((r) => r.round >= 1 && r.url && (r.home === t || r.away === t)).sort((a, b) => b.round - a.round).slice(0, 6).map((r) => r.url!));
  const [absences, headlines, scorers] = await Promise.all([fetchAbsences(teams), fetchHeadlines(teams), fetchMatchScorers(urls, cache)]);
  const forms = computeForms(results, scorers, players, [...playing]);
  log(`${jornada.name}: ${results.length} resultados, ${players.length} jugadores, ${absences.length} bajas, ${Object.keys(scorers).length} fichas de partido`);
  const { result, aiInput } = buildFromInputs({ jornada, results, players, absences, headlines, forms });
  if (env.GEMINI_API_KEY || env.ANTHROPIC_API_KEY) {
    const ai = await askAI(env, aiInput);
    return applyAi(result, ai);
  }
  result.notes.push("Sin clave de IA: textos automáticos del modelo.");
  return result;
}
