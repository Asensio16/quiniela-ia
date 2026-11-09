// Datos "de mercado" que publica eduardolosilla.es para cada jornada, dentro del estado de la página:
//  · real        → probabilidades que salen de las cuotas de las casas de apuestas (Betfair)
//  · lae         → porcentaje real apostado a cada signo en la Quiniela (dato oficial de Loterías)
//  · quinielista → lo que juegan los usuarios de esa web
// Sirven para tres cosas: afinar el pronóstico (las cuotas aciertan más que cualquier modelo casero),
// saber qué signos juega poco la gente (sorpresas con premio) y cubrir selecciones y fútbol femenino.
import type { Probs } from "./types";

export type Goals4 = [number, number, number, number]; // 0, 1, 2, M (más de 2) — suma 1

export type Market = {
  jornada: number;
  temporada: number;
  real: Record<number, Probs>;
  lae: Record<number, Probs>;
  quinielista: Record<number, Probs>;
  pleno: { real?: { h: Goals4; a: Goals4 }; lae?: { h: Goals4; a: Goals4 } };
  escrutada: number; // última jornada con escrutinio oficial
  closing: number; // cierre de apuestas (ms) de la jornada en venta
};

type Any = Record<string, any>;

/** Estado (JSON) que la web Angular deja incrustado en el HTML. */
export function parseState(html: string): Any | null {
  const m = html.match(/<script[^>]*id="eduardo-losilla-state"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  const txt = m[1].replace(/&q;/g, '"').replace(/&s;/g, "'").replace(/&l;/g, "<").replace(/&g;/g, ">").replace(/&a;/g, "&");
  try { return JSON.parse(txt); } catch { return null; }
}

function probs(row: Any | undefined): Probs | null {
  if (!row) return null;
  const a = Number(row.porc_1_dec ?? row.porc_1), x = Number(row.porc_X_dec ?? row.porc_X), b = Number(row.porc_2_dec ?? row.porc_2);
  const t = a + x + b;
  if (![a, x, b].every((v) => Number.isFinite(v) && v >= 0) || t < 90 || t > 110 || Math.max(a, x, b) >= 99.5) return null;
  return { p1: a / t, px: x / t, p2: b / t };
}

function goals(row: Any | undefined): { h: Goals4; a: Goals4 } | undefined {
  if (!row) return undefined;
  const side = (s: "L" | "V"): Goals4 | null => {
    const v = ["0", "1", "2", "M"].map((k) => Number(row[`porc_15${s}_${k}_dec`] ?? row[`porc_15${s}_${k}`]));
    const t = v.reduce((p, c) => p + c, 0);
    if (!v.every((n) => Number.isFinite(n) && n >= 0) || t < 90 || t > 110) return null;
    return v.map((n) => n / t) as Goals4;
  };
  const h = side("L"), a = side("V");
  return h && a ? { h, a } : undefined;
}

/** Porcentajes de la jornada pedida (si la página los trae). */
export function parseMarket(html: string, jornada: number): Market | null {
  const st = parseState(html);
  if (!st) return null;
  const gen: Any = st.datosGeneralesQuiniela ?? {};
  let block: Any | undefined;
  const all: Any = { ...(st.probabilidades ?? {}) };
  for (const k of Object.keys(st)) if (/^probabilidades_\d+_\d+$/.test(k)) all[k] = st[k];
  for (const v of Object.values(all) as Any[]) if (Number(v?.numJornada) === jornada) block = v;
  if (!block?.partidos) return null;
  const out: Market = {
    jornada, temporada: Number(block.numTemporada) || 0, real: {}, lae: {}, quinielista: {}, pleno: {},
    escrutada: Number(gen.ultimaJornadaEscrutada?.jornada) || 0,
    closing: (Number(gen.fechaFinApuestas) || 0) * 1000,
  };
  for (const kind of ["real", "lae", "quinielista"] as const) {
    for (const row of (block.partidos[kind] ?? []) as Any[]) {
      const n = Number(row.numero);
      if (n >= 1 && n <= 14) { const p = probs(row); if (p) out[kind][n] = p; }
      else if (n === 15 && kind !== "quinielista") out.pleno[kind] = goals(row);
    }
  }
  return out;
}

/** Marcadores que muestra la página de escrutinio de una jornada: nº de partido → [goles local, goles visitante]. */
export function parseScores(html: string): Record<number, [number, number]> {
  const out: Record<number, [number, number]> = {};
  const re = /aria-label="Partido número\s+(\d+)"([\s\S]*?)(?=aria-label="Partido número|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const n = Number(m[1]);
    if (n < 1 || n > 15 || out[n]) continue;
    const s = m[2].match(/c-marcador-horario__match__score[^>]*>\s*(\d+)\s*-\s*(\d+)\s*</);
    if (s) out[n] = [Number(s[1]), Number(s[2])];
  }
  return out;
}

/** Mezcla lineal modelo + mercado. w = peso del mercado. */
export function blend(model: Probs, market: Probs | undefined, w: number): Probs {
  if (!market) return model;
  const p = { p1: (1 - w) * model.p1 + w * market.p1, px: (1 - w) * model.px + w * market.px, p2: (1 - w) * model.p2 + w * market.p2 };
  const t = p.p1 + p.px + p.p2;
  return { p1: p.p1 / t, px: p.px / t, p2: p.p2 / t };
}
