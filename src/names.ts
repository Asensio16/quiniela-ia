// Casa los nombres de la Quiniela (SELAE: "R.MADRID", "AT.MADRID", "ATH.CLUB"…)
// con los nombres que usa futbolfantasy.com ("Real Madrid", "Atlético"…).

export function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

// Alias normalizados -> nombre canónico (el que aparece en futbolfantasy)
const ALIASES: Record<string, string> = {
  rmadrid: "Real Madrid",
  realmadrid: "Real Madrid",
  atmadrid: "Atlético",
  atleticomadrid: "Atlético",
  atletico: "Atlético",
  athclub: "Athletic",
  athleticclub: "Athletic",
  athletic: "Athletic",
  rsociedad: "Real Sociedad",
  realsociedad: "Real Sociedad",
  rsociedadb: "R. Sociedad B",
  realsociedadb: "R. Sociedad B",
  rbetis: "Betis",
  realbetis: "Betis",
  rayovallecano: "Rayo",
  rayo: "Rayo",
  rcelta: "Celta",
  celtavigo: "Celta",
  celtab: "Celta Fortuna",
  celtafortuna: "Celta Fortuna",
  roviedo: "Real Oviedo",
  realoviedo: "Real Oviedo",
  rvalladolid: "Valladolid",
  realvalladolid: "Valladolid",
  deportivo: "Deportivo",
  rcdeportivo: "Deportivo",
  deportivocoruna: "Deportivo",
  rracing: "Racing",
  racing: "Racing",
  racingsantander: "Racing",
  andorrafc: "Andorra",
  fcandorra: "Andorra",
  andorra: "Andorra",
  rsportinggijon: "Sporting",
  sportinggijon: "Sporting",
  sporting: "Sporting",
  udlaspalmas: "Las Palmas",
  laspalmas: "Las Palmas",
  cdtenerife: "Tenerife",
  cdleganes: "Leganés",
  leganes: "Leganés",
  cdeldense: "Eldense",
  cadiz: "Cádiz",
  cadizcf: "Cádiz",
  cordoba: "Córdoba",
  ceutafc: "Ceuta",
  ad: "",
};

export type TeamIndex = {
  canon: string[]; // nombres canónicos conocidos
  byNorm: Map<string, string>;
};

export function buildTeamIndex(teams: string[]): TeamIndex {
  const byNorm = new Map<string, string>();
  for (const t of teams) byNorm.set(norm(t), t);
  return { canon: [...new Set(teams)], byNorm };
}

export type Resolved =
  | { ok: true; team: string }
  | { ok: false; reason: "femenino" | "seleccion" | "desconocido" };

// Selecciones habituales en el Pleno al 15 / partidos internacionales
const NATIONAL = new Set(
  [
    "españa", "inglaterra", "francia", "alemania", "italia", "portugal", "bélgica", "belgica", "holanda",
    "países bajos", "croacia", "suiza", "dinamarca", "suecia", "noruega", "polonia", "austria", "escocia",
    "gales", "irlanda", "turquía", "grecia", "serbia", "ucrania", "república checa", "rep. checa", "hungría",
    "eslovaquia", "eslovenia", "rumanía", "albania", "bosnia", "finlandia", "islandia", "israel",
    "brasil", "argentina", "uruguay", "colombia", "méxico", "mexico", "eeuu", "estados unidos", "japón", "marruecos",
  ].map(norm),
);

export function resolveTeam(raw: string, idx: TeamIndex): Resolved {
  if (/\(\s*f\s*\)/i.test(raw)) return { ok: false, reason: "femenino" };
  const key = norm(raw.replace(/\(.*?\)/g, ""));
  if (NATIONAL.has(key)) return { ok: false, reason: "seleccion" };

  const direct = idx.byNorm.get(key);
  if (direct) return { ok: true, team: direct };

  const alias = ALIASES[key];
  if (alias && idx.byNorm.has(norm(alias))) return { ok: true, team: idx.byNorm.get(norm(alias))! };

  // Búsqueda por contención, evitando confundir filiales ("... B") con el primer equipo
  const isB = /b$/.test(key) && key.length > 3;
  const candidates = idx.canon.filter((c) => {
    const k = norm(c);
    const cIsB = /b$/.test(k) && k.length > 3;
    if (isB !== cIsB) return false;
    return k.includes(key) || key.includes(k);
  });
  if (candidates.length === 1) return { ok: true, team: candidates[0] };
  if (candidates.length > 1) {
    candidates.sort((a, b) => Math.abs(norm(a).length - key.length) - Math.abs(norm(b).length - key.length));
    return { ok: true, team: candidates[0] };
  }
  return { ok: false, reason: "desconocido" };
}
