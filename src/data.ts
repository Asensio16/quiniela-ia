import { parseMarket, parseState, type Market } from "./market";
import type { Absence, Fixture, League, PlayerStat, Result } from "./types";

const UA = "Mozilla/5.0 (compatible; QuinielaIA/2.0)";
const FF = "https://www.futbolfantasy.com";

export async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", "Cache-Control": "no-cache" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  return res.text();
}

export function decodeEntities(t: string): string {
  return t
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&aacute;/gi, "á").replace(/&eacute;/gi, "é").replace(/&iacute;/gi, "í")
    .replace(/&oacute;/gi, "ó").replace(/&uacute;/gi, "ú").replace(/&ntilde;/gi, "ñ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/* ───────────────────────── Resultados de la temporada ───────────────────────── */

/** Lee la página de calendario de futbolfantasy y devuelve todos los partidos terminados. */
export function parseCalendar(html: string, league: League): Result[] {
  const out: Result[] = [];
  const re = /Jornada\s+(\d+)\s*<\/h3>|<a href="([^"]*)"\s+class="partido\s+terminado\s*"\s+data-tooltip="([^"]+)"/g;
  let round = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) {
      round = Number(m[1]);
      continue;
    }
    const tip = decodeEntities(m[3]).trim();
    const mm = tip.match(/^(.+?)\s+(\d+)-(\d+)\s+(.+)$/);
    if (!mm || !round) continue;
    out.push({ league, round, home: mm[1].trim(), away: mm[4].trim(), hg: Number(mm[2]), ag: Number(mm[3]), url: m[2] || undefined });
  }
  return out;
}

/**
 * Resultados de la temporada en curso (jornadas 1..N) y de la anterior (jornadas ≤ 0,
 * desplazadas para que el modelo las vea como "más antiguas"). Así el modelo tiene datos
 * fiables desde la primera jornada de la temporada y no solo con 12 partidos por equipo.
 */
export async function fetchResults(withPrevious = true, now = new Date()): Promise<Result[]> {
  const endYear = now.getUTCMonth() >= 6 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  const one = async (league: League, slug: string, year?: number) => {
    const html = await fetchText(`${FF}/${slug}/calendario${year ? `/${year}` : ""}`);
    return parseCalendar(html, league);
  };
  const tasks: Promise<Result[]>[] = [one("laliga", "laliga"), one("laliga2", "laliga2")];
  if (withPrevious) tasks.push(one("laliga", "laliga", endYear - 1), one("laliga2", "laliga2", endYear - 1));
  const [a, b, pa, pb] = await Promise.all(tasks.map((t) => t.catch(() => [] as Result[])));
  const shift = (rs: Result[] | undefined) => {
    if (!rs?.length) return [];
    const max = Math.max(...rs.map((r) => r.round));
    return rs.map((r) => ({ ...r, round: r.round - max - 4 })); // hueco de 4 "jornadas" por el verano
  };
  return [...shift(pa), ...shift(pb), ...a, ...b];
}

/* ───────────────────────── Jugadores (goleadores) ───────────────────────── */

export function parsePlayers(html: string): PlayerStat[] {
  const out: PlayerStat[] = [];
  const parts = html.split(/<tr data-posicion=/).slice(1);
  for (const p of parts) {
    const head = p.slice(0, 600);
    const name = head.match(/data-name="\s*([^"]+)"/)?.[1];
    const position = head.match(/^"([^"]*)"/)?.[1] ?? "";
    const num = (k: number) => Number(p.match(new RegExp(`data-${k}-total="(-?\\d+)"`))?.[1] ?? 0);
    const team = p.match(/class="player-equipo">[\s\S]*?<span>([^<]+)<\/span>/)?.[1]?.trim();
    if (!name || !team) continue;
    out.push({
      name: decodeEntities(name).trim(),
      team: decodeEntities(team),
      position,
      games: num(1),
      minutes: num(2),
      goals: num(3),
      assists: num(4),
    });
  }
  return out;
}

export async function fetchPlayers(): Promise<PlayerStat[]> {
  return parsePlayers(await fetchText(`${FF}/analytics/estadisticas`));
}

/* ───────────────────────── Lesionados y sancionados ───────────────────────── */

