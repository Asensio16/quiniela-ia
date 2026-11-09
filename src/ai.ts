// Capa de IA OPCIONAL. Los pronósticos los calcula el motor estadístico (engine.ts); la IA solo
//  1) redacta una frase por partido con los datos que le pasamos,
//  2) estima los partidos SIN datos estadísticos (selecciones, fútbol femenino…), marcados como estimación,
//  3) redacta el análisis general.
// Si no hay clave o falla, la web sigue funcionando con los textos automáticos del motor.

export type Env = { GEMINI_API_KEY?: string; ANTHROPIC_API_KEY?: string; AI_MODEL?: string };

export type AiMatchInput = {
  n: number;
  home: string;
  away: string;
  covered: boolean;
  summary: string; // datos del motor ya resumidos
  headlines: string[];
};

export type AiInput = {
  jornada: string;
  matches: AiMatchInput[];
  pleno15: AiMatchInput;
};

export type AiOutput = {
  reasons: Record<number, string>;
  guesses: Record<number, { p1: number; px: number; p2: number; reasoning?: string }>;
  pleno?: { homeGoals?: string; awayGoals?: string; reasoning?: string };
  analysis?: string;
};

const SYSTEM = `Eres el analista de "Quiniela IA", la herramienta del Estanco Nº5 de Águilas. Escribes en español, claro y directo.
Reglas:
- Para los partidos con "datos" usa SOLO la información que te paso (probabilidades del modelo, forma, bajas, goleadores, titulares). No inventes lesiones, alineaciones ni estadísticas.
- No cambies los signos ni las probabilidades del modelo: tu trabajo es explicarlos en UNA frase breve (máx. 25 palabras) y mencionar la baja o el goleador más relevante si lo hay.
- Para los partidos marcados SIN DATOS (selecciones, fútbol femenino u otros sin estadísticas) da tu mejor estimación de probabilidades 1/X/2 (enteros que sumen 100) con tu conocimiento general y di en la frase que es una estimación sin datos del modelo.
- Responde SOLO con JSON válido, sin markdown.`;

export function buildPrompt(input: AiInput): string {
  const lines = input.matches.map((m) => {
    const head = m.headlines.length ? `\n   Titulares: ${m.headlines.join(" | ")}` : "";
    return `${m.n}. ${m.home} vs ${m.away} — ${m.covered ? "CON DATOS" : "SIN DATOS"}\n   ${m.summary}${head}`;
  });
  const p = input.pleno15;
  return `${input.jornada}

Partidos:
${lines.join("\n")}

Pleno al 15: ${p.home} vs ${p.away} — ${p.covered ? "CON DATOS" : "SIN DATOS"}
   ${p.summary}

Devuelve exactamente este JSON:
{
  "reasons": { "1": "frase", "2": "frase", ... "14": "frase" },
  "guesses": { "<n del partido SIN DATOS>": { "p1": 40, "px": 30, "p2": 30, "reasoning": "frase" } },
  "pleno": { "homeGoals": "1", "awayGoals": "1", "reasoning": "frase" },
  "analysis": "2-3 frases sobre la jornada"
}
En "pleno" usa solo "0","1","2" o "M" (M = más de 2 goles). "guesses" solo para partidos SIN DATOS (incluido el pleno si aplica, con clave "15").`;
}

function extractJson(text: string): unknown {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("La IA no devolvió JSON");
  return JSON.parse(text.slice(a, b + 1));
}

export function sanitize(raw: unknown): AiOutput {
  const o = (raw ?? {}) as Record<string, any>;
  const out: AiOutput = { reasons: {}, guesses: {} };
  for (const [k, v] of Object.entries(o.reasons ?? {})) {
    const n = Number(k);
    if (Number.isInteger(n) && typeof v === "string" && v.trim()) out.reasons[n] = v.trim().slice(0, 260);
  }
  for (const [k, v] of Object.entries(o.guesses ?? {})) {
    const n = Number(k);
    const g = v as any;
    const p1 = Number(g?.p1), px = Number(g?.px), p2 = Number(g?.p2);
    if (!Number.isInteger(n) || ![p1, px, p2].every((x) => Number.isFinite(x) && x >= 0)) continue;
    const tot = p1 + px + p2;
    if (tot <= 0) continue;
    out.guesses[n] = {
      p1: (100 * p1) / tot, px: (100 * px) / tot, p2: (100 * p2) / tot,
      reasoning: typeof g.reasoning === "string" ? g.reasoning.trim().slice(0, 260) : undefined,
    };
  }
  const sc = (x: unknown) => (typeof x === "string" && /^[012M]$/.test(x.trim().toUpperCase()) ? x.trim().toUpperCase() : undefined);
  if (o.pleno) out.pleno = { homeGoals: sc(o.pleno.homeGoals), awayGoals: sc(o.pleno.awayGoals), reasoning: typeof o.pleno.reasoning === "string" ? o.pleno.reasoning.slice(0, 260) : undefined };
  if (typeof o.analysis === "string") out.analysis = o.analysis.trim().slice(0, 600);
  return out;
}

async function withTimeout(url: string, init: RequestInit, ms: number, f: typeof fetch): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await f(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function askAI(
  env: Env,
  input: AiInput,
  f: typeof fetch = fetch,
): Promise<{ out: AiOutput | null; provider: string | null; error?: string }> {
  const prompt = buildPrompt(input);
  try {
    if (env.GEMINI_API_KEY) {
      const model = env.AI_MODEL && env.AI_MODEL.startsWith("gemini") ? env.AI_MODEL : "gemini-2.5-flash";
      const res = await withTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM }] },
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.4 },
          }),
        },
        45000,
        f,
      );
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const data: any = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
      return { out: sanitize(extractJson(text)), provider: `Gemini (${model})` };
    }
    if (env.ANTHROPIC_API_KEY) {
      const model = env.AI_MODEL && env.AI_MODEL.startsWith("claude") ? env.AI_MODEL : "claude-haiku-5-5";
      const res = await withTimeout(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model, max_tokens: 4000, system: SYSTEM, messages: [{ role: "user", content: prompt }] }),
        },
        45000,
        f,
      );
      if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const data: any = await res.json();
      const text = (data?.content ?? []).map((c: any) => c.text ?? "").join("");
      return { out: sanitize(extractJson(text)), provider: `Claude (${model})` };
    }
    return { out: null, provider: null };
  } catch (e) {
    return { out: null, provider: null, error: e instanceof Error ? e.message : String(e) };
  }
}
