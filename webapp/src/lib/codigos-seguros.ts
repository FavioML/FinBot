/**
 * Todo código que funcione como CREDENCIAL sale de acá, nunca de `Math.random()`.
 *
 * Qué es una credencial en Neto: el código del OTP inverso (prueba posesión del número antes
 * de vincular una cuenta Google) y los códigos de invitación a metas y espacios compartidos
 * (quien los tiene, entra). En los tres casos **el código es la única prueba**: no hay nada
 * más que ate un código a la persona a la que se le emitió.
 *
 * Por qué `Math.random()` no sirve, y no es teoría: el PRNG de V8 es xorshift128+, cuyo
 * estado interno se reconstruye observando unas pocas salidas. Y observarlas es trivial acá,
 * porque el propio producto se las entrega a quien las pide — un atacante genera códigos
 * para sus propias metas/espacios, recupera el estado y predice los que se emitan después.
 * En el caso del OTP eso vale una cuenta Google ajena: el webhook busca el código
 * globalmente y vincula la cuenta al teléfono que lo ENVIÓ.
 *
 * Los rate limits que existen acotan la FUERZA BRUTA, que es otro ataque. Predecir no es
 * adivinar. (S4 de la auditoría CTO del 2026-08-03, y las tres instancias hermanas que
 * encontró el guard al cerrarlo.)
 *
 * `crypto.getRandomValues` (Web Crypto) y no `node:crypto` a propósito: estas funciones se
 * usan desde routes del server Y desde un hook del cliente.
 */

/**
 * Entero uniforme en [0, rango) desde la fuente criptográfica.
 *
 * El bucle de rechazo NO es opcional: 2^32 no suele ser múltiplo del rango, así que un
 * `% rango` a secas hace más probables los primeros valores. Con un alfabeto eso se traduce
 * en letras iniciales sobre-representadas, que es exactamente por dónde empieza un ataque.
 */
function aleatorioUniforme(rango: number): number {
  const limite = Math.floor(0xffffffff / rango) * rango;
  const buf = new Uint32Array(1);
  let v: number;
  do {
    crypto.getRandomValues(buf);
    v = buf[0];
  } while (v >= limite);
  return v % rango;
}

const OTP_MIN = 100000;
const OTP_RANGO = 900000; // 100000..999999, seis dígitos

/** Código del OTP inverso webapp → WhatsApp. El formato lo matchea `handlers/webhook.js`. */
export function generarCodigoOtp(): string {
  return `NETO-${OTP_MIN + aleatorioUniforme(OTP_RANGO)}`;
}

/** Alfabeto de los espacios compartidos: sin caracteres confundibles a mano (I, O, 0, 1). */
export const ALFABETO_ESPACIO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * Alfabeto del `ref_code`. Espejo de `ALFABETO_REF` en `lib/codigos-seguros.js` del backend
 * (los dos canales emiten el mismo código). Solo MAYÚSCULAS, y no es estética: la
 * mini-landing (`neto.pe/r/CODE`) hace `toUpperCase()` antes de buscar, así que un código con
 * minúsculas no se podría canjear por su propio link.
 */
export const ALFABETO_REF = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * Código de invitación (metas y espacios compartidos). El alfabeto lo elige el llamador
 * porque cada superficie ya tenía el suyo —ambos evitan caracteres confundibles a mano— y
 * cambiarlo invalidaría los códigos que la gente ya tiene pegados en un chat.
 */
export function generarCodigoInvitacion(alfabeto: string, largo: number): string {
  let out = '';
  for (let i = 0; i < largo; i++) out += alfabeto[aleatorioUniforme(alfabeto.length)];
  return out;
}

/**
 * Alfabeto y largo del código que viaja SOLO dentro de un link.
 *
 * 55 chars × 12 = **69.4 bits** (12·log2(55) = 69.376). El alfabeto mixto (byte-idéntico al `ALFABETO_INVITE` de
 * metas) se puede usar acá porque estos códigos **no se escriben a mano**: la UI de deudas
 * y de gastos compartidos ofrece "Copiar link de cobro", nunca un campo donde tipear el
 * código. Ni este lado ni el otro normalizan al buscar (`.eq('invite_code', code)`), así
 * que las minúsculas no son un problema — es la misma razón por la que el de metas se
 * quedó mixto.
 *
 * **El 12 lo fija la DB, no el gusto.** `deudas.invite_code` y
 * `gasto_participantes.invite_code` son `character varying(12)`, y Postgres NO trunca:
 * tira `22001 value too long`. La primera versión de esto emitía 32 chars hex y ninguna
 * de las dos rutas leía el `error` del UPDATE, así que el endpoint devolvía 200 con un
 * código que la fila nunca guardaba y el link quedaba roto para siempre. Lo encontró la
 * revisión adversarial, no la suite ni el harness — el harness corría contra prod, que
 * todavía servía el código viejo de 8 chars, o sea que la única corrida que existía era
 * la de control. Recomprobarlo con la DB y no con la memoria:
 *
 *   select table_name, character_maximum_length from information_schema.columns
 *    where column_name = 'invite_code';
 *
 * Si algún día hacen falta más bits, ensanchar la columna PRIMERO (migración desplegada
 * antes que Vercel) y recién después subir el largo.
 */
const ALFABETO_ENLACE = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
const LARGO_ENLACE = 12;

/**
 * Código de invitación de DEUDAS y GASTOS COMPARTIDOS (S′10 de la auditoría del 10-ago).
 *
 * Antes cada ruta hacía su propio `crypto.randomBytes(4).toString('hex')`: 8 chars hex =
 * **32 bits**, menos que las dos superficies hermanas (espacios 39.6, metas 46.3). La
 * fuente ya era criptográfica —el ataque de PREDICCIÓN que motivó este módulo no aplicaba—
 * así que el guard de `Math.random` pasaba verde sobre esto sin verlo nunca. **Esa es la
 * lección**: un guard que pregunta "¿de dónde salen los bits?" no puede responder "¿cuántos
 * son?", y hacen falta las dos preguntas. Por eso la generación vive acá y hay un guard
 * (`tests/codigos-seguros.test.js`, barre los DOS árboles) que falla si alguien vuelve a
 * escribir un `invite_code` sin pasar por este módulo.
 *
 * Por qué 32 bits importaban acá y no es un nit: medido en prod con
 * `qa-e2e/qa-invite-codes.mjs`, confirmar una invitación de deuda deja una fila espejo
 * `deuda_vinculada_id`, y marcarla pagada propaga `monto_pendiente: 0, estado: 'pagada'`
 * a la deuda del ACREEDOR. Detrás del código no hay un preview: hay escritura sobre la
 * plata de otro. El preview además es público (sin sesión), así que el código es la única
 * credencial de esa puerta.
 *
 * **No invalida ni un link vivo**: solo cambia lo que se emite de acá en más, y el lookup
 * compara exacto. La otra cara, que también hay que decir: los códigos débiles que ya
 * existen siguen débiles. Al 14-ago-2026 son 2, los dos sobre deudas en `estado='pagada'`
 * (una ya confirmada), o sea que detrás de ellos no queda una invitación abierta.
 */
export function generarCodigoEnlace(): string {
  return generarCodigoInvitacion(ALFABETO_ENLACE, LARGO_ENLACE);
}
