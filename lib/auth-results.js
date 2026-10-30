// Lectura del header Authentication-Results (RFC 8601) que Gmail antepone a cada correo que
// recibe. Lo usa `gmail.js` para decidir si un correo de remitente desconocido lo mandó de
// verdad un banco. Sin dependencias a propósito: Node no trae parser de este header y la API de
// Gmail no expone el veredicto DKIM, solo los headers crudos.

/**
 * Dominios cuya firma DKIM vale como "esto lo mandó el banco", agrupados por institución para
 * exigir ALINEACIÓN: el dominio real del From tiene que ser del mismo banco que firmó (ver
 * `tieneDkimAlineadoDeBanco`).
 *
 * Lista EXPLÍCITA y conservadora: cada dominio está porque el banco publica un registro DMARC
 * propio en él, no porque aparezca en `REMITENTES_BANCARIOS`. La diferencia importa:
 * `scotiabank.pe` y `plin.pe` están en esa lista y NO tienen DMARC (el primero ni siquiera
 * responde NS), y un dominio que el banco no controla lo puede registrar cualquiera y firmar con
 * su propia clave. Verificado el 30-oct-2026; para recomprobar un dominio o sumar uno nuevo:
 *   nslookup -type=TXT _dmarc.<dominio> 8.8.8.8
 * La política tiene que ser quarantine o reject, porque la alineación se apoya en ella (ver
 * `tieneDkimAlineadoDeBanco`): por eso NO está bancoripley.com.pe (p=none), y Scotiabank va sin
 * subdominios porque publica `sp=none`.
 *
 * Un subdominio cuenta (`email.bcp.com.pe`, `avisos.interbank.pe`). Yape va con BCP porque es
 * del BCP (sus MX son `mx0Xpp.bcp.com.pe`), así que un aviso de Yape firmado por bcp.com.pe alinea.
 */
const BANCOS_DKIM = [
  { banco: 'bcp', dominios: ['bcp.com.pe', 'notificacionesbcp.com.pe', 'viabcp.com', 'yape.pe', 'yape.com.pe'] },
  { banco: 'interbank', dominios: ['interbank.pe', 'netinterbank.com.pe'] },
  { banco: 'bbva', dominios: ['bbva.pe', 'bbva.com'] },
  { banco: 'scotiabank', dominios: ['scotiabank.com.pe'], sinSubdominios: true },
  { banco: 'falabella', dominios: ['bancofalabella.pe'] },
  { banco: 'banbif', dominios: ['banbif.com.pe'] },
  { banco: 'mibanco', dominios: ['mibanco.com.pe'] },
  { banco: 'huancayo', dominios: ['cajahuancayo.com.pe'] },
  { banco: 'trujillo', dominios: ['cajatrujillo.com.pe'] },
  { banco: 'ica', dominios: ['cmacica.com.pe'] },
];

const DOMINIO_VALIDO = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** A qué banco pertenece un dominio (o subdominio), o null. Un dominio mal formado es null. */
function bancoDeDominio(dominio) {
  const d = (dominio || '').trim().toLowerCase().replace(/\.$/, '');
  if (!DOMINIO_VALIDO.test(d)) return null;
  const hit = BANCOS_DKIM.find(b => b.dominios.some(base => d === base || (!b.sinSubdominios && d.endsWith('.' + base))));
  return hit ? hit.banco : null;
}

function valorHeader(headers, nombre) {
  const h = (headers || []).find(x => (x.name || '').toLowerCase() === nombre);
  return h ? (h.value || '') : null;
}

/**
 * Parte el valor de Authentication-Results en sus cláusulas: borra los comentarios —que pueden
 * anidarse, admiten `\)` escapado y llevan texto del remitente, como la dirección del sobre en el
 * del SPF— y corta en los `;` que no estén dentro de comillas. Un `split(';')` crudo dejaría que un
 * `dkim=pass header.d=bcp.com.pe` metido en un comentario se leyera como cláusula.
 *
 * Dentro de un comentario las comillas NO cuentan (RFC 5322), así que un `)` adentro de una parte
 * local entrecomillada cierra el comentario y lo que sigue sí se lee como cláusula. Es el parseo
 * correcto de un header malicioso, no un bug que se pueda arreglar acá: por eso
 * `firmasDkimValidas` rechaza entero un header con comillas.
 */
