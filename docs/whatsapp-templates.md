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

## Templates a crear en Meta Business Manager
Ir a business.facebook.com → WhatsApp Manager → Plantillas de mensajes → Crear plantilla.
Idioma `es`. Los `{{n}}` son variables posicionales.

### Categoría UTILITY (mejor entrega, no sujeta a opt-out de marketing)
Para recordatorios transaccionales/de servicio que el usuario espera.

| name | Uso (cron) | Body sugerido |
|---|---|---|
| `deuda_por_vencer` | checkRecordatorioDeudas (3d/1d/hoy) | `📅 {{1}}, tu deuda con {{2}} ({{3}}) vence {{4}}. Abre Neto para verla.` |
| `plan_pro_por_vencer` | checkPremiumExpiry aviso 3d | `⚠️ {{1}}, tu plan NETO Pro vence en 3 días ({{2}}). Renueva para no perder acceso.` |
| `plan_pro_vencido` | checkPremiumExpiry downgrade | `⏰ {{1}}, tu plan NETO Pro venció. Pasaste a Free (historial 1 mes). Tus datos siguen guardados.` |

### Categoría MARKETING (sujeta a opt-out de usuario; peor entrega que utility)
Para re-enganche y upsell.

| name | Uso | Body sugerido |
|---|---|---|
| `recordatorio_inactividad` | inactivity / survey reminder_d3-d30 | `{{1}}, hace {{2}} días que no registras nada en Neto. Escríbeme un gasto y retomamos. Responde BAJA para no recibir más.` |
| `upsell_pro_mes1` | pro_upsell_d28 | `🎉 {{1}}, ¡1 mes usando Neto! Con NETO Pro desbloqueas historial completo y consejos IA. S/10/mes. Responde BAJA para no recibir más.` |
| `wake_up_onboarding` | wake_up_onboarding | `{{1}}, dejaste tu registro en Neto a medias. Escríbeme tu nombre y te activo en 30s.` |

> Marketing templates requieren botón/línea de opt-out ("responde BAJA"). Al recibir BAJA,
> setear `recordatorios_activos=false` (ya existe /silenciar en `handlers/intents/moderacion.js`).

## Activación (cuando Meta apruebe, ~24-48h por template)
1. Crear los templates arriba y esperar aprobación (estado APPROVED en WhatsApp Manager).
2. En cada cron, reemplazar el `enviarWhatsapp(u.whatsapp, textoLargo, {tipo, usuarioId})`
   por la variante con `template:{...}` (empezar por los UTILITY: deudas y vencimiento Pro).
3. Mantener el `crearNotificacion` in-app como fallback (ya está).
4. Verificar entrega real: `select estado, count(*) from notification_deliveries where canal='whatsapp_template' group by estado;` → debe dominar `sent`, no `blocked_24h`.

## Nota
Los subsistemas `services/gmail-scanner.js` (confirmación de tx desde correo) y
`services/notifications.js` (`enviarAlertaTransaccion`) comparten la misma exposición a la
ventana 24h. No se instrumentaron en el P0 (scope = recordatorios; gmail es CASA-sensible).
Evaluar templates/utility para ellos en una fase posterior.
