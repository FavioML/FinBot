import { PRO_PRICE_MONTHLY_PEN, PRO_PRICE_YEARLY_PEN, SOCIAL_LINKS, YAPE_NUMERO_PRO } from '@/lib/constants';
import type { AdminRenovacion } from '@/lib/types-admin';

/**
 * El bloque de Renovaciones de /admin/pagos: a quién escribirle y qué decirle.
 *
 * El mensaje sale del WhatsApp PERSONAL de Favio (un link `wa.me` abre el WhatsApp de quien hace
 * clic), no del número de Neto: ese vive en la Cloud API y no se puede escribir a mano. Por eso
 * va en primera persona y se presenta.
 *
 * El camino para renovar depende de la cuenta. A quien tiene cuenta web se le manda a
 * `/dashboard/pro`, que ya permite pagar el periodo siguiente. A quien solo usa WhatsApp NO: el
 * panel lo dejaría en `/login` y un "Continuar con Google" le crearía una cuenta huérfana en vez
 * de vincularse a su número (ver `linkPanelPro` en el backend). A ese se le da el camino que ya
 * existe: yapear y mandarle la captura a Neto, que la reconoce como pago por su CONTENIDO aunque
 * no esté esperando un comprobante (`handlers/webhook.js`, rama de imagen). Es el mismo texto de
 * los avisos de vencimiento de `cron/checks.js`.
 *
 * **No se le dice "escríbele a Neto que quieres renovar".** Así decía la primera versión y era
 * falso para quien está por vencer: a un Pro pagado, `ver_premium` le muestra su tarjeta de plan,
 * sin precio ni número de Yape (lo encontró la revisión adversarial del 30-sep).
 */
const YAPE = YAPE_NUMERO_PRO;
/**
 * El chat de Neto, con link. Hace falta porque el mensaje sale del WhatsApp de Favio, que es el
 * MISMO número del Yape: "mándale la captura a Neto" a secas se responde en ese chat, donde el
 * webhook no la ve y el pago no deja fila en `pagos` (segunda revisión, 30-sep).
 */
const CHAT_NETO = SOCIAL_LINKS.whatsapp.replace(/^https:\/\//, '');

type Contacto = Pick<AdminRenovacion, 'nombre' | 'whatsapp' | 'email_web' | 'tiene_cuenta_web'>;

export function primerNombre(nombre: string | null): string | null {
  const n = nombre?.trim().split(/\s+/)[0];
  return n ? n.charAt(0).toUpperCase() + n.slice(1) : null;
}

/** 'YYYY-MM-DD' → '03/07'. */
function diaMes(fecha: string): string {
  const [, m, d] = fecha.slice(0, 10).split('-');
  return `${d}/${m}`;
}

/** "vence hoy", "vence mañana", "vence en 4 días", "venció ayer", "venció hace 40 días". */
export function etiquetaPlazo(r: Pick<AdminRenovacion, 'dias'>): string {
  if (r.dias === 0) return 'vence hoy';
  if (r.dias === 1) return 'vence mañana';
  if (r.dias > 1) return `vence en ${r.dias} días`;
  if (r.dias === -1) return 'venció ayer';
  return `venció hace ${-r.dias} días`;
}

function caminoParaRenovar(r: Pick<AdminRenovacion, 'tiene_cuenta_web' | 'tipo_plan'>): string {
  if (r.tiene_cuenta_web) return 'lo renuevas desde app.neto.pe/dashboard/pro';
  const precio =
    r.tipo_plan === 'anual'
      ? `S/${PRO_PRICE_YEARLY_PEN} (un año)`
      : `S/${PRO_PRICE_MONTHLY_PEN} (un mes) o S/${PRO_PRICE_YEARLY_PEN} (un año)`;
  return `yapea ${precio} al ${YAPE} y mándale la captura a Neto, en este chat: ${CHAT_NETO}`;
}

export function mensajeRenovacion(
  r: Pick<
    AdminRenovacion,
    'estado' | 'dias' | 'premium_vence' | 'nombre' | 'tiene_cuenta_web' | 'tipo_plan' | 'pago_pendiente'
  >,
): string {
  const nombre = primerNombre(r.nombre);
  const saludo = nombre ? `Hola ${nombre}, soy Favio, de Neto.` : 'Hola, soy Favio, de Neto.';
  // Ya mandó el comprobante: decirle "no lo renovaste" o darle el camino para pagar sería falso.
  // Lo que falta es que el admin lo apruebe.
  if (r.pago_pendiente) {
    return `${saludo} Ya vi el comprobante que mandaste para tu plan Pro. Lo reviso y te confirmo.`;
  }
  if (r.estado === 'por_vencer') {
    const cuando = r.dias === 0 ? 'hoy' : r.dias === 1 ? 'mañana' : `el ${diaMes(r.premium_vence)}`;
    return (
      `${saludo} Te escribo porque tu plan Pro vence ${cuando}. ` +
      `Si quieres seguir con él, ${caminoParaRenovar(r)}. Cualquier duda, me dices.`
    );
  }
  return (
    `${saludo} Vi que tu plan Pro venció el ${diaMes(r.premium_vence)} y no lo renovaste. ` +
    '¿Me cuentas qué te faltó o qué no te convenció? Me ayuda mucho para mejorar Neto. ' +
    `Y si quieres volver, ${caminoParaRenovar(r)}.`
  );
}

/**
 * Link `wa.me` con el mensaje prellenado, o null si el número no sirve. `usuarios.whatsapp`
 * guarda solo dígitos con código de país; cualquier otra cosa (un BSUID, un valor raro) no se
 * convierte en un link que abra el chat de otra persona.
 */
export function linkWhatsapp(numero: string | null, texto: string): string | null {
  if (!numero || !/^\d{8,15}$/.test(numero)) return null;
  return `https://wa.me/${numero}?text=${encodeURIComponent(texto)}`;
}

/** Correo solo como respaldo de quien no tiene WhatsApp, y solo si es una dirección probada. */
export function linkCorreo(r: Contacto, texto: string): string | null {
  if (!r.email_web) return null;
  const asunto = 'Tu plan Pro de Neto';
  return `mailto:${r.email_web}?subject=${encodeURIComponent(asunto)}&body=${encodeURIComponent(texto)}`;
}