const INJ_SOURCES: { url: string; kind: Absence["kind"] }[] = [
  { url: `${FF}/laliga/lesionados`, kind: "Lesión" },
  { url: `${FF}/laliga/sancionados`, kind: "Sanción" },
  { url: `${FF}/laliga2/lesionados`, kind: "Lesión" },
  { url: `${FF}/laliga2/sancionados`, kind: "Sanción" },
];

function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, "\n"),
  );
}

/** `teams` = lista de equipos conocidos (de los resultados), que actúan como cabeceras de sección. */
export function parseAbsences(html: string, kind: Absence["kind"], teams: string[]): Absence[] {
  const lines = stripHtml(html).split("\n").map((l) => l.trim()).filter(Boolean);
  const start = lines.findIndex((l) => l === "Eventos");
  if (start < 0) return [];
  const headers = new Set(teams);
  const out: Absence[] = [];
  let team = "";
  let buf: string[] = [];
  const flush = () => {
    if (buf.length < 3 || !team) return;
    const i = /^\d+%$/.test(buf[0]) ? 1 : 0;
    const player = buf[i];
    const reason = buf[i + 1] ?? "";
    const status = buf.find((l) => /^(Baja|Duda|Disponible|Sancionado|Apercibido)/i.test(l)) ?? "";
    if (player) out.push({ team, player, kind, reason, status });
  };
  for (const l of lines.slice(start + 1)) {
    if (headers.has(l)) {
      flush();
      buf = [];
      team = l;
      continue;
    }
    if (/^\d+%$/.test(l)) {
      flush();
      buf = [l];
      continue;
    }
    if (/^(Parte médico|Noticia|Situación|Eventos)$/i.test(l) || l.length > 200) continue;
    buf.push(l);
  }
  flush();
  return out;
}

export async function fetchAbsences(teams: string[]): Promise<Absence[]> {
  const all: Absence[] = [];
  await Promise.all(
    INJ_SOURCES.map(async (s) => {
      try {
        all.push(...parseAbsences(await fetchText(s.url), s.kind, teams));
      } catch {
        /* si una fuente falla seguimos con las demás */
      }
    }),
  );
  return all;
}

/* ───────────────────────── Quién marcó en cada partido ───────────────────────── */

export type MatchScorers = { home: string[]; away: string[] }; // un nombre por gol

export function parseMatchScorers(html: string): MatchScorers {
  const i = html.indexOf("goleadores_wrapper");
  if (i < 0) return { home: [], away: [] };
  const block = html.slice(i, i + 4000);
  const cut = block.indexOf("goleadores visitante");
  const names = (t: string) => [...t.matchAll(/class="jugador">([^<]+)</g)].map((m) => decodeEntities(m[1]).trim());
  return cut < 0 ? { home: names(block), away: [] } : { home: names(block.slice(0, cut)), away: names(block.slice(cut)) };
}

/** Descarga las fichas de partido pedidas (solo las que no están ya en `cache`). Los partidos terminados no cambian. */
export async function fetchMatchScorers(
  urls: string[],
  cache: Record<string, MatchScorers> = {},
  concurrency = 6,
): Promise<Record<string, MatchScorers>> {
  const todo = [...new Set(urls)].filter((u) => !cache[u]);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const u = todo[next++];
      try {
        cache[u] = parseMatchScorers(await fetchText(u));
      } catch {
        /* si una ficha falla, ese partido no cuenta para las rachas */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  return cache;
}

/* ───────────────────────── Titulares de prensa (futbolfantasy y Marca) ───────────────────────── */

export type Headline = { src: string; title: string };

const NEWS_SOURCES: { src: string; url: string }[] = [
  { src: "FutbolFantasy", url: FF + "/" },
  { src: "FutbolFantasy", url: FF + "/laliga2" },
  { src: "Marca", url: "https://www.marca.com/futbol/primera-division.html" },
  { src: "Marca", url: "https://www.marca.com/futbol/segunda-division.html" },
];

export function extractHeadlines(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const l of stripHtml(html).split("\n").map((x) => x.trim())) {
    if (l.length < 25 || l.length > 200 || seen.has(l)) continue;
    if (/^https?:/i.test(l) || /cookie|privacidad|publicidad|suscr[ií]bete|aviso legal/i.test(l)) continue;
    if (!/[a-záéíóúñ]/.test(l) || !l.includes(" ") || /[{};]/.test(l)) continue;
    seen.add(l);
    out.push(l);
  }
  return out;
}

