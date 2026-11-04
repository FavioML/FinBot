const { sumarMeses } = require('./dates');

/**
 * Medidores de los costos que se cobran por consumo (columna `admin_costs.meter`, migración 093).
 *
 * Una fila con medidor tiene `next_due_date` en el día 1 de un mes. Cuando ese día llega, el cron
 * (`checkRecordatoriosCostos`) le pide a la API del proveedor el consumo del mes ANTERIOR, lo
 * registra en `paid_history` con `paid_at = next_due_date` y avanza la fecha un mes. Es el mismo
 * calendario con que Meta cobra: el 01-nov debitó el consumo de octubre.
 *
 * El monto que se registra es el consumo del proveedor más su impuesto, convertido a soles. No es
 * el cargo exacto de la tarjeta (el banco usa su propio tipo de cambio); si difiere, se corrige
 * desde "Historial de pagos" en /admin/costs.
 *
 * Si la lectura falla, NO se registra nada ni se avanza la fecha: un monto estimado en el P&L se
 * lee igual que uno medido. El cron avisa por Telegram y reintenta al día siguiente.
 */

const META_GRAPH = 'https://graph.facebook.com/v23.0';
const OPENAI_API = 'https://api.openai.com/v1';
const WABA_NETO = '2080787612777795';

/**
 * Impuesto que el proveedor suma al consumo. Meta: 18% de IGV, leído del comprobante del
 * 01-nov-2026 (subtotal US$13.16 + US$2.37). OpenAI: 18% también. Su correo de recarga no desglosa,
 * pero las recargas de US$10 llegan a la Visa como US$11.80 (09-mar, 28-ago y 17-oct-2026), y la
 * Costs API devuelve el consumo antes de impuesto.
 */
const MEDIDORES = {
  meta_whatsapp: { etiqueta: 'Meta WhatsApp', impuesto: 0.18 },
  openai: { etiqueta: 'OpenAI', impuesto: 0.18 },
};

/**
 * Ventana del mes consumido para una fila que vence `nextDueIso`: [vence − 1 mes, vence), en
 * medianoche de Lima (05:00Z). Devuelve segundos unix, que es lo que piden las dos APIs.
 */
function periodoMedido(nextDueIso) {
  const desde = sumarMeses(nextDueIso, -1);
  const unix = (iso) => Math.floor(Date.parse(iso + 'T05:00:00Z') / 1000);
  return { desde, hasta: nextDueIso, desdeUnix: unix(desde), hastaUnix: unix(nextDueIso) };
}

/** Monto en soles: consumo en dólares + impuesto, al tipo de venta. Dos decimales. */
function montoPen(usd, impuesto, tipoCambio) {
  return Math.round(usd * (1 + impuesto) * tipoCambio * 100) / 100;
}

async function leerJson(resp, proveedor) {
  const body = await resp.json().catch(() => null);
  if (!resp.ok) {
    const detalle = body && body.error ? (body.error.message || JSON.stringify(body.error)) : 'HTTP ' + resp.status;
    throw new Error(proveedor + ': ' + detalle);
  }
  return body;
}

/**
 * Meta: `pricing_analytics` de la WABA, por día y por tipo de precio. `FREE_CUSTOMER_SERVICE` son
 * los mensajes del tramo gratis; `REGULAR`, los cobrados.
 */
async function medirMetaWhatsapp({ desdeUnix, hastaUnix }, { env = process.env, fetchImpl = fetch } = {}) {
  const token = env.META_ACCESS_TOKEN;
  // El id de la WABA no es secreto (sale en cada comprobante de Meta); la variable existe para
  // poder apuntar a otra cuenta sin un deploy.
  const waba = env.META_WABA_ID || WABA_NETO;
  if (!token) throw new Error('Meta: falta META_ACCESS_TOKEN');
  const dims = encodeURIComponent(JSON.stringify(['PRICING_CATEGORY', 'PRICING_TYPE']));
  const url = META_GRAPH + '/' + waba + '?fields=pricing_analytics.start(' + desdeUnix + ').end(' + hastaUnix
    + ').granularity(DAILY).dimensions(' + dims + ')';
  const body = await leerJson(await fetchImpl(url, {
    headers: { Authorization: 'Bearer ' + token },
    signal: AbortSignal.timeout(15000),
  }), 'Meta');

  // Una respuesta sin `pricing_analytics` (token sin whatsapp_business_management, campo
  // renombrado) o sin un solo punto NO es "cero consumo": el bot manda más de mil mensajes al
  // mes. Registrar 0 avanzaría la fecha y el mes se perdería sin reintento.
  const series = body && body.pricing_analytics && body.pricing_analytics.data;
  if (!Array.isArray(series)) throw new Error('Meta: la respuesta no trae pricing_analytics');
  const puntos = series.flatMap((d) => d.data_points || []);
  if (puntos.length === 0) throw new Error('Meta: pricing_analytics vino sin datos para el mes');
  let usd = 0;
  let gratis = 0;
  let cobrados = 0;
  for (const p of puntos) {
    if (p.start < desdeUnix || p.start >= hastaUnix) continue;
    usd += Number(p.cost) || 0;
    if (String(p.pricing_type || '').startsWith('FREE')) gratis += Number(p.volume) || 0;
    else cobrados += Number(p.volume) || 0;
  }
  return {
    usd,
    detalle: (gratis + cobrados) + ' mensajes, ' + cobrados + ' cobrados',
  };
}

