// Genera docs/quiniela.json con el pronóstico de la jornada actual y mantiene docs/history.json
// (marcador de aciertos: el boleto de cada jornada y, cuando se juega, cuántos signos acertó).
// Claves de IA opcionales (variables de entorno): GEMINI_API_KEY o ANTHROPIC_API_KEY.
// Caché de fichas de partido en .cache/ (los partidos terminados no cambian): así no se vuelven a descargar.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fetchJornadaHtml } from "../src/data";
import { parseScores } from "../src/market";
import { buildQuiniela, type Cache } from "../src/pipeline";
import { resolveEntry, upsertEntry } from "../src/record";
import type { Record_ } from "../src/types";

const CACHE = ".cache/match-scorers.json";
const HISTORY = "docs/history.json";
let cache: Cache = {};
try { if (existsSync(CACHE)) cache = JSON.parse(readFileSync(CACHE, "utf8")); } catch { cache = {}; }
let rec: Record_ = { entries: [] };
try { if (existsSync(HISTORY)) rec = JSON.parse(readFileSync(HISTORY, "utf8")); } catch { /* se empieza de cero */ }

const result = await buildQuiniela(
  {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || undefined,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || undefined,
    AI_MODEL: process.env.AI_MODEL || undefined,
  },
  console.log,
  cache,
);

// Marcador: guardar el boleto de esta jornada y resolver las que ya tienen escrutinio
rec = upsertEntry(rec, result);
const escrutada = result.escrutada ?? 0;
for (const e of rec.entries) {
  if (e.results || e.j > escrutada) continue;
  try {
    const done = resolveEntry(e, parseScores(await fetchJornadaHtml(e.j)));
    if ((done.played ?? 0) >= 10) { rec.entries[rec.entries.indexOf(e)] = done; console.log(`Marcador J${e.j}: ${done.hitsSafe}/${done.played}`); }
  } catch (err) { console.log(`Marcador J${e.j}: sin resultados todavía (${err})`); }
}
result.record = { entries: rec.entries.filter((e) => e.results).slice(-12), sim: rec.sim };

mkdirSync(".cache", { recursive: true });
writeFileSync(CACHE, JSON.stringify(cache));
mkdirSync("docs", { recursive: true });
writeFileSync(HISTORY, JSON.stringify(rec, null, 1));
writeFileSync("docs/quiniela.json", JSON.stringify(result, null, 2));
console.log(`OK docs/quiniela.json — ${result.jornada} — ${result.signs}`);
console.log(`Notas: ${result.notes.join(" | ") || "—"}`);
