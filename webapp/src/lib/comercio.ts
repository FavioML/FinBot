/**
 * Espejo TypeScript de `canonizarComercio` (services/parsers.js del backend).
 *
 * POR QUÉ HAY DOS COPIAS: el backend es CommonJS y corre en Railway; la webapp es Next.js en
 * Vercel y no puede importar de la raíz del repo. Es el mismo trato que `services/spaces-split.js`,
 * y el precio se paga igual: `tests/services/comercio-parity.test.js` compara las dos
 * implementaciones sobre las mismas entradas y se pone rojo si divergen.
 *
 * POR QUÉ LA WEBAPP TAMBIÉN LO NECESITA: `buscarReglaComercio` (backend) compara el nombre por
 * IGUALDAD exacta en minúsculas. Con el backend escribiendo "BARBANEGRA" y el dashboard
 * escribiendo "IZI*BARBANEGRA", una corrección hecha desde la web fabrica una regla
 * `izi*barbanegra` que no vuelve a matchear nada — el arreglo del prefijo crearía reglas
 * muertas por el único canal que no cubriera. Lo encontró una revisión adversarial.
 *
 * Y hay una segunda razón, más silenciosa: `generarDedupHash` de esta misma carpeta declara
 * "matching backend format". El backend hashea el nombre YA canónico, así que sin canonizar
 * acá esa promesa deja de ser cierta para todo comercio con prefijo de pasarela.
 *
 * El detalle de por qué el separador de espacio NO pela por default vive en el backend, que es
 * el dueño de la decisión. Resumen: sin asterisco no se puede distinguir el prefijo del nombre,
 * y pelar de más fusiona "NIUBIZ PERU" con "IZIPAY PERU" en un "PERU" inventado.
 */

const PASARELAS = [
  'IZI', 'IZIPAY', 'NIUBIZ', 'OPENPAY', 'DLC', 'DLOCAL', 'MPO', 'PYU',
  'PAGOEFECTIVO', 'VN', 'VISANET', 'CULQI', 'SAFETYPAY', 'MERCADOPAGO', 'MPAGO',
];
const PASARELAS_ALT = PASARELAS.join('|');
const QR_OPCIONAL = '(?:\\s+QR)?';
const RE_PREFIJO_ASTERISCO = new RegExp('^(?:' + PASARELAS_ALT + ')' + QR_OPCIONAL + '\\s*\\*+\\s*(.+)$', 'i');
const RE_PREFIJO_ESPACIO = new RegExp('^(?:' + PASARELAS_ALT + ')' + QR_OPCIONAL + '\\s+(.+)$', 'i');
const RE_SOLO_PASARELA = new RegExp('^(' + PASARELAS_ALT + ')' + QR_OPCIONAL + '[\\s*]*$', 'i');

export function esPasarelaSola(comercio: unknown): boolean {
  if (!comercio || typeof comercio !== 'string') return false;
  return RE_SOLO_PASARELA.test(comercio.trim());
}

export function canonizarComercio<T>(comercio: T, opts?: { separadorEspacio?: boolean }): T | string {
  if (!comercio || typeof comercio !== 'string') return comercio;
  const limpio = comercio.replace(/\s+/g, ' ').trim();
  if (!limpio) return comercio;
  const solo = limpio.match(RE_SOLO_PASARELA);
  if (solo) return solo[1];
  const m = limpio.match(RE_PREFIJO_ASTERISCO)
    || (opts && opts.separadorEspacio ? limpio.match(RE_PREFIJO_ESPACIO) : null);
  if (m && m[1] && m[1].trim()) return m[1].trim();
  return limpio;
}
