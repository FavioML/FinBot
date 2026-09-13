// ¿Este texto le PIDE o le MUESTRA un número a alguien que no lo compartió?
//
// Lo usa `qa-bsuid-alta.mjs` sobre cada respuesta del alta por BSUID: esa persona ocultó su
// número, así que el bot no puede pedírselo como si fuera obvio ni mostrarle uno. Tampoco puede
// mostrarle el BSUID (es un identificador interno) ni dejar el hueco de un valor que no había.
//
// QUÉ ES Y QUÉ NO. Es una ALARMA sobre formas conocidas, no una prueba de que el copy no pide un
// número. Tres revisiones adversariales seguidas (12-sep) encontraron la frase siguiente que un
// regex no enumeraba, y la cuarta la va a encontrar igual: pedir un número en castellano tiene
// infinitas formas. Lo que sí garantiza que el bot no le MUESTRE su número a esta persona es
// estructural: en este camino el código no tiene ningún número de ella que interpolar. Esto
// cubre lo que se puede escribir sin querer, y cada evasión encontrada queda fijada en
// `tests/qa-e2e-copy-sin-numero.test.js`.
//
// Cómo decide:
//   · normaliza: NFKC, sin diacríticos ni marcas (eso también se lleva el keycap de "9 en
//     recuadro") y sin caracteres de formato invisibles (el ancho cero dentro de "número");
//   · busca el PEDIDO, no la palabra: "tu WhatsApp", "pásame tu celu", "a qué número", "número de
//     teléfono". La palabra sola no alcanza: el copy real dice "por WhatsApp" y "si cambias de
//     teléfono", y ninguno de los dos le pide nada a nadie;
//   · 7 o más dígitos con cualquier separador entre ellos es un teléfono, salvo que la tira entera
//     sea un monto (precedido de `S/` o `$` y con forma de monto) o un número de Neto (el Yape que
//     el alta Pro muestra a propósito);
//   · en los links mira host, path, fragmento y parámetros; el token firmado de activación (`t`)
//     solo se exime si no es un número pelado.
//
// Límites declarados, que el test también fija para que se vean: letras en lugar de dígitos
// ("933 O14 5O5") y el sufijo del BSUID enmascarado ("…def456") pasan.

const NUMEROS_DE_NETO = new Set(['970398192', '933014505', '51933014505']);
const OBJETO = '(numer[o0]s?|numerito|nros?\\.?|num\\.?|n[°º]|#|whatsapp|wsp|wasap|celu(lar)?(es)?|cel+|cell|movil(es)?|telefonos?|telf?\\.?|tlf|fono|fijo|linea|contacto|cuenta\\s+de\\s+whatsapp)';
const FIN = '(?![\\p{L}\\p{N}])';
const PIDE = [
  new RegExp('(^|[^\\p{L}\\p{N}])(tu|tus|su|sus|el|un|mi|mis|al|del)\\s+' + OBJETO + FIN, 'iu'),
  /numer[o0]s?\s+(de\s+)?(telefono|celular|whatsapp|movil|contacto)/iu,
  new RegExp('(^|[^\\p{L}\\p{N}])a\\s+que\\s+' + OBJETO + FIN, 'iu'),
  new RegExp('(pasame|pasas|mandame|mandas|enviame|envias|escribeme|dame|das|comparteme|compartes|confirmame|confirmas|dejame|dejas|ingresa|pon|dime|indicame|indica|registra)\\s+(\\S+\\s+){0,3}' + OBJETO + FIN, 'iu'),
];
const TIRA_DE_DIGITOS = /\p{Nd}(?:[^\p{L}\p{N}\n]{0,3}\p{Nd}){6,}/gu;
const FORMA_DE_MONTO = /^\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?$|^\d+(?:[.,]\d{1,2})?$/;
const CLAVES_DE_TOKEN = new Set(['t']);

const normalizar = (t) => String(t || '').normalize('NFKC').normalize('NFD')
  .replace(/[\p{M}\p{Cf}]/gu, '').normalize('NFC');

// Las tiras de 7+ dígitos que no son un monto ni un número de Neto.
function tirasConFormaDeTelefono(texto) {
  const out = [];
  for (const m of texto.matchAll(TIRA_DE_DIGITOS)) {
    const tira = m[0];
    if (NUMEROS_DE_NETO.has(tira.replace(/\D/g, ''))) continue;
    const antes = texto.slice(Math.max(0, m.index - 5), m.index);
    if (/(S\/|US\$|\$)\s*$/.test(antes) && FORMA_DE_MONTO.test(tira)) continue;
    out.push(tira);
  }
  return out;
}

function decodificar(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * @param {string} texto  la respuesta tal como la mandaría el bot
 * @param {{ bsuid?: string, sufijo?: string }} [identidad]  lo que no puede aparecer
 * @returns {string[]} los problemas encontrados; vacío si el texto está bien
 */
export function problemasDeCopy(texto, { bsuid = null, sufijo = null } = {}) {
  const t = normalizar(texto);
  const urls = t.match(/https?:\/\/\S+/g) || [];
  const sinUrls = t.replace(/https?:\/\/\S+/g, ' ');
  const p = [];

  if (PIDE.some((re) => re.test(sinUrls))) p.push('pide un número (o nombra el del usuario)');

  if (tirasConFormaDeTelefono(sinUrls).length) p.push('muestra algo con forma de teléfono');
  for (const crudo of urls) {
    let u;
    try { u = new URL(crudo.replace(/[)\].,;!?]+$/, '')); } catch { p.push('lleva un link ilegible: ' + crudo); continue; }
    const partes = [u.hostname, decodificar(u.pathname), decodificar(u.hash)];
    if (partes.some((x) => tirasConFormaDeTelefono(x).length) || /(^|\.)wa\.me$/i.test(u.hostname)) {
      p.push('lleva un número dentro de un link');
    }
    for (const [k, v] of u.searchParams) {
      const numeroPelado = /^\+?\p{Nd}{6,}$/u.test(v);
      if (numeroPelado || (!CLAVES_DE_TOKEN.has(k) && /\p{Nd}{6,}/u.test(v))) {
        p.push('lleva un número como parámetro de un link (' + k + ')');
      }
    }
  }

  const bajo = t.toLowerCase();
  if ((bsuid && t.includes(bsuid)) || /PE\.qa/i.test(t) || (sufijo && bajo.includes(String(sufijo).toLowerCase()))) {
    p.push('muestra el BSUID');
  }

  if (/\b(null|undefined|NaN)\b|\[object \w+\]|Invalid Date/.test(t)) p.push('interpola un valor vacío o un objeto');
  // El "termina en dos puntos" se mira sobre el texto CON los links: sin ellos, "sin contraseñas:"
  // seguido del link de activación quedaba terminando en ":" y el copy real salía marcado.
  if (/\*\s*\*|(?<![\p{L}\p{N}])_[ \t]*_(?![\p{L}\p{N}])|“\s*”|«\s*»|"\s*"|\(\s*\)|\S {2,}\S| [!?.,;:](?=\s|$)/u.test(sinUrls) || /:\s*$/.test(t)) {
    p.push('queda el hueco de un valor interpolado vacío');
  }
  return p;
}