function clausulasAuthResults(valor) {
  const clausulas = [];
  let actual = '';
  let profundidad = 0;
  let enComillas = false;
  for (let i = 0; i < valor.length; i++) {
    const c = valor[i];
    if (profundidad > 0) {
      if (c === '\\') i++;
      else if (c === '(') profundidad++;
      else if (c === ')') profundidad--;
      continue;
    }
    if (enComillas) {
      actual += c;
      if (c === '\\') actual += valor[++i] || '';
      else if (c === '"') enComillas = false;
      continue;
    }
    if (c === '"') { enComillas = true; actual += c; continue; }
    if (c === '(') { profundidad = 1; actual += ' '; continue; }
    if (c === ';') { clausulas.push(actual.trim()); actual = ''; continue; }
    actual += c;
  }
  clausulas.push(actual.trim());
  return clausulas;
}

/**
 * Dominios de las firmas DKIM que Gmail dio por buenas. Mira SOLO el primer Authentication-Results,
 * y solo si lo escribió `mx.google.com`: Gmail antepone el suyo al recibir, así que el de arriba es
 * el de Gmail y cualquiera más abajo vino dentro del correo. Toma `header.d`, o el dominio de
 * `header.i` (el que pone Gmail; por RFC 6376 el `i=` es el dominio firmante o un subdominio suyo).
 *
 * **Un header con comillas no aporta ninguna firma.** Lo único entrecomillado que Gmail puede
 * escribir ahí es una parte local del sobre SMTP, que elige el remitente: con
 * `MAIL FROM:<"a)b;dkim=pass header.d=bancoripley.com.pe;("@evil.com>` el `)` cierra el
 * comentario del SPF y queda suelta una cláusula falsa (ejecutado contra este parser en la
 * revisión del 30-oct-2026). Sin comillas una parte local no puede llevar `(`, `)`, `;` ni
 * espacios, así que la inyección no tiene con qué armarse. El costo es descartar un aviso real
 * cuyo sobre venga entrecomillado, y ningún banco manda así.
 */
function firmasDkimValidas(headers) {
  const ar = valorHeader(headers, 'authentication-results');
  if (ar === null || ar.includes('"')) return [];
  const [authserv, ...clausulas] = clausulasAuthResults(ar);
  if ((authserv.split(/\s+/)[0] || '').toLowerCase() !== 'mx.google.com') return [];
  const dominios = [];
  for (const clausula of clausulas) {
    const [metodo, ...props] = clausula.split(/\s+/);
    if ((metodo || '').toLowerCase() !== 'dkim=pass') continue;
    for (const p of props) {
      const m = /^header\.(d|i)=(.+)$/i.exec(p);
      if (!m) continue;
      dominios.push((m[1].toLowerCase() === 'i' ? m[2].slice(m[2].lastIndexOf('@') + 1) : m[2]).toLowerCase());
    }
  }
  return dominios;
}

/**
 * ¿Gmail verificó una firma DKIM del MISMO banco al que pertenece el From?
 *
 * La alineación es la segunda defensa contra un error del parser. Para pasar, el From real tiene
 * que ser de un dominio bancario, y entonces Gmail le aplica el DMARC del banco: todos los de
 * `BANCOS_DKIM` publican p=quarantine o p=reject, así que un From falsificado cae en spam y
 * `messages.list` ni lo lista. Sin alineación, un `dkim=pass` colado en el header alcanzaba con un
 * From de cualquier dominio.
 */
function tieneDkimAlineadoDeBanco(headers, dominioFrom) {
  const banco = bancoDeDominio(dominioFrom);
  if (!banco) return false;
  return firmasDkimValidas(headers).some(d => bancoDeDominio(d) === banco);
}

/** Lo que el log de un descarte puede decir sin el cuerpo: las firmas que vio Gmail. */
function resumenDkim(headers) {
  const ar = valorHeader(headers, 'authentication-results');
  if (ar === null) return 'sin Authentication-Results';
  return clausulasAuthResults(ar).filter(c => /^dkim=/i.test(c)).join(' | ').substring(0, 200) || 'sin DKIM';
}

module.exports = { BANCOS_DKIM, bancoDeDominio, clausulasAuthResults, firmasDkimValidas, tieneDkimAlineadoDeBanco, resumenDkim };
