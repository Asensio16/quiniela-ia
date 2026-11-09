// Genera site/quiniela.json con el pronóstico de la jornada actual.
// Claves de IA opcionales (variables de entorno): GEMINI_API_KEY o ANTHROPIC_API_KEY.
// Caché de fichas de partido en .cache/ (los partidos terminados no cambian): así no se vuelven a descargar.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { buildQuiniela, type Cache } from "../src/pipeline";

const CACHE = ".cache/match-scorers.json";
let cache: Cache = {};
try { if (existsSync(CACHE)) cache = JSON.parse(readFileSync(CACHE, "utf8")); } catch { cache = {}; }

const result = await buildQuiniela(
  {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || undefined,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || undefined,
    AI_MODEL: process.env.AI_MODEL || undefined,
  },
  console.log,
  cache,
);
mkdirSync(".cache", { recursive: true });
writeFileSync(CACHE, JSON.stringify(cache));
mkdirSync("docs", { recursive: true });
writeFileSync("docs/quiniela.json", JSON.stringify(result, null, 2));
console.log(`OK docs/quiniela.json — ${result.jornada} — ${result.signs}`);
console.log(`Notas: ${result.notes.join(" | ") || "—"}`);
