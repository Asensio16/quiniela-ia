import type { MatchScorers } from "./data";
import { norm } from "./names";
import type { PlayerStat, Result } from "./types";

/** Forma goleadora de un jugador en los últimos partidos de su equipo. */
export type PlayerForm = {
  player: string;
  team: string;
  recent: number; // goles en los últimos 5 partidos del equipo
  window: number; // partidos de equipo analizados (máx. 6)
  windowGoals: number; // goles del jugador en la ventana
  teamWindowGoals: number; // goles totales del equipo en la ventana (de jugadores con nombre)
  seasonGoals?: number;
  tag?: "racha" | "sequia";
  note: string;
};

const WINDOW = 6;

/** ¿Es el mismo jugador? (nombre completo vs. nombre corto de la ficha del partido) */
export function sameName(a: string, b: string): boolean {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 5 && long.includes(short);
}

/** Une variantes de nombre ("Fermín López" / "Fermín") dentro de un mismo equipo. */
function canonicalPlayer(name: string, known: string[]): string {
  return known.find((k) => sameName(k, name)) ?? name;
}

export function computeForms(
  results: Result[],
  scorers: Record<string, MatchScorers>,
  players: PlayerStat[],
  teams: string[],
): Map<string, PlayerForm[]> {
  const out = new Map<string, PlayerForm[]>();
  const current = results.filter((r) => r.round >= 1 && r.url && scorers[r.url]);
  for (const team of teams) {
    const games = current
      .filter((r) => r.home === team || r.away === team)
      .sort((a, b) => b.round - a.round)
      .slice(0, WINDOW);
    if (games.length < 3) continue;
    const goals = new Map<string, number[]>(); // jugador -> goles por partido (índice 0 = más reciente)
    games.forEach((g, gi) => {
      const side = g.home === team ? "home" : "away";
      for (const raw of scorers[g.url!][side]) {
        const name = canonicalPlayer(raw, [...goals.keys()]);
        if (!goals.has(name)) goals.set(name, new Array(games.length).fill(0));
        goals.get(name)![gi]++;
      }
    });
    const teamWindowGoals = [...goals.values()].reduce((s, a) => s + a.reduce((x, y) => x + y, 0), 0);
    const list: PlayerForm[] = [];
    for (const [player, perGame] of goals) {
      const windowGoals = perGame.reduce((a, b) => a + b, 0);
      const recent = perGame.slice(0, 5).reduce((a, b) => a + b, 0);
      const last3 = perGame.slice(0, 3).reduce((a, b) => a + b, 0);
      const stat = players.find((p) => p.team === team && sameName(p.name, player));
      const hot = recent >= 3 || last3 >= 2;
      list.push({
        player, team, recent, window: games.length, windowGoals, teamWindowGoals, seasonGoals: stat?.goals,
        tag: hot ? "racha" : undefined,
        note: hot ? `en racha: ${recent} gol${recent === 1 ? "" : "es"} en sus últimos ${Math.min(5, games.length)} partidos` : "",
      });
    }
    // Sequía: goleadores de la temporada (≥3 goles) que no han marcado en la ventana
    for (const p of players.filter((x) => x.team === team && x.goals >= 3)) {
      const marked = [...goals.keys()].some((g) => sameName(g, p.name));
      if (marked) continue;
      list.push({
        player: p.name, team, recent: 0, window: games.length, windowGoals: 0, teamWindowGoals, seasonGoals: p.goals, tag: "sequia",
        note: `sin marcar en sus últimos ${games.length} partidos (lleva ${p.goals} en la temporada): puede romper la racha`,
      });
    }
    list.sort((a, b) => (a.tag === "racha" ? 0 : a.tag === "sequia" ? 1 : 2) - (b.tag === "racha" ? 0 : b.tag === "sequia" ? 1 : 2) || b.recent - a.recent || (b.seasonGoals ?? 0) - (a.seasonGoals ?? 0));
    out.set(team, list);
  }
  return out;
}
