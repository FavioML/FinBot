/**
 * Qué se guarda como el NOMBRE de una persona (clase 7 de "respuestas malas del día 0", 30-sep-2026).
 *
 * Medido sobre 60 días: 3 de 49 nombres del alta eran frases ("Como funciona?" quedó "Como",
 * "Quisiera registrarme" quedó "Quisiera", "Debe estar en apuros económicos." quedó "Debe"), y
 * el renombre guardó "Nvf" desde "Esto lo quiero usar para mi negocio…", "Hola" desde "hola,
 * puedes cambiarme de nombre?" y "Lkm.84". Neto usa el nombre en cada saludo, así que el error
 * no se ve una vez: se repite todos los días.
 *
 * Las dos guardas fallan hacia NO guardar. Un nombre real rechazado cuesta una repregunta (alta)
 * o un "escríbeme 'llámame Ana'" (renombre); una frase aceptada cuesta "Hola, Debe" para siempre.
 *
 * **Límite declarado del alta:** no hay diccionario de nombres. Una lista cerrada de primeras
 * palabras y de palabras funcionales deja pasar una palabra suelta que no está en la lista
 * ("Consultora", "Arequipa", "Soy contadora"). Un diccionario se come los nombres raros, que en
 * el corpus real no son raros (Amorka, Arlly, Engels, Jomar). La red es que la repregunta es UNA:
 * a la segunda, el alta sigue sin nombre. Lo que SÍ se cierra por estructura y no por lista: la
 * pregunta, la frase con palabras funcionales, la cortesía sin presentación ("Ok, entendido" va
 * entero y se rechaza), la coma.
 *
 * **Dos revisiones adversariales seguidas encontraron la misma clase** (01-oct-2026): cada
 * palabra agregada a una lista abría otra, y quitar la cortesía del comienzo para aceptar "Ok,
 * Ana" dejó al descubierto "Ok, entendido" → "Entendido". Por eso el renombre dejó de buscar
 * palabras y pide una FORMA (`CLAUSULA_PEDIDO`), y la cortesía del alta solo se quita delante de
 * una presentación. Los nombres reales del alta y los ataques están en `tests/lib/nombres.test.js`.
 */

