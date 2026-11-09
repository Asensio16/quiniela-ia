export type League = "laliga" | "laliga2";

/** Un partido ya jugado. */
export type Result = {
  league: League;
  round: number;
  home: string;
  away: string;
  hg: number;
  ag: number;
  url?: string; // ficha del partido (para leer quién marcó)
};

export type Fixture = { n: number; home: string; away: string };

export type PlayerStat = {
  name: string;
  team: string;
  position: string;
  games: number;
  minutes: number;
  goals: number;
  assists: number;
};

export type Absence = {
  team: string;
  player: string;
  kind: "Lesión" | "Sanción";
  reason: string;
  status: string; // "Baja", "Duda"…
};

export type Probs = { p1: number; px: number; p2: number };

export type Sign = "1" | "X" | "2";

export type MatchPrediction = {
  n: number;
  home: string;
  away: string;
  covered: boolean; // ¿hay datos estadísticos de los dos equipos?
  priced: boolean; // ¿hay probabilidades de verdad (modelo o cuotas)? Si no, son genéricas
  modelProbs?: Probs; // solo el modelo propio, en %
  marketProbs?: Probs; // solo las cuotas de las casas de apuestas, en %
  publicPct?: Probs; // % de apuestas que se lleva cada signo
  publicSrc?: "lae" | "quinielista" | "estimado"; // de dónde sale publicPct
  league?: League;
  probs: Probs; // en %
  pick: Sign;
  alt?: Sign; // segundo signo si conviene doble
  advice: "fijo" | "doble" | "triple";
  confidence: number; // 0-100 (probabilidad del signo elegido)
  xgHome: number;
  xgAway: number;
  likelyScore: string;
  over25: number; // % de más de 2.5 goles
  btts: number; // % ambos marcan
  formHome: string[]; // "G" | "E" | "P" últimos 5 (más reciente primero)
  formAway: string[];
  posHome?: number;
  posAway?: number;
  reasoning: string;
  scorers: { player: string; team: string; goals: number; perGame: number; chance: number; out?: string; tag?: "racha" | "sequia"; recent?: number; window?: number; note?: string }[];
  news: { src: string; title: string }[]; // titulares de prensa de estos equipos
  absences: { team: string; player: string; reason: string }[];
  surprise?: { sign: Sign; prob: number; value: number }; // signo poco jugado con probabilidad real
  valuePick?: boolean; // el boleto con sorpresas usa este signo en vez del pick
  source: "modelo" | "modelo+ia" | "ia" | "cuotas" | "modelo+cuotas";
};

export type Ticket = {
  signs: string[]; // 14 signos
  expectedHits: number; // aciertos esperados (solo partidos con datos)
  pAll: number; // probabilidad (%) de acertar todos los partidos con datos
  surprises: number[]; // n de partido con sorpresa
};

export type QuinielaResult = {
  jornada: string;
  matches: MatchPrediction[];
  pleno15: {
    home: string;
    away: string;
    homeGoals: "0" | "1" | "2" | "M";
    awayGoals: "0" | "1" | "2" | "M";
    covered: boolean;
    priced?: boolean;
    dist?: { h: number[]; a: number[] }; // prob. de 0,1,2,M goles de cada equipo según las cuotas
    reasoning: string;
  };
  signs: string; // boleto seguro, "1 X 2 ..."
  ticketSafe: Ticket;
  ticketValue: Ticket; // boleto con sorpresas
  distribution: { ones: number; xs: number; twos: number };
  expectedHits: number; // aciertos esperados de 14 según el modelo
  analysis: string;
  confidence: number;
  columns: number; // columnas de la apuesta si se juegan las dobles/triples sugeridas
  generatedAt: string;
  dataAsOf: { lastRound: Record<string, number>; results: number };
  aiUsed: string | null;
  notes: string[];
  source: string;
  num?: number; // número de jornada
  closing?: number; // cierre de apuestas (ms)
  escrutada?: number; // última jornada con escrutinio oficial
  market?: { odds: number; publicSrc: "lae" | "quinielista" | "estimado" }; // nº de partidos con cuotas y origen del % apostado
  record?: Record_;
};

/** Marcador de aciertos: jornadas ya jugadas y simulación previa. */
export type RecordEntry = {
  j: number; temporada?: number; savedAt: string;
  safe: string[]; value: string[]; pleno: string;
  results?: string[]; score15?: string; hitsSafe?: number; hitsValue?: number; plenoHit?: boolean; played?: number;
};
export type Record_ = {
  entries: RecordEntry[];
  sim?: { from: number; to: number; avg: number; best: number; worst: number; jornadas: number };
};
