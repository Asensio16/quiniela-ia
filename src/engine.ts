import type { Probs, Result, Sign } from "./types";

/**
 * Motor estadístico de Quiniela IA.
 *
 * Modelo tipo Dixon-Coles: cada equipo tiene un ataque y una defensa; los goles de cada
 * equipo siguen una Poisson cuya media depende del ataque propio, la defensa rival y la
 * ventaja de jugar en casa. Los partidos recientes pesan más (semivida en jornadas) y los
 * equipos con pocos partidos se "encogen" hacia la media de la liga.
 * Los parámetros por defecto se han ajustado con un backtest (ver scripts/backtest.ts).
 */
export type Params = {
  halfLife: number; // jornadas en las que un partido pierde la mitad de su peso
  prior: number; // partidos "virtuales" de media de liga que estabilizan a cada equipo
  rho: number; // corrección Dixon-Coles de marcadores bajos (negativo = más empates 0-0/1-1)
  iterations: number;
};

export const DEFAULT_PARAMS: Params = { halfLife: Infinity, prior: 8, rho: -0.08, iterations: 80 };

export type TeamRating = {
  att: number;
  def: number;
  games: number;
  gf: number;
  ga: number;
  gfHome: number; gaHome: number; gamesHome: number;
  gfAway: number; gaAway: number; gamesAway: number;
  points: number;
  form: ("G" | "E" | "P")[]; // últimos 5, más reciente primero
  pos: number;
};

export type LeagueModel = {
  mu: number;
  home: number;
  teams: Map<string, TeamRating>;
  lastRound: number;
  params: Params;
};

export function fitLeague(results: Result[], params: Params = DEFAULT_PARAMS): LeagueModel {
  const names = [...new Set(results.flatMap((r) => [r.home, r.away]))];
  const lastRound = results.reduce((m, r) => Math.max(m, r.round), -999);
  const w = (r: Result) => (Number.isFinite(params.halfLife) ? Math.pow(0.5, (lastRound - r.round) / params.halfLife) : 1);
  const att = new Map(names.map((n) => [n, 1]));
  const def = new Map(names.map((n) => [n, 1]));
  let mu = 1.3;
  let home = 1.25;
  const k = params.prior;

  for (let it = 0; it < params.iterations; it++) {
    const na = new Map<string, number>(), da = new Map<string, number>();
    const nd = new Map<string, number>(), dd = new Map<string, number>();
    for (const n of names) { na.set(n, k * mu); da.set(n, k * mu); nd.set(n, k * mu); dd.set(n, k * mu); }
    for (const r of results) {
      const wt = w(r);
      // ataque del local / defensa del visitante
      na.set(r.home, na.get(r.home)! + wt * r.hg);
      da.set(r.home, da.get(r.home)! + wt * mu * home * def.get(r.away)!);
      nd.set(r.away, nd.get(r.away)! + wt * r.hg);
      dd.set(r.away, dd.get(r.away)! + wt * mu * home * att.get(r.home)!);
      // ataque del visitante / defensa del local
      na.set(r.away, na.get(r.away)! + wt * r.ag);
      da.set(r.away, da.get(r.away)! + wt * mu * def.get(r.home)!);
      nd.set(r.home, nd.get(r.home)! + wt * r.ag);
      dd.set(r.home, dd.get(r.home)! + wt * mu * att.get(r.away)!);
    }
    for (const n of names) {
      att.set(n, na.get(n)! / da.get(n)!);
      def.set(n, nd.get(n)! / dd.get(n)!);
    }
    // normalizar (media 1) para que mu y home tengan significado
    const ma = names.reduce((s, n) => s + att.get(n)!, 0) / names.length;
    const md = names.reduce((s, n) => s + def.get(n)!, 0) / names.length;
    for (const n of names) { att.set(n, att.get(n)! / ma); def.set(n, def.get(n)! / md); }
    // mu y ventaja de campo
    let sg = 0, se = 0, sh = 0, seh = 0;
    for (const r of results) {
      const wt = w(r);
      const eh = att.get(r.home)! * def.get(r.away)!;
      const ea = att.get(r.away)! * def.get(r.home)!;
      sg += wt * (r.hg + r.ag);
      se += wt * (home * eh + ea);
      sh += wt * r.hg;
      seh += wt * eh;
    }
    // goles totales = mu * (home*eh + ea)  ->  mu = sg / se ; goles locales = mu*home*eh  ->  home = sh / (mu*Σw·eh)
    mu = sg / se;
    home = sh / (mu * seh);
  }

  // clasificación y forma (a partir de los resultados reales, sin pesos)
  const stat = new Map<string, TeamRating>();
  for (const n of names)
    stat.set(n, {
      att: att.get(n)!, def: def.get(n)!, games: 0, gf: 0, ga: 0,
      gfHome: 0, gaHome: 0, gamesHome: 0, gfAway: 0, gaAway: 0, gamesAway: 0,
      points: 0, form: [], pos: 0,
    });
  const current = results.filter((r) => r.round >= 1);
  for (const r of current) {
    const h = stat.get(r.home)!, a = stat.get(r.away)!;
    h.games++; a.games++; h.gamesHome++; a.gamesAway++;
    h.gf += r.hg; h.ga += r.ag; a.gf += r.ag; a.ga += r.hg;
    h.gfHome += r.hg; h.gaHome += r.ag; a.gfAway += r.ag; a.gaAway += r.hg;
    h.points += r.hg > r.ag ? 3 : r.hg === r.ag ? 1 : 0;
    a.points += r.ag > r.hg ? 3 : r.hg === r.ag ? 1 : 0;
  }
  const ordered = [...current].sort((a, b) => b.round - a.round);
  for (const r of ordered) {
    const h = stat.get(r.home)!, a = stat.get(r.away)!;
    if (h.form.length < 5) h.form.push(r.hg > r.ag ? "G" : r.hg === r.ag ? "E" : "P");
    if (a.form.length < 5) a.form.push(r.ag > r.hg ? "G" : r.hg === r.ag ? "E" : "P");
  }
  [...stat.entries()]
    .filter(([, t]) => t.games > 0)
    .sort((x, y) => y[1].points - x[1].points || (y[1].gf - y[1].ga) - (x[1].gf - x[1].ga) || y[1].gf - x[1].gf)
    .forEach(([, t], i) => (t.pos = i + 1));

  return { mu, home, teams: stat, lastRound, params };
}

