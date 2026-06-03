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
- **Output final:** `C:\Vortik.dev\products\neto\content\<nombre>.mp4`
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

- Layout: `justifyContent: "center"` + `padding: "40px 40px"` — SIEMPRE
- Texto mínimo: 24px body · 38px títulos · 36px valores
- Timing mínimo: 6-8s escenas densas · 4-6s hook y CTA
- Datos: SIEMPRE ficticios pero coherentes (ingresos > gastos, score mejorando)
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
- [ ] Datos ficticios coherentes en soles
- [ ] Español correcto (tildes, ¿¡, ñ)
- [ ] Brand Neto (NETO.colors.*, Poppins/Inter, logo visible)
- [ ] CTA con app.neto.pe o WhatsApp
- [ ] MP4 en `C:\Vortik.dev\products\neto\content\`
