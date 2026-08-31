# Canal de email transaccional — alta y operación

El código está desplegado y **apagado**. Sin `RESEND_API_KEY` cada intento hace no-op y deja
una fila `skipped_sin_proveedor` en `notification_deliveries`, así que se puede verificar que
el camino se recorre antes de que exista la cuenta. Este archivo es lo que falta para
prenderlo, y es todo trabajo de Favio: crear la cuenta, tocar el DNS y cargar variables.

## Por qué existe este canal (el resumen de una línea)

WhatsApp proactivo entrega alrededor del 12%. Medido el 27-ago-2026 sobre 30 días de
`notification_deliveries`: **556 `sent`, 67 entregados, 459 fallidos por callback, 452 de ellos
con código 131047** (la ventana de 24h de Meta). Y sobre los 12 usuarios que recibieron un
aviso de plata en ese período, **12 de 12 tienen email y 0 son solo-WhatsApp**.

El detalle completo, y por qué no son plantillas de Meta, está en `docs/whatsapp-templates.md`.

---

## Paso 1 — Cuenta y dominio en Resend

1. Crear la cuenta en resend.com con `faviomendoza27jl@gmail.com`.
2. **Add Domain** → `neto.pe`, región `us-east-1`.
3. Resend devuelve tres registros. Anotarlos: un CNAME de DKIM (`resend._domainkey`), un TXT
   de SPF sobre un subdominio de envío, y un CNAME opcional de tracking.

## Paso 2 — DNS en Cloudflare

Estado real del DNS al 27-ago-2026, verificado contra 8.8.8.8 (no leído de un panel):

```
SPF    neto.pe            TXT    v=spf1 include:_spf.mx.cloudflare.net ~all
DKIM   mail._domainkey    —      NO EXISTE
DMARC  _dmarc.neto.pe     TXT    v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com
otros  neto.pe            TXT    brevo-code:24cd..., google-site-verification=...
```

> **El `brevo-code` es lo único de Brevo que hay, y no habilita nada.** Alguien empezó a
> verificar el dominio en Brevo y nunca terminó: sin DKIM y sin el include en el SPF, Brevo
> tampoco puede firmar un correo de `neto.pe` hoy. Si alguien dice "Brevo ya está configurado",
> es esto, y no alcanza. Los dos proveedores piden exactamente el mismo trabajo de DNS.

**La regla que importa: el SPF de `neto.pe` NO se reemplaza, se le AGREGA el include.**

```
v=spf1 include:_spf.mx.cloudflare.net include:amazonses.com ~all
```

El `_spf.mx.cloudflare.net` es Cloudflare Email Routing, que es lo que hace funcionar la
**recepción** de `hola@neto.pe`. Pisarlo deja a Neto sin correo entrante, y el síntoma no
aparece al mandar: aparece cuando un cliente responde y el mensaje no llega nunca.

> Un dominio no puede tener dos registros SPF. Si Resend pide su propio `v=spf1` sobre un
> subdominio de envío (`send.neto.pe`), ese va aparte y no toca al de la raíz — que es el caso
> normal y el más seguro. El include de arriba solo hace falta si se manda desde la raíz.

**DMARC se queda en `p=none`.** Endurecerlo a `quarantine` es otra tarea, otro día: hacerlo en
la misma sesión que agrega un remitente nuevo es la forma de no saber cuál de los dos cambios
rompió qué. Cuando se haga, primero mirar los reportes `rua` durante un par de semanas.

## Paso 3 — Variables en Railway (servicio Neto)

| Variable | Qué es | Si falta |
|---|---|---|
| `RESEND_API_KEY` | API key de Resend | **el canal es no-op** y deja `skipped_sin_proveedor` |
| `EMAIL_OPTOUT_SECRET` | secreto propio para firmar el link de baja. Generar con `openssl rand -base64 32` | **no sale ningún correo** (`skipped_sin_baja`). Fail closed a propósito |
| `RESEND_WEBHOOK_SECRET` | signing secret del webhook (`whsec_...`) | el webhook responde **503** y no se escribe ninguna entrega |
| `RESEND_FROM` | opcional. Default `Neto <hola@neto.pe>` | usa el default |
| `API_PUBLIC_URL` | opcional. Default `https://api.neto.pe` | usa el default |

`EMAIL_OPTOUT_SECRET` no tiene fallback y no se comparte con ningún otro propósito. Rotarlo
**invalida los links de baja de los correos ya enviados**, o sea que deja a alguien sin salida:
no se rota salvo compromiso, y si se rota hay que asumir que los correos viejos quedan sin
botón que funcione.

## Paso 4 — Webhook en Resend

Endpoint: `https://api.neto.pe/webhooks/resend`

Eventos a suscribir: **`email.delivered`, `email.bounced`, `email.complained`.**

No suscribir `email.sent` (ya lo registra el POST), ni `opened`/`clicked`: el handler los
ignora, pero suscribirlos es tráfico y telemetría de lectura que este producto no necesita.