/* ───────────────────────── Predicción de un partido ───────────────────────── */

export type MatchAdjust = { attHome?: number; attAway?: number }; // multiplicadores por bajas (≈0.9-1)

function poissonPmf(l: number, max: number): number[] {
  const p = [Math.exp(-l)];
  for (let i = 1; i <= max; i++) p.push((p[i - 1] * l) / i);
  return p;
}

export type Grid = { p: number[][]; max: number };

export function scoreGrid(lh: number, la: number, rho: number, max = 9): Grid {
  const ph = poissonPmf(lh, max), pa = poissonPmf(la, max);
  const p: number[][] = [];
  let tot = 0;
  for (let i = 0; i <= max; i++) {
    p.push([]);
    for (let j = 0; j <= max; j++) {
      let tau = 1;
      if (i === 0 && j === 0) tau = 1 - lh * la * rho;
      else if (i === 0 && j === 1) tau = 1 + lh * rho;
      else if (i === 1 && j === 0) tau = 1 + la * rho;
      else if (i === 1 && j === 1) tau = 1 - rho;
      const v = Math.max(0, ph[i] * pa[j] * tau);
      p[i].push(v);
      tot += v;
    }
  }
  for (const row of p) for (let j = 0; j <= max; j++) row[j] /= tot;
  return { p, max };
}

export function grid1x2(g: Grid): Probs {
  let p1 = 0, px = 0, p2 = 0;
  for (let i = 0; i <= g.max; i++)
    for (let j = 0; j <= g.max; j++) {
      if (i > j) p1 += g.p[i][j];
      else if (i === j) px += g.p[i][j];
      else p2 += g.p[i][j];
    }
  return { p1, px, p2 };
}

export type MatchModelOut = {
  lh: number; la: number; probs: Probs; grid: Grid;
  likely: { h: number; a: number; p: number };
  over25: number; btts: number;
};

export function predictMatch(model: LeagueModel, home: string, away: string, adj: MatchAdjust = {}): MatchModelOut | null {
  const h = model.teams.get(home), a = model.teams.get(away);
  if (!h || !a) return null;
  const lh = model.mu * model.home * h.att * a.def * (adj.attHome ?? 1);
  const la = model.mu * a.att * h.def * (adj.attAway ?? 1);
  const grid = scoreGrid(lh, la, model.params.rho);
  const probs = grid1x2(grid);
  let best = { h: 1, a: 1, p: 0 };
  let over = 0, btts = 0;
  for (let i = 0; i <= grid.max; i++)
    for (let j = 0; j <= grid.max; j++) {
      const v = grid.p[i][j];
      if (v > best.p) best = { h: i, a: j, p: v };
      if (i + j > 2) over += v;
      if (i > 0 && j > 0) btts += v;
    }
  return { lh, la, probs, grid, likely: best, over25: over, btts };
}

/** Marcador más probable del Pleno al 15 con la escala de la Quiniela (0,1,2,M=más de 2). */
export function plenoScore(grid: Grid): { h: "0" | "1" | "2" | "M"; a: "0" | "1" | "2" | "M" } {
  const bucket = (n: number) => (n >= 3 ? 3 : n);
  const acc: number[][] = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (let i = 0; i <= grid.max; i++) for (let j = 0; j <= grid.max; j++) acc[bucket(i)][bucket(j)] += grid.p[i][j];
  let bi = 1, bj = 1, bv = -1;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (acc[i][j] > bv) { bv = acc[i][j]; bi = i; bj = j; }
  const s = (n: number) => (n === 3 ? "M" : String(n)) as "0" | "1" | "2" | "M";
  return { h: s(bi), a: s(bj) };
}

/* ───────────────────────── Elección del signo ───────────────────────── */

export function chooseSigns(p: Probs): { pick: Sign; alt?: Sign; advice: "fijo" | "doble" | "triple" } {
  const arr: [Sign, number][] = [["1", p.p1], ["X", p.px], ["2", p.p2]];
  arr.sort((a, b) => b[1] - a[1]);
  const [first, second, third] = arr;
  // Triple solo si los tres están muy parejos; doble si el 2º está cerca o el 1º no llega al 48%
  if (first[1] < 0.4 && third[1] > 0.24) return { pick: first[0], alt: second[0], advice: "triple" };
  if (first[1] - second[1] < 0.1 || first[1] < 0.48) return { pick: first[0], alt: second[0], advice: "doble" };
  return { pick: first[0], advice: "fijo" };
}

/** Texto 1X2 -> "1", "X", "2" real a partir de un marcador. */
export function signOf(hg: number, ag: number): Sign {
  return hg > ag ? "1" : hg === ag ? "X" : "2";
}
