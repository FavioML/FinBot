# Plan Freemium — Neto (Versión Final)

**Fecha:** 26 Mar 2026
**Aprobado por:** Favio Mendoza

---

## Pricing

| Plan | Precio | Equivalente mensual | Ahorro |
|------|--------|---------------------|--------|
| **Free** | S/0 | — | — |
| **Pro Mensual** | S/10/mes | S/10/mes | — |
| **Pro Anual** | S/69/año | S/5.75/mes | 42% (S/51/año) |

---

## Features Free vs Pro

| Feature | Free | Pro |
|---------|------|-----|
| WhatsApp bot (registro, gastos, consultas) | Ilimitado | Ilimitado |
| Lectura automática de gastos | 1 cuenta Gmail | Cuentas ilimitadas |
| Clasificación IA de gastos | Ilimitada | Ilimitada |
| Categorías raíz (11 fijas) | Sí | Sí |
| Categorías personalizadas adicionales | No | Ilimitadas |
| Presupuestos | 3 presupuestos | Ilimitados |
| Dashboard web (app.neto.pe) | Mes actual | Historial completo |
| Resumen diario por WhatsApp | No | Sí |
| Resumen semanal | Básico (total gastado) | Completo (insights + comparativa) |
| Resumen mensual | Sí | Sí |
| Lectura de imágenes Yape/Plin | 5/mes | Ilimitada |
| Reportes PDF descargables | No | Sí |
| Score financiero | Número | Número + desglose + tendencia 4 meses |
| Metas de ahorro | 1 meta | Ilimitadas |
| Calendario financiero | No | Sí |
| Suscripciones detectadas | Todas | Todas + alertas |
| Pagos recurrentes | No | Sí |
| Consejo IA | 1/semana | Diario |
| Export CSV/JSON | No | Sí |
| Carga masiva Excel/CSV | No | Sí |
| Heatmap de gastos | No | Sí |
| Recordatorios diarios (8pm) | No | Sí |
| Multimoneda USD/PEN | Sí | Sí |
| Tipo de cambio widget | Sí | Sí |
| Búsqueda global (Ctrl+K) | Sí | Sí |
| Referidos (3 = 1 mes Pro) | Sí | Sí |

---

## 11 Categorías Raíz (disponibles para todos)

1. Alimentación
2. Transporte
3. Vivienda
4. Salud
5. Entretenimiento
6. Suscripciones
7. Compras
8. Educación
9. Finanzas
10. Trabajo/Negocio
11. Otros

**Nota:** "Suscripciones" es categoría separada de "Entretenimiento". El detector de suscripciones (catálogo 50+ servicios) clasifica automáticamente en esta categoría.

---

## Unit Economics

| Métrica | Free | Pro Mensual | Pro Anual |
|---------|------|-------------|-----------|
| Ingreso/usuario/mes | S/0 | S/10 | S/5.75 |
| Costo variable/usuario/mes | S/0.53 | S/3.41 | S/3.41 |
| Margen/usuario/mes | -S/0.53 | +S/6.59 | +S/2.34 |
| Margen % | -100% | 66% | 41% |

### Costos fijos mensuales (infraestructura)

| Servicio | Costo | Upgrade trigger |
|----------|-------|-----------------|
| Railway Hobby | S/19 | Al lanzar |
| Supabase | S/0 | ~500-1,000 usuarios → S/95/mes |
| Vercel | S/0 | ~2,000-5,000 usuarios → S/76/mes |
| Dominio | S/9.2 | Fijo anual S/110 |
| Total fijo | S/28.2/mes | |

### Break-even: ~100 usuarios con 10% conversión a Pro

---

## Gmail OAuth Constraint (GCC)

**Gmail OAuth = Pro-only feature.** Solo 100 OAuth slots disponibles en Google Cloud Console hasta verificación CASA Tier 2 ($540 USD). Free users NO consumen slots — registran gastos manualmente. Solo Pro users que pagan reciben link OAuth.

**Status actual:** 3/100 slots usados (26 Mar 2026).

---

## Upgrade Triggers

| Momento | Mensaje |
|---------|---------|
| Intenta agregar 2da cuenta Gmail | "Conecta todos tus bancos con Pro" |
| Ve dashboard, quiere mes anterior | "Desbloquea historial completo" |
| Toca score financiero | Número visible, desglose borroso con candado |
| Intenta descargar PDF | "Descarga reportes con Pro" |
| Después del consejo IA semanal | "Recibe consejos diarios con Pro" |
| Crea 2da meta de ahorro | "Metas ilimitadas con Pro" |
| Sin resumen diario | "Activa tu resumen diario con Pro" |
| Intenta exportar datos | "Exporta tu data con Pro" |
| 4to presupuesto | "Presupuestos ilimitados con Pro" |
| Intenta usar calendario | "Calendario financiero disponible con Pro" |
| 6ta imagen Yape/Plin en el mes | "Lecturas ilimitadas con Pro" |
