// Marcador de aciertos: guarda el boleto de cada jornada antes del cierre y, cuando hay escrutinio,
// cuenta cuántos signos se acertaron. Funciones puras (el script generate.ts se encarga de leer y escribir).
import { signOf } from "./engine";
import type { QuinielaResult, Record_, RecordEntry } from "./types";

const bucket = (g: number) => (g >= 3 ? "M" : String(g));

/** Guarda (o actualiza) el boleto de la jornada en venta. Tras el cierre de apuestas ya no se toca. */
export function upsertEntry(rec: Record_, r: QuinielaResult, now = Date.now()): Record_ {
  if (!r.num || (r.closing && now >= r.closing)) return rec;
  const old = rec.entries.find((e) => e.j === r.num);
  if (old?.results) return rec;
  const entry: RecordEntry = {
    j: r.num, savedAt: new Date(now).toISOString(),
    safe: r.ticketSafe.signs, value: r.ticketValue.signs, pleno: `${r.pleno15.homeGoals}-${r.pleno15.awayGoals}`,
  };
  return { ...rec, entries: [...rec.entries.filter((e) => e.j !== r.num), entry].sort((a, b) => a.j - b.j) };
}

/** Rellena los resultados de una jornada ya escrutada. scores: nº de partido → [goles local, goles visitante]. */
export function resolveEntry(e: RecordEntry, scores: Record<number, [number, number]>): RecordEntry {
  const results: string[] = [];
  let hitsSafe = 0, hitsValue = 0, played = 0;
  for (let n = 1; n <= 14; n++) {
    const s = scores[n];
    if (!s) { results.push("-"); continue; }
    const real = signOf(s[0], s[1]);
    results.push(real); played++;
    if (e.safe[n - 1] === real) hitsSafe++;
    if (e.value[n - 1] === real) hitsValue++;
  }
  const s15 = scores[15];
  const score15 = s15 ? `${bucket(s15[0])}-${bucket(s15[1])}` : undefined;
  return { ...e, results, played, hitsSafe, hitsValue, score15, plenoHit: score15 ? score15 === e.pleno : undefined };
}