export async function fetchHeadlines(teams: string[]): Promise<Record<string, Headline[]>> {
  const all: Headline[] = [];
  await Promise.all(
    NEWS_SOURCES.map(async (s) => {
      try {
        for (const title of extractHeadlines(await fetchText(s.url))) all.push({ src: s.src, title });
      } catch {
        /* una fuente caída no impide el resto (Marca puede bloquear según la IP) */
      }
    }),
  );
  const by: Record<string, Headline[]> = {};
  for (const team of teams) {
    const esc = team.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[^\\p{L}])${esc}([^\\p{L}]|$)`, "iu");
    const hit = all.filter((h) => re.test(h.title)).slice(0, 4);
    if (hit.length) by[team] = hit;
  }
  return by;
}

/* ───────────────────────── Jornada de la Quiniela (SELAE) ───────────────────────── */

const QUINIELA_HOME = "https://www.eduardolosilla.es/quiniela/";
const QUINIELA_JORNADA = "https://www.eduardolosilla.es/quiniela/ayudas/escrutinio/jornada_";

export type Jornada = {
  name: string; matches: Fixture[]; pleno15: { home: string; away: string };
  num?: number; market?: Market | null; closing?: number; escrutada?: number;
};
type Page = Jornada & { state: { jornada: number; closing: number } | null };

export function parseJornadaPage(html: string): Page {
  const titleMatch = html.match(/Jornada\s+(\d+)/i);
  const byN = new Map<number, Fixture>();
  const re = /<p[^>]*class="[^"]*c-equipos[^"]*"[^>]*title="([^"]+)"[\s\S]*?<span[^>]*aria-label="Partido número\s+(\d+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const n = Number(m[2]);
    if (!Number.isInteger(n) || n < 1 || n > 15 || byN.has(n)) continue;
    const [home, away] = decodeEntities(m[1]).split(/\s+-\s+/).map((s) => s.trim());
    if (home && away) byN.set(n, { n, home, away });
  }
  const list = [...byN.values()].sort((a, b) => a.n - b.n);
  const j = html.match(/&q;jornada&q;:(\d+)/);
  const fin = html.match(/&q;fechaFinApuestas&q;:(\d+)/);
  const fj = html.match(/&q;fechaJornada&q;:(\d+)/);
  const state = j ? { jornada: Number(j[1]), closing: Number(fin?.[1] ?? fj?.[1] ?? 0) * 1000 } : null;
  const p15 = list.find((f) => f.n === 15);
  const num = titleMatch ? Number(titleMatch[1]) : state?.jornada;
  const gen = parseState(html)?.datosGeneralesQuiniela;
  return {
    num,
    market: num ? parseMarket(html, num) : null,
    closing: state && state.jornada === num ? state.closing : 0,
    escrutada: Number(gen?.ultimaJornadaEscrutada?.jornada) || 0,
    name: titleMatch ? `Jornada ${titleMatch[1]}` : "Jornada actual",
    matches: list.filter((f) => f.n <= 14),
    pleno15: p15 ? { home: p15.home, away: p15.away } : { home: "—", away: "—" },
    state,
  };
}

async function fetchPage(url: string): Promise<Page> {
  const page = parseJornadaPage(await fetchText(`${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`));
  if (page.matches.length < 14) throw new Error(`Solo se han detectado ${page.matches.length} partidos. La web de SELAE puede haber cambiado.`);
  return page;
}

/** La home a veces se queda con la jornada anterior: si ya cerró apuestas, probamos la siguiente. */
export async function fetchJornada(): Promise<Jornada> {
  const home = await fetchPage(QUINIELA_HOME);
  if (home.state && home.state.closing > 0 && home.state.closing < Date.now()) {
    try {
      const next = await fetchPage(`${QUINIELA_JORNADA}${home.state.jornada + 1}`);
      if (Number(next.name.replace(/\D/g, "")) === home.state.jornada + 1) return { ...next, closing: 0 };
    } catch {
      /* nos quedamos con la home */
    }
  }
  return home;
}

/** Página de escrutinio de una jornada concreta (para leer sus marcadores). */
export async function fetchJornadaHtml(j: number): Promise<string> {
  return fetchText(`${QUINIELA_JORNADA}${j}?_=${Date.now()}`);
}
