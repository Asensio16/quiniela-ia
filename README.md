# Quiniela IA · Estanco Nº5 Águilas (versión 2, sin Lovable)

Web de pronósticos de La Quiniela. **No depende de Lovable, de Supabase ni de ningún servidor de pago.**
Un generador (Node) lee los datos, calcula los pronósticos y escribe `docs/quiniela.json`;
la web estática `docs/index.html` solo lo muestra. GitHub lo regenera solo cada 3 horas y lo publica gratis.

## Qué hace (y qué no)
- **Datos reales:** partidos de la jornada (eduardolosilla.es) y, de futbolfantasy.com, resultados de esta temporada y de la anterior (1ª y 2ª), goles de cada jugador, lesionados y sancionados, titulares de prensa y **quién marcó en cada uno de los últimos 6 partidos** de cada equipo.
- **Goleadores en racha 🔥 y en sequía 🧊:** en racha = 3 goles en los últimos 5 partidos (o 2 en los últimos 3); en sequía = goleador de la temporada (≥3 goles, solo Primera, que es donde hay estadísticas por jugador) sin marcar en los últimos 6. En Segunda solo se detectan rachas.
- **Prensa:** lee titulares de FutbolFantasy y, si le deja, de Marca (a veces bloquea a los programas; si falla se ignora). Sport bloquea siempre. Nunca se intenta saltar un bloqueo.
- **Modelo estadístico propio** (`src/engine.ts`): ataque y defensa de cada equipo, ventaja de campo, rachas (últimos 5), bajas de goleadores → probabilidad de 1/X/2, goles esperados, marcador probable y Pleno al 15.
- **Dos boletos:** *seguro* (el signo más probable, con dobles solo en los 4 partidos más abiertos) y *con sorpresas* 💎 (2-3 signos poco jugados pero con probabilidad real, para que el premio se reparta entre menos gente). El % de gente que juega cada signo es una **estimación**, no el dato real de SELAE.
- **Botón «Generar combinación» 🎲:** como en la versión de Lovable, cada pulsación da una combinación distinta. Parte del boleto seguro y cambia unos pocos signos (1-2, 2-4 o 4-6 según el nivel), con más probabilidad en los partidos más abiertos, y nunca repite una ya salida. Funciona en la propia tablet, sin servidor.
- **IA opcional** (Gemini gratis o Claude): redacta las frases y estima los partidos sin datos (selecciones, fútbol femenino). Sin clave, todo funciona igual con textos automáticos.
- **Honestidad:** `npm run backtest` predice cada jornada ya jugada usando solo lo anterior. Resultado actual (216 partidos): **51 % de signos acertados** (siempre «1» = 44 %), 72 % contando el segundo signo de los dobles. Sin la temporada anterior bajaba al 45 %. La Quiniela sigue siendo azar.
- Los partidos de **selecciones y fútbol femenino** no tienen datos: salen con probabilidades genéricas (o estimadas por la IA si hay clave).

## Novedades (noviembre 2026)

- **Cuotas de las casas de apuestas** (publicadas por eduardolosilla.es): el pronóstico es 85 % cuotas + 15 % modelo propio (`MARKET_WEIGHT` en `src/pipeline.ts`). Medido con `npx tsx scripts/backtest-market.ts` sobre las jornadas 1-20 de la 2026-27: en los 141 partidos con las dos cosas, el modelo solo da logloss 0,981 (53,9 % de acierto) y las cuotas 0,935 (54,6 %); en los 139 partidos que el modelo no cubre (selecciones, femenino, Europa) las cuotas aciertan el 62,6 % (siempre «1»: 41,7 %).
- **Porcentaje real apostado** (dato de Loterías): las sorpresas 💎 buscan signos con probabilidad real que juega poca gente.
- **Marcador de aciertos**: `docs/history.json` guarda el boleto de cada jornada antes del cierre y, tras el escrutinio, sus aciertos.
- **PIN por aparato**: el hash está en `docs/index.html` (`PIN_HASH`, SHA-256 de `PIN_SALT` + PIN). Es un freno, no una caja fuerte: la web y `quiniela.json` son públicos.
- **Boleto en grande** para validar en el mostrador, y botón de instalar la app.

## Publicarla gratis (una sola vez)
1. Sube todo el contenido de esta carpeta a un repositorio **público** de GitHub (rama `main`).
2. En el repositorio: **Settings → Pages → Build and deployment**. En *Source* deja **Deploy from a branch**, y en *Branch* elige **main** y la carpeta **/docs**. Pulsa **Save**.
3. (Opcional, recomendado) Clave de IA gratis en https://aistudio.google.com → *Get API key*. En el repositorio: **Settings → Secrets and variables → Actions → New repository secret**, nombre `GEMINI_API_KEY`.
4. Para que se actualice sola, en **Settings → Actions → General → Workflow permissions** marca **Read and write permissions** y guarda. Después, pestaña **Actions → Actualizar Quiniela IA → Run workflow**.

La web queda en `https://TU-USUARIO.github.io/NOMBRE-DEL-REPOSITORIO/`. Se actualiza sola cada 3 horas; si una actualización falla, la web sigue mostrando la última buena.

## Probarla en tu ordenador
```
npm ci
npm test              # 18 pruebas del motor, nombres, lectura de datos y capa de IA
npm run generate      # crea docs/quiniela.json (usa GEMINI_API_KEY si la defines)
npm run serve         # http://localhost:8080
npm run backtest      # mide el acierto con jornadas ya jugadas
```

## Si algo se rompe
- **Cambia la web de SELAE o de futbolfantasy** y el generador no encuentra los partidos o datos: los lectores están en `src/data.ts` (uno por fuente, con pruebas). Súbeselo a Claude con el error de la pestaña *Actions* y se arregla.
- **Equipo no reconocido** (sale «sin datos» un equipo que sí debería tenerlos): añade el alias en `src/names.ts`.
- **Ajustar el modelo:** parámetros en `src/engine.ts` (`DEFAULT_PARAMS`); `npm run tune` busca los mejores con los datos reales.
