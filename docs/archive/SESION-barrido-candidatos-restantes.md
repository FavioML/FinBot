# Sesión: cerrar el barrido de fallos silenciosos (candidatos restantes) — CERRADA

**Estado: cerrada el 22-jul-2026, commit `e183494`. No reabrir.**
El registro completo vive en `docs/SESION-fallos-silenciosos.md`; esto es el resumen de qué se
miró, qué salió y cómo se demostró.

---

## Resultado

La expectativa era rendimiento bajo. Salió al revés: **1 bug vivo de 4 meses** y un segundo
hallazgo estructural que ninguno de los cuatro candidatos anunciaba.

| Archivo | Veredicto | Cómo se demostró |
|---|---|---|
| `services/recommendations.js` | **BUG VIVO** | `generarRecomendaciones` llamada directo contra un usuario de producción con 98 txs de julio: devolvía `null` con log `ENOENT ... app\prompts\NETO_recomendaciones_prompt.md`. El prompt se había movido a `docs/` en `7941cb0` (31-mar). Post-fix devuelve una recomendación redactada real. |
| `services/parsers.js` | **SANO** | `parsearCorreccionesMultiples('el menu de 15 pasalo a alimentacion y la gasolina de 40 a transporte')` → 2 correcciones bien parseadas, no `[]`. `interpretarComandoPresupuesto('presupuesto de 500 en alimentacion')` → `{es_presupuesto:true, categoria:'alimentación', monto:500}`, no el fallback. |
| `handlers/intents/score.js` | **SANO** | La llamada a OpenAI de los tips reproducida con el mismo body (`gpt-4o-mini`, `max_tokens:400`, sin `timeout` en el body) → 3 tips generados. Además su fallback no es silencioso: el usuario ve "❌ No pude generar los tips". |
| `services/spending-alerts.js` | **SANO** | `generarAlertasFugas(uid, true)` → 5 alertas reales (spike/recurring/ant) y `generarMensajeFugas` devolvió texto redactado por IA, no ninguno de los dos textos fijos del `catch`. |
| `detectarSuscripciones` (catch ~246) | **SANO** | Llamada directa: 5 suscripciones detectadas, S/297.06/mes. El `catch` nunca se activó. |

## Los dos hallazgos reales

1. **Ruta de prompt muerta** (`recommendations.js`). Tercer caso de la misma familia que `1a5da6e`
   y `6b677cf`. El `catch` que lo tapaba era justamente el candidato de la lista, pero el bug no
   era el `catch`: era la ruta.
2. **`construirDatosUsuario` descartaba los 5 `error`.** No estaba en la lista de candidatos —
   apareció aplicando la lección del 21-22 de julio (mirar el `error`, no el `catch`). Alimenta el
   45% del Neto Score, la viabilidad de metas y las alertas de fugas, y una de las tres formas de
   fallar **sube** el score. Es la puerta que `eea8d1c` dejó abierta.

## Cambios aplicados

- Prompt de recomendaciones cargado al require con throw si falta (doctrina `lib/neto-prompt.js`).
- `construirDatosUsuario` lee sus 5 `error`, loguea con tag `RECOM_DATOS` y lanza.
- `interpretarComandoPresupuesto`: era el único `catch` del backend sin log. Ahora loguea
  (`PARSE_PRESUP`); el fallback se mantiene porque es legítimo.
- `obtenerHistorialAlertas`: loguea el `error` descartado (`FUGAS_HIST`). Devolver `[]` está bien
  acá — no se escribe ni se calcula nada sobre eso — pero sin log no se distinguía de "no tienes".
- `tests/services/recommendations-prompt.test.js` (7 tests). Cubre la **clase**, no la instancia:
  todo prompt que el backend lee tiene que existir donde el código lo busca.

Ambos fixes validados por mutación: revertir la ruta hace fallar los 7 tests con el ENOENT
explícito; revertir el guard de lecturas hace fallar exactamente los 3 tests de lectura caída.

## Verificación

```bash
npx vitest run                        # 426 tests
node qa-e2e/probe-system-prompt.mjs   # 16/16 checks
```

## Lo que queda del barrido original

`docs/SESION-escrituras-sobre-lectura-fallida.md` es lo único abierto de esta línea.
