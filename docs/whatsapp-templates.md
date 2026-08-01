# WhatsApp Templates (HSM) — Neto

**Estado:** PENDIENTE de crear/aprobar en Meta. `lib/whatsapp.js` ya soporta enviarlos.
**Motivo (audit 2026-07-03):** todos los recordatorios salían free-form (`type:'text'`) y
Meta los bloquea (error 131047) si el usuario no escribió en 24h. Los templates aprobados son
la ÚNICA forma de iniciar conversación fuera de esa ventana → es lo que hace que el
recordatorio le llegue al usuario **inactivo** (justo al que más le urge).

## Precondiciones (verificado 2026-07-03)
- WABA `2080787612777795`, tier `TIER_250`, quality `GREEN`, `name_status=AVAILABLE_WITHOUT_REVIEW`.
- Los templates son **viables sin** Business Verification (esa solo bloquea el cambio de display
  name, que sigue "Favio Mendoza"). No es bloqueante para enviar HSM.
- Límite TIER_250 = 250 conversaciones business-initiated / 24h. Suficiente para 61 usuarios.

## Cómo se envía desde el código
`lib/whatsapp.js` → `enviarWhatsapp(numero, mensaje, { template, usuarioId, tipo })`.
Si `template` está presente, envía `type:'template'` (ignora `mensaje`). Formato del payload:

```js
await enviarWhatsapp(u.whatsapp, null, {
  tipo: 'deuda',
  usuarioId: u.id,
  template: {
    name: 'deuda_por_vencer',
    language: { code: 'es' },
    components: [
      { type: 'body', parameters: [
        { type: 'text', text: primerNombre },      // {{1}}
        { type: 'text', text: contraparte },        // {{2}}
        { type: 'text', text: 'S/ 120.00' },        // {{3}}
      ]},
    ],
  },
});
```

## Decisión (Favio, 2026-07-03)
Solo **2 templates UTILITY** (los más baratos, protegen plata). Re-enganche/upsell quedan
**solo in-app** (gratis), no se paga marketing por perseguir al inactivo.

## Templates a crear — vía script
`node scripts/create_wa_templates.js` los crea y manda a aprobación automáticamente (usa
`META_ACCESS_TOKEN` + `META_WABA_ID`). Si el token no tiene `whatsapp_business_management`,
crearlos a mano en business.facebook.com → WhatsApp Manager → Plantillas (idioma `es`, categoría Utility).

| name | Categoría | Cron | Body | Variables |
|---|---|---|---|---|
| `deuda_por_vencer` | UTILITY | checkRecordatorioDeudas (touches 3d/1d/hoy/-3d) | `Hola {{1}} 👋 Recordatorio de Neto: {{2}} por {{3}} vence {{4}}. Entra a Neto para gestionarlo.` | 1=nombre, 2="tu deuda con Juan"/"lo que te debe Juan", 3="S/ 120.00", 4="en 3 días"/"mañana"/"hoy"/"hace 3 días" |
| `plan_pro_por_vencer` | UTILITY | checkPremiumExpiry aviso 3d | `Hola {{1}} 👋 Tu plan NETO Pro vence {{2}}. Renuévalo desde Neto para no perder tu historial y las funciones Pro.` | 1=nombre, 2="en 3 días (2026-07-06)" |
| `trial_por_vencer` | UTILITY | checkTrialExpiry (día 11 y día 14) | `Hola {{1}} 👋 Tu prueba de Neto Pro termina {{2}}. Entra a Neto para ver tu resumen y decidir si continúas.` | 1=nombre, 2="en 3 días (12/08)" / "hoy" |

### `trial_por_vencer` — por qué es uno solo y no dos (2026-08-01)
Los dos toques del fin de trial (día 11 = faltan 3, día 14 = último día) comparten cuerpo
y solo cambian en el timing, así que el timing es la variable `{{2}}` — mismo molde que el
`{{4}}` de `deuda_por_vencer`. **Una aprobación cubre los dos avisos.**

No sirve reusar `plan_pro_por_vencer`: dice "Renuévalo", que da por hecho un pago anterior
que el usuario en prueba nunca hizo.

Flag propio **`WA_TRIAL_TEMPLATE_ENABLED`** (default `false`), separado de
`WA_TEMPLATES_ENABLED` (que hoy solo gobierna deudas) para poder activar cada uno cuando
su plantilla esté aprobada, sin arrastrar al otro.

**Mientras no esté aprobada**, los dos toques salen free-form. A diferencia del win-back —
que persigue inactivos de 70-143 días y tuvo 0 entregas confirmadas —, esta población es
la de MEJOR caso para la ventana de 24h: por construcción registró un gasto hace ≤14 días.
Pero no se asume; se mide:

```sql
select tipo, canal, estado,
       count(*) filter (where delivered_at is not null) as entregados,
       count(*) as intentos
from notification_deliveries
where tipo in ('trial_d11','trial_d14','trial_vencido')
group by 1,2,3 order by 1,2;
```

Si `blocked_24h` domina, la plantilla se justifica. Si no, se ahorra el gasto. El canal
garantizado mientras tanto es la notificación in-app + el banner del dashboard.

> Body sin pricing/Yape a propósito: utility debe ser transaccional para aprobar. El detalle de
> precio/CTA va en el mensaje libre de seguimiento (ya abre ventana cuando el usuario responde).

## Cambio 2026-07-03 (Favio): premium siempre free-form
Los recordatorios de **vencimiento Pro** (3 días antes, **vence hoy** — touch nuevo — y venció)
quedaron **free-form siempre**, desacoplados del flag, para que no cuesten. Solo entregan al usuario
Pro que esté en ventana de 24h (activo). El template `plan_pro_por_vencer` quedó creado pero **sin
usar** (por si algún día se quiere reactivar; recrear el wiring en `checkPremiumExpiry`).
El flag `WA_TEMPLATES_ENABLED` ahora **solo afecta deudas**.

## Activación (una sola variable, sin nueva sesión de código)
El envío por template YA está cableado en `cron/checks.js` (solo **deudas**), detrás del flag
`WA_TEMPLATES_ENABLED`. Con el flag off manda texto libre (comportamiento actual); con el flag on
manda template. Pasos:
1. Correr el script → templates a aprobación.
2. Esperar estado APPROVED en WhatsApp Manager (~24-48h).
3. Setear `WA_TEMPLATES_ENABLED=true` en Railway (variables del servicio Neto.pe) → redeploy.
4. Verificar entrega real a un inactivo:
   `select canal, estado, count(*) from notification_deliveries where tipo in ('deuda','premium_expiry_3d') group by canal, estado;`
   → los `whatsapp_template` deben dominar `sent`, no `blocked_24h`.

> Si Meta cambia el copy en revisión y altera el número de variables, ajustar los `parameters`
> en `cron/checks.js` (bloques `dTemplate` / `pTemplate`) para que coincidan.

## Nota
Los subsistemas `services/gmail-scanner.js` (confirmación de tx desde correo) y
`services/notifications.js` (`enviarAlertaTransaccion`) comparten la misma exposición a la
ventana 24h. No se instrumentaron en el P0 (scope = recordatorios; gmail es CASA-sensible).
Evaluar templates/utility para ellos en una fase posterior.
