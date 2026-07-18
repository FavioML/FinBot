# Plan Freemium — Neto (Versión Final v2.1)

**Fecha:** 3 Abr 2026
**Aprobado por:** Favio Mendoza

---

## Pricing

| Plan | Precio | Equivalente mensual | Ahorro |
|------|--------|---------------------|--------|
| **Free** | S/0 | — | — |
| **Pro Mensual** | S/10/mes | S/10/mes | — |
| **Pro Anual** | S/99/año | S/8.25/mes | 17% |

---

## Features Free vs Pro

| Feature | Free | Pro |
|---------|------|-----|
| WhatsApp bot (registro, gastos, consultas) | Ilimitado | Ilimitado |
| Clasificación IA de gastos | Ilimitada | Ilimitada |
| Categorías fijas (11) | Sí | Sí |
| Categorías personalizadas adicionales | Ilimitadas | Ilimitadas |
| Presupuestos | Ilimitados | Ilimitados |
| Metas de ahorro | 1 activa | Ilimitadas |
| Deudas | Ilimitadas | Ilimitadas |
| Lectura de imágenes Yape/Plin | Ilimitada | Ilimitada |
| Split de gastos | Sí | Sí |
| Multimoneda USD/PEN | Sí | Sí |
| Tipo de cambio widget | Sí | Sí |
| Búsqueda global (Ctrl+K) | Sí | Sí |
| Dashboard web (app.neto.pe) | Mes actual | Historial completo |
| Resumen semanal | Básico (total gastado) | Completo (insights + comparativa) |
| Resumen mensual | Sí | Sí |
| Score financiero | Número | Número + desglose + tendencia 4 meses |
| Referidos (3 Pro activos = 1 mes gratis) | Sí | Sí |
| Google Auth (nombre, foto) | Sí | Sí |
| Lectura automática correos bancarios | No (Pro only) | 11 bancos + Yape + Plin |
| Consejo IA | No (Pro only) | Diario |
| Resumen diario por WhatsApp | No | Sí |
| Reportes PDF descargables | No | Sí |
| Score desglose + tendencia 4 meses | No | Sí |
| Calendario financiero | No | Sí |
| Heatmap de gastos | No | Sí |
| Export CSV/JSON | No | Sí |
| Carga masiva Excel/CSV | No | Sí |
| Recordatorios diarios (8pm) | No | Sí |
| Suscripciones con alertas | Detección | Detección + alertas |
| Pagos recurrentes | No | Sí |

---

## Features v2 — Diferenciación Free vs Pro

### 1. Neto Score (Pro Wall modelo Spotify)

| Aspecto | Free | Pro |
|---------|------|-----|
| Score número + tendencia | Sí | Sí |
| Desglose por factor | No — "Pasa a Pro para ver qué mejorar" | Completo |
| Tips personalizados IA | No | Sí |
| Histórico de evolución | Solo último mes | 6+ meses |
| Notificación semanal | No | Sí |

### 2. Detector de Fugas

| Aspecto | Free | Pro |
|---------|------|-----|
| Reporte mensual de fugas | Resumen básico | Detallado con recomendaciones |
| Alertas semanales | No | Sí |
| Alerta proactiva mid-mes | No | Sí |
| Proyección de exceso | No | Sí |
| "Ponme un límite" interactivo | No | Sí |

### 3. Planes de Compra

| Aspecto | Free | Pro |
|---------|------|-----|
| Crear plan de compra | 1 activo | Ilimitados |
| Cálculo de cuota mensual | Sí | Sí |
| Análisis de viabilidad | Básico ("necesitas S/X/mes") | Completo (cruza con margen real) |
| Ajuste dinámico | No | Sí |
| Check-ins WhatsApp | No | Quincenal |
| Sugerencia de recortes | No | Sí ("Si reduces delivery S/150, llegas antes") |

### 4. Espacios Compartidos

| Aspecto | Free | Pro |
|---------|------|-----|
| Espacios compartidos | 1 espacio, 2 personas | Ilimitados |
| Split configurable | Solo 50/50 | Cualquier proporción |
| Presupuesto conjunto | No | Sí |
| Historial | Último mes | Completo |
| Plan de ahorro compartido | No | Sí |

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
| Ingreso/usuario/mes | S/0 | S/10 | S/8.25 |
| Costo variable/usuario/mes | S/0.53 | S/3.41 | S/3.41 |
| Margen/usuario/mes | -S/0.53 | +S/6.59 | +S/4.84 |
| Margen % | -100% | 66% | 59% |

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

**Gmail OAuth = Pro-only feature.** Solo 100 OAuth slots disponibles en Google Cloud Console hasta verificación CASA Tier 2 ($540 USD). Free users NO consumen slots — solo reciben info básica de Google Auth (nombre, foto). Solo Pro users que pagan reciben link OAuth para lectura de correos.

**Status actual:** 3/100 slots usados (26 Mar 2026).

---

## Upgrade Triggers

| Momento | Mensaje |
|---------|---------|
| Intenta conectar Gmail para lectura | "Conecta todos tus bancos con Pro" |
| Ve dashboard, quiere mes anterior | "Desbloquea historial completo" |
| Toca score financiero desglose | Número visible, desglose borroso con candado |
| Intenta descargar PDF | "Descarga reportes con Pro" |
| Intenta pedir consejo IA | "Recibe consejos diarios con Pro" |
| Sin resumen diario | "Activa tu resumen diario con Pro" |
| Intenta exportar datos | "Exporta tu data con Pro" |
| Intenta usar calendario | "Calendario financiero disponible con Pro" |
| Intenta usar heatmap | "Heatmap de gastos disponible con Pro" |
| Intenta cargar Excel/CSV | "Carga masiva de transacciones disponible con Pro" |
