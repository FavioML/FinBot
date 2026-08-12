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