/**
 * OpenAI: Costs API de la organización. Exige una Admin key (`OPENAI_ADMIN_KEY`, de solo lectura
 * basta), que NO es la llave del bot. Agrupa por proyecto para que el aviso separe "Neto" (el bot)
 * de "Neto Pruebas" (sondas y baterías); el monto registrado es la suma de los dos.
 */
async function medirOpenAI({ desdeUnix, hastaUnix }, { env = process.env, fetchImpl = fetch } = {}) {
  const key = env.OPENAI_ADMIN_KEY;
  if (!key) throw new Error('OpenAI: falta OPENAI_ADMIN_KEY (Admin key de solo lectura)');
  const headers = { Authorization: 'Bearer ' + key };

  const porProyecto = new Map();
  let usd = 0;
  let page = null;
  let completo = false;
  for (let vuelta = 0; vuelta < 10 && !completo; vuelta++) {
    const qs = new URLSearchParams({
      start_time: String(desdeUnix), end_time: String(hastaUnix),
      bucket_width: '1d', limit: '31', group_by: 'project_id',
    });
    if (page) qs.set('page', page);
    const body = await leerJson(await fetchImpl(OPENAI_API + '/organization/costs?' + qs, {
      headers, signal: AbortSignal.timeout(15000),
    }), 'OpenAI');
    if (!body || !Array.isArray(body.data)) throw new Error('OpenAI: la respuesta de costos no trae data');
    for (const bucket of body.data) {
      for (const r of bucket.results || []) {
        const valor = Number(r.amount && r.amount.value) || 0;
        usd += valor;
        const id = r.project_id || 'sin proyecto';
        porProyecto.set(id, (porProyecto.get(id) || 0) + valor);
      }
    }
    if (!body.has_more) { completo = true; break; }
    if (!body.next_page) throw new Error('OpenAI: has_more sin next_page, la lectura quedaría a medias');
    page = body.next_page;
  }
  // Un total parcial se lee igual que uno completo: mejor no registrar nada.
  if (!completo) throw new Error('OpenAI: más de 10 páginas de costos, la lectura quedaría a medias');

  // Los nombres son cosmética del aviso: si la llave no puede listar proyectos, van los ids.
  const nombres = new Map();
  try {
    const body = await leerJson(await fetchImpl(OPENAI_API + '/organization/projects?limit=100', {
      headers, signal: AbortSignal.timeout(15000),
    }), 'OpenAI');
    for (const p of body.data || []) nombres.set(p.id, p.name);
  } catch { /* sin nombres */ }

  const detalle = [...porProyecto.entries()]
    .filter(([, v]) => v > 0)
    .map(([id, v]) => (nombres.get(id) || id) + ' $' + v.toFixed(2))
    .join(', ');
  return { usd, detalle: detalle || 'sin consumo' };
}

const LECTORES = { meta_whatsapp: medirMetaWhatsapp, openai: medirOpenAI };

/**
 * Lee el consumo de una fila con medidor para el mes que cierra en su `next_due_date`.
 * Lanza si el medidor no existe o si la API falla; el caller decide qué hacer con eso.
 */
async function medirCosto(fila, opciones) {
  const medidor = MEDIDORES[fila.meter];
  const leer = LECTORES[fila.meter];
  if (!medidor || !leer) throw new Error('Medidor desconocido: ' + fila.meter);
  // La ventana es un mes calendario solo si la fecha cae en día 1; con un día 30 recortado por
  // sumarMeses la fecha derivaría para siempre y el aviso diría un mes que no es.
  if (!/^\d{4}-\d{2}-01$/.test(String(fila.next_due_date))) {
    throw new Error('next_due_date tiene que ser un día 1 (es ' + fila.next_due_date + ')');
  }
  const periodo = periodoMedido(fila.next_due_date);
  const { usd, detalle } = await leer(periodo, opciones);
  return { ...periodo, usd, impuesto: medidor.impuesto, etiqueta: medidor.etiqueta, detalle };
}

module.exports = { MEDIDORES, periodoMedido, montoPen, medirCosto, medirMetaWhatsapp, medirOpenAI };
