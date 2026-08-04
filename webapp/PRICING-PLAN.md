# Modelo comercial — Neto (trial 14 días + muro)

**Vigente desde:** 2026-08-01 (sprint trial+muro) · **Reescrito:** 2026-08-04 (auditoría CTO, hallazgo M1)
**Aprobado por:** Favio Mendoza

> Este documento es el RESUMEN comercial. La fuente de verdad ejecutable es el código:
> `lib/trial.js` (predicados y muro) · `handlers/intents-acceso.js` (qué es lectura) ·
> `webapp/src/lib/plan.ts` (espejo webapp) · `lib/constants.js` PLAN_CONFIG (límites).
> Si este doc contradice al código, manda el código y este doc se corrige.
> ⚠️ La versión anterior de este archivo (3-abr-2026) describía un freemium con "Free
> para siempre" que YA NO EXISTE. No revivir esas tablas.

## El modelo en cuatro líneas

1. **No hay plan gratuito permanente.** Todo usuario estrena Pro completo por 14 días
   desde su **primer gasto** (no desde el alta).
2. Al día 15 cae al **muro**: `plan='free'` significa "prueba terminada sin pagar", no un plan.
3. **Escribir nunca se corta; se cobra LEER.** Registrar gastos por WhatsApp (texto, foto
   Yape, audio) es gratis para siempre. Dashboard, historial, reportes, score, presupuestos,
   metas y toda consulta agregada exigen Pro. Sobrevive un solo número: el total del mes,
   pegado a la confirmación del gasto.
4. Durante el trial `plan='premium'` y `trial_estado='activo'` — o sea **`plan==='premium'`
   NO significa "paga"**. Las tres preguntas y sus predicados: `enTrial()` (¿probando?),
   `esProPagado()` (¿paga? — MRR), `estaEnMuro()` (¿muro?). Nunca reimplementarlos inline.

## Pricing

| Plan | Precio | Equivalente mensual | Nota |
|------|--------|---------------------|------|
| Prueba | S/0 × 14 días | — | Pro completo, arranca con el primer gasto |
| Pro Mensual | S/10/mes | S/10 | Pago por Yape, aprobación manual |
| Pro Anual | S/99/año | S/8.25 | 2 meses gratis |

Fuente de los precios en código: `lib/config.js` PRO_PRECIOS. Cero precios hardcodeados nuevos.

## Qué queda en el muro (plan='free')

| Capacidad | ¿Disponible en el muro? |
|-----------|------------------------|
| Registrar gastos (texto/foto/audio WhatsApp) | ✅ Siempre, gratis para siempre |
| Total del mes junto a la confirmación | ✅ (el único número que sobrevive) |
| Comandos y consultas de lectura (`/mes`, `/resumen`, score, etc.) | ❌ pitch Pro |
| Dashboard web (cualquier página de lectura) | ❌ paywall (402 vía `requireLectura`) |
| Presupuestos / metas | ❌ (`PLAN_CONFIG.free`: 0 y 0 — espejado en `FREE_LIMITS`) |
| Carga masiva Excel/CSV | ❌ (escritura, pero Pro por decisión — única excepción) |

## Pro (trial y pagado entregan LO MISMO, con una excepción)

Todo lo de lectura + features: dashboard completo, historial, reportes PDF/CSV, score con
desglose y tips, calendario, heatmap, suscripciones con alertas, recordatorios, consejo IA,
espacios (modelo "host paga": el plan del OWNER manda), manos libres.

**La única capability que exige Pro PAGADO (ni siquiera trial): conectar Gmail.** Es de
inventario, no comercial — cada cuenta de Google consume uno de los 100 cupos de por vida
pre-CASA. Web-only (una sola puerta: webapp `/dashboard/pro`), UNA cuenta por usuario para
siempre. Detalle completo en el CLAUDE.md del backend.

## Referidos (dos lados)

1 referido que **paga** Pro = 1 mes gratis al referrer (se apila sobre su vencimiento — o
sobre su trial, sellándolo 'convertido'). El referido estrena a **50% off** su primer mes,
ventana de 7 días anclada al FIN de su trial. Sin encadenamiento: el mes del referrer se
otorga directo sin pasar por `activarPro`. Fuente: `services/referrals.js`.

## 11 categorías raíz (para todos)

Alimentación · Transporte · Vivienda · Salud · Entretenimiento · Suscripciones · Compras ·
Educación · Finanzas · Trabajo/Negocio · Otros. ("Suscripciones" separada de
"Entretenimiento"; el detector clasifica ahí automáticamente.)

## Unit economics (referencia 2026-04, revisar contra datos reales)

| Métrica | Muro | Pro Mensual | Pro Anual |
|---------|------|-------------|-----------|
| Ingreso/usuario/mes | S/0 | S/10 | S/8.25 |
| Costo variable/usuario/mes | ~S/0.53 | ~S/3.41 | ~S/3.41 |
| Margen/usuario/mes | −S/0.53 | +S/6.59 | +S/4.84 |

Contexto de negocio vivo (umbrales de escala, CASA, SACS): memory `project_pricing_business`.
