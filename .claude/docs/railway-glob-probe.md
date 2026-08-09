# Sonda de globs de Railway — este archivo ES el instrumento

No borres este archivo por parecer inerte. **Su RUTA es el experimento**, no su contenido.
`.claude/docs/railway-glob-probe.md` está elegida para que dos lecturas posibles de
`build.watchPatterns` (`railway.json`) predigan cosas **opuestas** sobre ella.

## Qué mide

La lista declara `!docs/**`. La pregunta es cómo matchea Railway ese `dir/**`:

| lectura | qué excluye | veredicto sobre esta ruta |
|---|---|---|
| **prefijo** (`startsWith`) — lo que el modelo asume | solo lo que CUELGA de `docs/` en la raíz | observado → **Railway construye** |
| **subcadena** (`includes`) | cualquier ruta que CONTENGA `docs/` | excluido → **`No changes to watched files`** |

Esta ruta lleva `docs/` en el medio, no al principio. Es la única forma de separarlas, y en
todo el árbol **no existe otro archivo que lo haga** (`git ls-files | grep -E '.+/(docs|webapp|qa-e2e)/'`
sale vacío). Por eso hubo que crear uno: sin él la distinción es inobservable, y
`qa-e2e/backend-watchpatterns-real.mjs` pasaba en verde con la mutación `startsWith`→`includes`
puesta.

## Por qué la inferencia cierra

Los otros dos segmentos de la ruta no son supuestos: están medidos, y con el mismo método.

- **`.claude/` está OBSERVADO** — no aparece en ninguna exclusión de `railway.json`.
- **Un `.md` ANIDADO está observado**: `!/*.md` **ancla a la raíz**, medido el 08-ago-2026 con
  el deploy de control `00dd65d`, que tocó solo `.claude/commands/deploy.md` y Railway
  construyó. Ver la sección de `railway.json` en `CLAUDE.md`.

O sea que si Railway **saltea** un commit que toca solo este archivo, no queda ninguna otra
explicación disponible: tiene que ser `!docs/**` matcheando en el medio de la ruta. Y si
**construye**, el modelo de prefijo es el correcto.

## Cómo re-correrlo

```bash
# 1. base limpia: que el commit desplegado sea HEAD, o que el diff acumulado no traiga observados
curl -s https://api.neto.pe/version
# 2. tocar SOLO este archivo, commit y push
# 3. leer el estado TERMINAL por API (unos segundos aparece BUILDING antes de resolver a SKIPPED)
#    lo que manda es meta.skippedReason + meta.imageDigest — el curl está en CLAUDE.md
# 4. el modelo, contra los deployments reales
NETO_WP_VENTANA=100 node qa-e2e/backend-watchpatterns-real.mjs
```

**Cuesta un reinicio del backend de WhatsApp (~30s) si construye**, así que no se corre en
horario pico. Medí la actividad antes (`count(*)` de `transacciones` en los últimos 30 min),
no la supongas.

## Resultado

Pendiente: este archivo se commitea ANTES de conocerlo, a propósito — la predicción queda
registrada en el historial de git antes de la medición, no después. Lo llena el commit
siguiente.
