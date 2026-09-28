---
name: create-video
description: Crea videos para Neto usando Editor Pro Max (Remotion). Ver skill universal en C:\Vortik.dev\.claude\skills\create-video\ para el stack completo.
allowed_tools: Bash, Read, Write, Edit, Glob, Grep
---

# Crear Video — Neto

> El stack completo de Remotion está documentado en el skill universal:
> `C:\Vortik.dev\.claude\skills\create-video\SKILL.md`
> Leerlo siempre — tiene el catálogo de herramientas, AI pipeline, scripts y flujo base.

Editor Pro Max: `C:\Vortik.dev\tools\editor-pro-max`

## Contexto específico de Neto

- **Brand preset:** `src/presets/neto.ts` — SIEMPRE usar `NETO.colors.*`, nunca hardcodear
- **Composiciones:** `src/compositions/Neto*.tsx`
- **Output final:** `C:\Vortik.dev\products\neto\content\reels\<nombre>.mp4`
- **Antes del .tsx:** guion verificado (paso 1b de la universal) en `content/content-lab/guiones/<slug>.md` y `node content/scripts/verify-claims.mjs` en verde
- **Root.tsx:** registrar dentro de `<Folder name="Neto">`

### Música recomendada para Neto
- `music-corporate.mp3` → demos positivos, features, hooks de producto
- `music-dark.mp3` → urgencia, problema financiero del usuario
- `music-epic.mp3` → logo reveal, CTA final

### Paleta Neto
```
NETO.colors.green  = "#1D9E75"   ← accent principal
NETO.colors.bg     = fondo oscuro
NETO.colors.amber  = valores destacados / warnings
NETO.colors.red    = alertas (solo hardcodear este)
```
Fuentes: Poppins (títulos), Inter (cuerpo)

## Estándares visuales validados (NO saltarse)

- Layout vertical 1080×1920: `justifyContent: "center"` + `padding: "300px 40px 420px"` (zonas seguras de la universal; con 40px arriba y abajo el contenido queda bajo la UI de IG/TikTok)
- Texto mínimo: 24px body · 38px títulos · 36px valores
- Timing mínimo: 6-8s escenas densas · 4-6s hook y CTA
- Datos del USUARIO en pantalla (montos, gastos, score): ficticios pero coherentes (ingresos > gastos, score mejorando)
- Cifras del MUNDO REAL ("7 de cada 10 peruanos..."): con fuente abierta en la sesión, nunca inventadas
- Lo que Neto HACE: solo lo que permite `content/README.md` y el guard. Ej.: Neto lee correos de bancos (Pro, opt-in), no "conecta bancos"; no hay plan gratis permanente, lo gratis para siempre es registrar gastos
- Sin precios en el reel
- `<Sequence>` SOLO a nivel de escena completa, nunca dentro de flex containers

## Helpers probados
```tsx
const fadeSlideUp = (frame: number, start: number, dur = 15) => ({
  opacity: interpolate(frame, [start, start + dur], [0, 1], {extrapolateLeft:"clamp", extrapolateRight:"clamp"}),
  transform: `translateY(${interpolate(frame, [start, start+dur], [30, 0], {extrapolateLeft:"clamp", extrapolateRight:"clamp"})}px)`,
});

const fadeIn = (frame: number, start: number, dur = 12) =>
  interpolate(frame, [start, start+dur], [0, 1], {extrapolateLeft:"clamp", extrapolateRight:"clamp"});
```

## Checklist pre-entrega
- [ ] TypeScript sin errores: `cd "C:\Vortik.dev\tools\editor-pro-max" && npx tsc --noEmit`
- [ ] Stills verificados visualmente (1 por escena, al final de cada escena)
- [ ] Centrado vertical correcto en cada escena
- [ ] Timing adecuado (escenas densas ≥ 6s)
- [ ] Datos del usuario ficticios y coherentes; cifras reales con fuente
- [ ] `verify-claims.mjs` en verde
- [ ] Español correcto (tildes, ¿¡, ñ), tuteo peruano
- [ ] Brand Neto (NETO.colors.*, Poppins/Inter, logo visible)
- [ ] CTA con app.neto.pe o WhatsApp
- [ ] Master con loudnorm -14 LUFS
- [ ] MP4 en `C:\Vortik.dev\products\neto\content\reels\`