**Este webhook es lo que hace que el canal sea medible.** Sin él, `estado='sent'` sería toda la
instrumentación y el canal reportaría 100% de entrega — que es exactamente lo que pasaba con
WhatsApp antes del hallazgo B23, cuando se reportaba 100% mientras Meta entregaba el 15%.

## Paso 5 — Verificar en producción

```bash
curl -sI https://api.neto.pe/webhooks/resend -X POST   # 400 sin firma (no 404, no 200)
curl -sI "https://api.neto.pe/baja-recordatorios?t=x"   # 400 con token inválido
```

Y después del primer envío real. **Ojo con qué `tipo` se consulta**: hasta el 31-ago-2026 el
emisor de deudas era `checkRecordatorioDeudas` (`tipo = 'deuda'`, diario 9am) y hoy ese cron ya
**no manda correo** — filtrar por ese tipo devuelve cero filas de `canal='email'` y se lee como
"el canal está roto". El correo de deudas ahora es `checkResumenDeudasSemanal`
(`tipo = 'resumen_deudas_semanal'`), y corre **lunes 9am**, así que en un martes recién
desplegado lo más rápido de verificar son los avisos de fin de prueba (`trial_d11`/`trial_d14`,
cada hora desde las 8am) o el respaldo de soporte.

```sql
select tipo, canal, estado, count(*),
       count(*) filter (where delivered_at is not null) as entregados,
       count(*) filter (where failed_at is not null)    as fallidos
from notification_deliveries
where canal = 'email' and created_at > now() - interval '9 days'
group by 1, 2, 3 order by 1, 2, 3;
```

La ventana es de 9 días y no de 2 a propósito: con el emisor de deudas semanal, dos días pueden
no contener ni un lunes.

**Qué esperar y cómo leerlo:**

- `canal='email'`, `estado='skipped_sin_proveedor'` → el código corre, falta la key. Es el
  estado correcto **antes** del paso 3.
- `canal='email'`, `estado='sent'`, `entregados=0` durante más de unos minutos → el webhook no
  está llegando. Revisar el paso 4 antes de sacar cualquier conclusión sobre entregabilidad.
- `estado='error'` con `code=403` y "domain is not verified" → falta el paso 2.

## Límites de la capa gratis

3.000 correos/mes con **tope de 100 por día**. Neto necesita ~70 al mes, así que sobra por dos
órdenes de magnitud — pero **el tope diario prohíbe cualquier backfill masivo**. Si alguna vez
se quiere avisar a todo el padrón de una vez, hay que escalonarlo o pagar el plan.

Hay además un límite de **2 requests por segundo**. Hoy no muerde: los crons recorren
destinatarios en serie y cada vuelta hace varias consultas antes de llegar al envío. Pero
conviene saber que **un 429 se trata como fallo permanente**: `enviarEmail` lo registra como
`estado='error'` y no reintenta, y estos avisos están anclados a un día exacto, así que lo que
se pierde es el ciclo entero. Si algún día se manda en paralelo o en lote, eso es lo primero
que hay que resolver — no el tope mensual.

---

## Cómo se agrega un emisor nuevo

1. El `select` del cron tiene que traer `email`. **El chokepoint no lo lee**: `to` viaja desde
   el llamador, igual que `whatsapp`, para no meter I/O en `notificarUsuario`.
2. Agregar `email: { to: u.email || null, asunto: '...' }` a la llamada.
3. El asunto **no** puede ser el `titulo` de la campana. "Deuda vence hoy" no dice de quién ni
   de cuánto, y en una bandeja al lado de otros treinta eso es la diferencia entre que lo abran
   y que no. Va con contraparte y monto, y sin emoji.
4. El cuerpo no se pasa: sale de `titulo` + `cuerpo`/`mensaje`, los mismos que ve la campana.
   Un cuarto texto a mano es un cuarto lugar donde el mismo aviso puede envejecer distinto.

Los guards se encargan del resto: si te olvidás el asunto, o llamás `enviarEmail` directo, el
build se pone rojo.

## Lo que NO se hizo, y por qué

- **`llegoElAviso` no aprendió del correo.** Es el predicado que abre la ventana de 48h de
  comprobante (`cron/checks.js`), y hoy exige `inApp === true && supabase_auth_id`. Es una
  decisión de Favio del 14-ago con su propio razonamiento escrito, y ninguno de los cuatro
  avisos que lo usan declara correo todavía. Cuando alguno lo declare, esa es la conversación
  a tener — no un cambio a hacer de paso.
- **No hay flag separado de opt-out solo-email.** `recordatorios_activos` ya existe, ya lo
  respetan los crons y ya lo expone la webapp. Un flag aparte sería el mismo estado en dos
  lugares. El precio es que la baja apaga también WhatsApp, y por eso el pie del correo y la
  página de confirmación lo dicen con esas palabras en vez de prometer solo-correo.