// minúsculas, sin tildes, todo lo que no es letra, dígito o apóstrofo → espacio. Es la forma de
// `normalizarOrden` del borrado (`handlers/intents/transacciones.js`), sin compartirla: ese
// archivo es de otra superficie. El apóstrofo (también el curvo de iOS) se queda DENTRO de una
// palabra para que "O'Brien" sea una sola; en los bordes es una comilla y se va ("llámame 'Ana'").
function normalizar(t) {
  return String(t || '').toLowerCase().replace(/[’‘`]/g, "'").normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9' ]+/g, ' ').replace(/(^|\s)'+|'+(?=\s|$)/g, '$1').replace(/\s+/g, ' ').trim();
}

// Saludos con su ortografía de chat ("Holaa", "Ola", "Wenas") y risas. Una lista de literales
// dejaba pasar "Holaa" como nombre: es el defecto original con una letra de más.
const SALUDO = /^(?:h?o+l+a+s*|holi+s?|wena+s?|saludos?|hey+|hi|hello|alo)$/;
// Dos o más sílabas: "Jo" es nombre.
const RISA = /^(?:(?:ja|je|ji|jo|js){2,}j?|xd+|lol)$/;
// Teclazos e interjecciones de 3+ letras: sin vocales ("Hmm", "Jsjs") o una letra repetida
// ("Aaa"). Desde 3 porque "Ng" es apellido.
const SIN_PALABRA = /^(?:[^aeiouy]+|(.)\1+)$/;
// Interjecciones con la letra estirada: "Ahh", "Uff", "Ayy", "Ajá", "Emm".
const INTERJECCION = /^(?:a+h+|e+h+|e+m+|u+f+|a+y+|u+h+|o+h+|a+j+a+)$/;

// Primeras palabras con las que no empieza un nombre: interrogativos, verbos de pedido,
// pronombres, muletillas. "la" NO está ("La Rosa" es apellido) y "su"/"lo"/"le" sí: como primera
// palabra son mucho más seguido el comienzo de una frase reenviada que un apellido chino. "de" y
// "del" están ("De acuerdo", "De nada") con una excepción en `motivoNoEsNombre`: "De la Cruz".
const PRIMERA_NO_NOMBRE = new Set([
  'como', 'cuanto', 'cuanta', 'cuantos', 'cuantas', 'que', 'quien', 'quienes', 'cual', 'cuales',
  'donde', 'cuando', 'por', 'para', 'porque', 'pero', 'de', 'del',
  'quiero', 'quisiera', 'queria', 'quisieramos', 'queremos', 'puedo', 'podria', 'puedes', 'podrias',
  'puede', 'necesito', 'necesitaria', 'deseo', 'desearia', 'tengo', 'tienes', 'tiene', 'hay',
  'debe', 'debo', 'estoy', 'esta', 'estaba', 'estamos', 'busco', 'es', 'son', 'era', 'fue', 'eres',
  'registrar', 'registrarme', 'empezar', 'comenzar', 'iniciar', 'probar', 'usar', 'ver',
  'activar', 'crear', 'dar', 'habla', 'vengo', 'cambia', 'cambiame', 'llamame', 'nombre', 'soy', 'llamo',
  'ayuda', 'ayudame', 'info', 'informacion', 'gracias', 'buenas', 'buenos', 'buen',
  'ok', 'okey', 'okay', 'oki', 'okk', 'si', 'no', 'ya', 'dame', 'dime', 'hazme', 'mandame', 'explicame',
  'oye', 'causa', 'porfa', 'favor', 'perdon', 'perdona', 'disculpa', 'disculpe', 'mucho', 'encantado', 'encantada',
  'me', 'te', 'se', 'le', 'les', 'lo', 'nos', 'mi', 'mis', 'tu', 'tus', 'su', 'sus',
  'el', 'un', 'una', 'unos', 'esto', 'eso', 'este', 'ese', 'esa', 'aqui', 'aca', 'ahi', 'todo',
  'gaste', 'pague', 'compre', 'cobre', 'recibi',
  // Respuestas de una palabra que no son un nombre, sacadas de los ataques a esta guarda.
  'listo', 'lista', 'dale', 'claro', 'bien', 'bueno', 'buena', 'vale', 'perfecto', 'genial',
  'entendido', 'entiendo', 'excelente', 'super', 'chevere', 'bacan', 'adelante', 'siguiente',
  'okis', 'oka', 'sale', 'igual', 'a', 'resumen', 'saldo', 'total', 'manana', 'ahora', 'hoy',
  'pro', 'premium', 'completo', 'completa', 'real', 'apellido', 'apellidos', 'tonto', 'tonta',
  'raro', 'rara', 'complicado', 'complicada', 'dificil', 'fan',
  'precio', 'precios', 'plan', 'planes', 'costo', 'gratis', 'empecemos', 'comencemos', 'empezamos',
  'registrame', 'registreme', 'registro', 'menu', 'inicio', 'neto', 'prueba', 'test', 'bot',
  'amiga', 'amigo', 'bro', 'senor', 'senora', 'nadie', 'anonimo', 'anonima', 'secreto',
  'asi', 'distinto', 'diferente', 'otro', 'otra', 'mal', 'mas', 'vamos', 'opciones', 'ninguno',
  'ninguna', 'nada', 'algo', 'cualquiera', 'verdad', 'mentira', 'bendiciones', 'espera', 'ahorita',
  'luego', 'despues', 'cancelar', 'salir', 'basta', 'borrar', 'eliminar', 'probando', 'consulta',
  'ahorrar', 'ahorro', 'finanzas', 'presupuesto', 'gasto', 'gastos', 'deuda', 'deudas', 'prestamo',
  'pasaje', 'netflix', 'delivery', 'empresa', 'negocio', 'bodega', 'familia', 'interesante',
  'robot', 'humano', 'persona', 'asesor', 'normal', 'lima', 'peru',
  'don', 'dona', 'senorita', 'joven', 'hermano', 'hermana', 'pata',
  // Lo que viene después de "soy" cuando no es un nombre: "Soy nuevo", "Soy profesora".
  'yo', 'nuevo', 'nueva', 'estudiante', 'interesado', 'interesada', 'cliente',
  'usuario', 'usuaria', 'emprendedor', 'emprendedora', 'independiente', 'profesor', 'profesora',
  'ingeniero', 'ingeniera', 'contador', 'contadora', 'mama', 'papa', 'peruano', 'peruana',
  'venezolano', 'venezolana', 'pobre', 'feliz', 'mayor', 'largo', 'timido', 'timida',
  'what', 'how', 'i', 'my', 'please', 'start', 'help', 'stop', 'testing', 'thanks', 'thank', 'yes',
]);

// De la lista de arriba, las que solo valen como PRIMERA palabra porque a mitad de nombre son
// apellido o partícula: "Carlos Lo", "Ana Su", "María de los Ángeles", "Artur Mas", "João Lima".
const SOLO_PRIMERA = new Set(['lo', 'le', 'su', 'de', 'del', 'mas', 'lima']);

// Palabras que, en cualquier posición, delatan una frase. Quedan FUERA a propósito las que viven
// dentro de nombres reales: de, del, la, las, los, y, el, al ("María de los Ángeles", "Ortega y
// Gasset", "Mohamed El Amrani", "Al Fayed") y "mas" (apellido catalán).
const FUNCIONAL = new Set([
  'en', 'que', 'para', 'por', 'con', 'sin', 'mi', 'mis', 'tu', 'tus', 'es', 'son', 'un', 'una',
  'unos', 'como', 'cuando', 'donde', 'porque', 'pero', 'no', 'si', 'ya', 'muy', 'hay', 'me', 'te',
  'se', 'nos', 'les', 'esto', 'eso', 'este', 'esta', 'estoy', 'quiero', 'quisiera', 'puedo',
  'puedes', 'necesito', 'tengo', 'registrar', 'registrarme', 'funciona', 'funcionas', 'ayuda',
  'gracias', 'hola', 'o', 'yape', 'plin', 'cuenta', 'aqui', 'aca', 'desde',
  // muletillas peruanas y de chat pegadas al nombre: "Ana pe", "Soy Ana nomás", "Ana plis"
  'pe', 'nomas', 'plis', 'pls', 'porfa',
  // Días de la semana: piezas de una ráfaga reenviada ("Máximo el sábado"). Sin "domingo", que
  // es nombre.
  'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado',
]);

// Infinitivo con pronombre pegado: "registrarme", "inscribirme", "explicarte". La forma es
// productiva, así que vale más que agregar verbos a la lista. Sin lo/la/le: con ellos
// "Giancarlo" es gianca-r-lo, y lo delató el corpus real de `tests/lib/nombres.test.js`.
const INFINITIVO_CLITICO = /^[a-z]{2,}[aei]r(?:me|te|se|nos)$/;

const MAX_PALABRAS = 6;

/**
 * ¿Este texto PUEDE ser un nombre? Devuelve el motivo del rechazo, o null si pasa.
 * No decide qué parte del mensaje es el nombre: eso lo hace `extraerNombreDelAlta`.
 */
function motivoNoEsNombre(texto) {
  const crudo = String(texto || '').trim();
  if (crudo.length < 2 || crudo.length > 50) return 'largo';
  if (/[?¿]/.test(crudo)) return 'pregunta';
  if (/\d/.test(crudo)) return 'digitos';
  if (/[@/:()[\]{}<>=+*#$%&|\\_]|https?|www\./i.test(crudo)) return 'no_es_nombre';
  if (/[,;]/.test(crudo)) return 'frase';
  const palabras = normalizar(crudo).split(' ').filter(Boolean);
  if (palabras.length === 0) return 'sin_letras';
  if (palabras.length > MAX_PALABRAS) return 'frase_larga';
  const [p0, p1] = palabras;
  const apellidoConDe = p0 === 'de' && ['la', 'los', 'las'].includes(p1);
  if ((PRIMERA_NO_NOMBRE.has(p0) && !apellidoConDe) || INFINITIVO_CLITICO.test(p0) || INTERJECCION.test(p0)) return 'frase';
  // La lista de primeras palabras vale en TODAS las posiciones ("Soy Luis estudiante", "Ana
  // gracias"), menos las que pueden ser apellido a mitad de nombre: "Carlos Lo", "María de los
  // Ángeles", y las iniciales de una letra ("Juan A Pérez").
  const enCualquierLado = (p) => p.length >= 2 && !SOLO_PRIMERA.has(p) && PRIMERA_NO_NOMBRE.has(p);
  if (palabras.slice(1).some(enCualquierLado)) return 'frase';
  if (palabras.some((p) => FUNCIONAL.has(p) || SALUDO.test(p) || RISA.test(p) || INTERJECCION.test(p)
    || INFINITIVO_CLITICO.test(p) || (p.length >= 3 && SIN_PALABRA.test(p.replace(/'/g, ''))))) return 'frase';
  // "la de ventas", "el de la bodega": un artículo seguido de "de"/"que" describe, no nombra.
  // "La Rosa" y "El Amrani" siguen pasando.
  if (palabras.some((p, i) => ['el', 'la', 'los', 'las'].includes(p) && ['de', 'del', 'que'].includes(palabras[i + 1]))) return 'frase';
  return null;
}

// Cortesía que puede ir DELANTE de una presentación: "Hola Neto, soy Ana", "¡Hola! Me llamo
// Ana", "Mucho gusto, soy Ana". Solo se quita si después viene la presentación.
// Sin "que", "si" ni "un" sueltos: abren frases ("Que nombre bonito", "Un nombre falso"). Los
// pares "qué tal", "un gusto" y "mucho gusto" van aparte, en `CORTESIA_PAR`.
const CORTESIA = new Set([
  'mucho', 'gusto', 'encantado', 'encantada', 'igualmente', 'gracias', 'ok', 'okey', 'okay',
  'oki', 'okk', 'neto', 'buenas', 'buenos', 'buen', 'dia', 'dias', 'tardes', 'noches',
  'claro', 'listo', 'bueno', 'dale', 'perfecto',
]);
const CORTESIA_PAR = /^(?:qu[eé] tal|un gusto|mucho gusto)(?=[\s,.;:!¡]|$)[\s,.;:!¡]*/i;
const esCortesia = (palabra) => CORTESIA.has(palabra) || SALUDO.test(palabra) || RISA.test(palabra);

// ANCLADA al comienzo. La regex anterior no tenía ancla ni borde de palabra, así que "es"
// matcheaba adentro de "Ines Garcia" (guardaba "Garcia") y cualquier "soy …" a mitad de una frase
// reenviada se volvía nombre. `[\s\S]` y no `.`: con un salto de línea, `.` no matcheaba y
// "Me llamo Ana\nquiero registrar…" se evaluaba entero. "nombre" sin "es" solo con dos puntos
// ("Nombre: Ana"): sin ellos, "Un nombre falso" daba "Falso".
const PRESENTACION = /^(?:(?:me llamo|mi nombre es|ll[aá]mame|puedes llamarme|me puedes llamar|me dicen|yo soy|soy)\s*:?\s+|(?:mi )?nombre\s*:\s*)([\s\S]+)$/i;
// Después de una presentación esto no abre un nombre: "Soy la dueña", "Soy de Lima", "Me dicen
// la flaca", "Mi nombre es de usuario".
const NO_TRAS_PRESENTACION = new Set(['la', 'el', 'los', 'las', 'un', 'una', 'de', 'del']);

// Quita del comienzo la cortesía con su puntuación ("Hola Neto, ", "¡Hola! ", "Mucho gusto, ").
function sinCortesiaInicial(texto) {
  let resto = texto;
  for (;;) {
    const par = resto.replace(/^[¡]+/, '').match(CORTESIA_PAR);
    if (par) { resto = resto.replace(/^[¡]+/, '').slice(par[0].length); continue; }
    const m = resto.match(/^[¡]*([^\s,.;:!¡]+)[\s,.;:!¡]*/);
    if (!m || !esCortesia(normalizar(m[1]))) return resto;
    resto = resto.slice(m[0].length);
  }
}

// Los emojis no son parte del nombre ("Ana 😊" se guarda "Ana"), y con ellos el tono de piel,
// las banderas, el selector de variación del ❤️ y el ZWJ, que si no quedan sueltos e invisibles.
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\p{Variation_Selector}\p{Join_Control}]/gu;

/**
 * El nombre que se guarda en el alta (paso 100), o null con el motivo.
 * @returns {{ nombre: string|null, motivo: string|null }}
 */
function extraerNombreDelAlta(msg) {
  const texto = String(msg || '').replace(EMOJI, '').trim();
  // Una pregunta en CUALQUIER parte descarta el mensaje, con presentación o sin ella. Cortar el
  // nombre en la puntuación se llevaba el "?": "¿Qué nombre pongo?" quedaba "Pongo" y "Nombre
  // completo?" quedaba "Completo" (tercera revisión, 01-oct-2026). Costo: "Me llamo Ana. ¿Cómo
  // funciona?" repregunta.
  if (/[?¿]/.test(texto)) return { nombre: null, motivo: 'pregunta' };
  const m = sinCortesiaInicial(texto).match(PRESENTACION);
  let candidato;
  if (m) {
    // Con presentación, el nombre termina en la primera puntuación ("Soy Ana, quiero
    // registrarme") o en un " y " / " pero " ("Me llamo Ana y quiero registrarme"). Costo: "Soy
    // Ortega y Gasset" queda en "Ortega".
    candidato = m[1].split(/[,.;:!\n]/)[0].split(/\s+(?:y|pero)\s+/i)[0].trim();
    if (NO_TRAS_PRESENTACION.has(normalizar(candidato).split(' ')[0])) return { nombre: null, motivo: 'frase' };
  } else {
    // Sin presentación va el mensaje ENTERO, cortesía incluida: "Ok, entendido" no puede quedar
    // en "Entendido", y por eso "Ok, Ana" cuesta una repregunta.
    candidato = texto;
  }
  candidato = candidato.replace(/[.,!¡…]+$/, '').replace(/^[¡]+/, '').trim();
  const motivo = motivoNoEsNombre(candidato);
  if (motivo) return { nombre: null, motivo };
  const nombre = candidato.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  return { nombre, motivo: null };
}

// ─── Renombre ────────────────────────────────────────────────────────────────────────────────
//
// El pedido es una CLÁUSULA (un tramo entre puntuación) con la forma
//   [prefijos permitidos] disparador Nombre [cortesía final]
// y no "el nombre aparece en algún lado". Con la búsqueda por palabras, "cambia mi nombre" daba
// "Nombre", "dime cuánto le debo a Juan" daba "Juan", y la negación había que adivinarla: "nunca
// me llames Ana" pasaba y "No, me llamo Pedro" no. Con la forma, la negación queda afuera sola
// ("no", "nunca", "deja de" no son prefijos permitidos) y la coma de "No, me llamo Pedro" separa
// la cláusula que importa.
//
// Sin "ponme" suelto ("ponme Spotify") ni "nombre a" suelto ("cambia el nombre a Viaje" puede ser
// una meta): el nombre de la persona se pide con "mi nombre" o "cámbiame el nombre".
const DISPARADORES = [
  'llamame', 'llamarme', 'llamar', 'decir', 'me llamo', 'me llames', 'me llamaras', 'me llaman',
  'mi nombre es', 'mi nombre real es', 'mi nombre a', 'mi nombre por', 'mi nombre',
  'cambiame el nombre a', 'cambiame el nombre por', 'ponme de nombre',
  'soy', 'yo soy', 'dime', 'decirme', 'me digas', 'me dicen', 'tratame de', 'tratame como',
  'call me', 'my name is', "i'm", 'i am',
];
const PREFIJOS = new Set([
  'hola', 'neto', 'oye', 'ok', 'bueno', 'mejor', 'ahora', 'y', 'pero', 'perdon', 'disculpa', 'porfa',
  'quiero', 'quisiera', 'prefiero', 'gustaria', 'que', 'puedes', 'podrias', 'me', 'cambia', 'cambiar',
  'actualiza', 'actualizar', 'pon', 'en', 'realidad', 'please', 'solo', 'desde', 'a', 'partir', 'de', 'hoy',
]);
// Lo que puede seguir al nombre en la misma cláusula.
const FINALES = new Set([
  'por', 'favor', 'porfavor', 'porfa', 'fa', 'xfa', 'plis', 'pls', 'please', 'gracias', 'pe', 'nomas',
  'desde', 'ahora', 'hoy', 'en', 'adelante', 'a', 'partir', 'de',
]);
// Las cláusulas que rodean al pedido tienen que ser inofensivas. Antes: "No, me llamo Pedro",
// "Hola, …". Después: "…, gracias". Sin esto, "mi nombre es Juan, no lo cambies", "llámame Ana.
// Es broma" y "Dime Carlos, cuánto gasté" pasaban (tercera revisión, 01-oct-2026).
const ANTES_OK = new Set(['no', 'ok', 'okey', 'si', 'hola', 'neto', 'oye', 'perdon', 'disculpa', 'mira', 'bueno', 'claro', 'buenas']);
const DESPUES_OK = new Set(['gracias', 'porfa', 'por', 'favor', 'porfavor', 'plis', 'pls', 'please', 'xfa', 'ok']);
// Una pregunta no es un pedido ("¿soy Pro?", "me llamo Ana? jaja"), salvo la forma cortés
// "¿me puedes llamar Ana?".
const NIEGA_NOMBRE = /^(?:ya )?no (?:me llamo|soy|me digas|me llames|me dicen|es) [a-z' ]+$/;
const PREGUNTA_CORTES = /^(?:(?:hola|neto|oye) )*(?:me )?(?:puedes|podrias)\b/;

function esClausulaDePedido(clausula, n) {
  const c = ' ' + clausula;
  for (const d of DISPARADORES) {
    // Una sola búsqueda basta: delante de una segunda aparición está el disparador mismo, y
    // ningún disparador es un prefijo permitido.
    const aguja = ' ' + d + ' ' + n;
    const i = c.indexOf(aguja);
    if (i < 0) continue;
    const antes = c.slice(0, i).split(' ').filter(Boolean);
    // Lo que sigue al nombre: nada o cortesía. Así "dime Ana" no matchea en "dime Anabel".
    const despues = c.slice(i + aguja.length);
    if (despues && !despues.startsWith(' ')) continue;
    if (antes.every((p) => PREFIJOS.has(p)) && despues.split(' ').filter(Boolean).every((p) => FINALES.has(p))) return true;
  }
  return false;
}

/**
 * Renombre (`cambiar_nombre`): el nombre que devolvió el modelo solo vale si la persona lo
 * PIDIÓ. Es la clase del sujeto inventado del borrado (`ELIMINAR_SUJETO_NO_DICHO`, efb1625):
 * un campo que el mensaje no nombra se descarta.
 *
 * Vale si puede ser un nombre y además el mensaje ES el nombre (la respuesta a "¿cómo te
 * llamo?") o alguna cláusula del mensaje es un pedido con ese nombre (ver arriba).
 *
 * @returns {string|null} motivo del rechazo, o null si el nombre vale.
 */
function motivoNombreNoDicho(nombreNuevo, msg) {
  const motivo = motivoNoEsNombre(nombreNuevo);
  if (motivo) return motivo;
  const n = normalizar(nombreNuevo);
  // "me llamó la atención" pierde la tilde y queda "me llamo la atencion": un nombre que empieza
  // con artículo no se acepta en el renombre (en el alta, "La Rosa" escrito solo sí).
  if (NO_TRAS_PRESENTACION.has(n.split(' ')[0])) return 'frase';
  if (normalizar(msg) === n) return null;
  // Cada cláusula con la puntuación que la cierra. Sin los dos puntos: "actualiza mi nombre: Ana"
  // es una sola cláusula.
  const clausulas = [...String(msg || '').matchAll(/([^,.;!?¿¡\n]+)([,.;!?¿¡\n]*)/g)]
    .map(([, t, cierre]) => ({ texto: normalizar(t), pregunta: cierre.includes('?') }))
    .filter((c) => c.texto);
  const i = clausulas.findIndex((c) => esClausulaDePedido(c.texto, n)
    && (!c.pregunta || PREGUNTA_CORTES.test(c.texto)));
  if (i < 0) return 'no_pedido';
  const soloDe = (set) => (c) => !c.pregunta && c.texto.split(' ').every((p) => set.has(p) || RISA.test(p));
  // Antes del pedido también vale negar el nombre anterior: "no me llamo Juan, me llamo Pedro".
  const niegaOtroNombre = (c) => !c.pregunta && NIEGA_NOMBRE.test(c.texto);
  if (!clausulas.slice(0, i).every((c) => soloDe(ANTES_OK)(c) || niegaOtroNombre(c))
    || !clausulas.slice(i + 1).every(soloDe(DESPUES_OK))) return 'no_pedido';
  return null;
}

module.exports = { extraerNombreDelAlta, motivoNoEsNombre, motivoNombreNoDicho, normalizar };
