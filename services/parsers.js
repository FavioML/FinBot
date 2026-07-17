const { openai } = require('../lib/ai');
const { hoyPeru } = require('../lib/dates');
const log = require('../lib/logger');

// Razones sociales → nombre comercial limpio (GPT no siempre normaliza)
const COMERCIO_MAP = {
  'SPSA PLAZA VEA': 'Plaza Vea',
  'SPSA TOTTUS': 'Tottus',
  'DLOCAL*NETFLIX': 'Netflix',
  'DLOCAL*DISNEY': 'Disney+',
  'DLOCAL*SPOTIFY': 'Spotify',
  'DLOCAL*HBOMAX': 'Max',
};

function normalizarComercio(comercio) {
  if (!comercio) return comercio;
  const upper = comercio.trim().toUpperCase();
  for (const [raw, clean] of Object.entries(COMERCIO_MAP)) {
    if (upper === raw) return clean;
  }
  return comercio;
}

// Extracción determinística de los últimos 4 dígitos de la tarjeta/cuenta a partir
// del texto de una notificación bancaria. Las notificaciones peruanas exponen la
// tarjeta con patrones muy estables ("terminada en 1234", "****1234"), así que un
// regex es más confiable que pedírselo al LLM. Devuelve string de 4 dígitos o null.
//
// Conservador a propósito: solo dispara con un keyword de tarjeta ("terminada en",
// "termina en", "terminación", "finaliza en", "acaba en") o una máscara (****, ····,
// xxxx, ●●●●) inmediatamente antes de los 4 dígitos. Así no captura montos, fechas ni
// códigos de operación sueltos.
const LAST4_PATTERNS = [
  /(?:terminad[ao]s?|que\s+termina|termina|terminaci[oó]n|finaliza(?:d[ao])?|acaba)\s+(?:en\s+)?[:#nro.\s-]*?(\d{4})\b/i,
  /(?:[*x·●•]\s?){2,}(\d{4})\b/i,
];

function extraerLast4(texto) {
  if (!texto || typeof texto !== 'string') return null;
  for (const re of LAST4_PATTERNS) {
    const m = texto.match(re);
    if (m && /^\d{4}$/.test(m[1])) return m[1];
  }
  return null;
}

// Normaliza un last4 recibido de una fuente no confiable (ej. campo emitido por el
// modelo de visión): solo acepta exactamente 4 dígitos, cualquier otra cosa → null.
function normalizarLast4(valor) {
  if (valor == null) return null;
  const s = String(valor).trim();
  return /^\d{4}$/.test(s) ? s : null;
}

const BANK_PARSER_PROMPT = `Eres un parser experto de notificaciones bancarias peruanas. Devuelve SOLO JSON sin markdown:
{ "tipo":"gasto"|"ingreso", "monto":numero, "moneda":"PEN"|"USD", "comercio":"nombre limpio del comercio", "categoria":"ver lista", "subcategoria":"ver lista", "banco":"BCP|Interbank|BBVA|Scotiabank|Yape|Plin|Falabella|Ripley|BanBif|Mibanco|CMAC|Otro", "metodo_pago":"Debito|Credito|Transferencia|Yape|Plin|Efectivo|Otro", "fecha":"YYYY-MM-DD", "descripcion_original":"texto original" }

CATEGORÍAS Y SUBCATEGORÍAS OBLIGATORIAS (usa EXACTAMENTE estos valores, sin variantes):

Alimentación:    delivery | restaurante | supermercado | mercado | cafeteria | snacks
Transporte:      uber_cabify | taxi | bus_micro | metro_bus | gasolina | peaje | estacionamiento
Vivienda:        alquiler | mantenimiento | electricidad | agua | gas | internet | cable
Salud:           farmacia | medico | clinica | laboratorio | seguro_salud | optica
Entretenimiento: streaming | suscripciones | cine | juegos | bares_clubs | eventos | hobbies
Compras:         ropa | calzado | electronico | hogar | belleza | mascotas
Educación:       universidad | instituto | curso_online | utiles | idiomas | colegios
Finanzas:        prestamo | tarjeta_credito | seguro | ahorro | inversion | comision_banco
Trabajo_Negocio: herramientas | publicidad | oficina | logistica | contador
Otros:           regalo | donacion | multa | viaje | sin_categoria

REGLAS DE NORMALIZACIÓN DE COMERCIOS:
- Rappi / PedidosYa / Glovo / DLC*PedidosYa → comercio limpio, categoria: Alimentación, subcategoria: delivery
- McDonald's / KFC / Bembos / Pizza Hut / restaurantes / huariques → Alimentación > restaurante
- SPSA / SPSA TOTTUS / Wong / Metro / Plaza Vea / Tottus / supermercados → Alimentación > supermercado
- Starbucks / Juan Valdez / café → Alimentación > cafeteria
- Uber / Cabify / InDriver / Beat → Transporte > uber_cabify
- Repsol / Primax / Pecsa / Petroperu / Grifo / gasolineras → Transporte > gasolina
- Peajes / Telepeaje / RUTAS → Transporte > peaje
- Estacionamiento / playa de estacionamiento → Transporte > estacionamiento
- Metropolitano / bus / combi / micro → Transporte > metro_bus
- Luz del Sur / Enel / Electrodunas / Hidrandina → Vivienda > electricidad
- SEDAPAL / EPS → Vivienda > agua
- Claro / Entel / Movistar hogar / Bitel / internet → Vivienda > internet
- TV cable / cableoperadora → Vivienda > cable
- Gas LP / GLP / Zeta Gas → Vivienda > gas
- DLOCAL*NETFLIX / Netflix / Disney+ / HBO / Spotify / YouTube Premium / Apple Music / Apple TV → Entretenimiento > suscripciones
- Apple.com/bill / Apple iCloud / Google One / Google Drive / Google Storage → Entretenimiento > suscripciones
- Claude / ChatGPT / OpenAI / suscripciones de software / apps recurrentes → Entretenimiento > suscripciones
- Cineplanet / Cinemark / UVK → Entretenimiento > cine
- Google Play / App Store / Steam / Xbox / PlayStation → Entretenimiento > juegos
- Bares / discotecas / pubs → Entretenimiento > bares_clubs
- Saga / Ripley / H&M / Zara / Forever 21 → Compras > ropa
- Bata / Marathon / Adidas / Nike → Compras > calzado
- Hiraoka / Falabella / Mercado Libre / Amazon / electrónica → Compras > electronico
- Promart / Sodimac / Maestro → Compras > hogar
- Natura / Unique / Perfumerías / salón / spa / barbería → Compras > belleza
- Veterinaria / mascotas / Petco → Compras > mascotas
- Inkafarma / MiFarma / Boticas / Farmacéxito → Salud > farmacia
- Clínicas / hospitales / emergencias → Salud > clinica
- Laboratorio / análisis → Salud > laboratorio
- Coursera / Udemy / Platzi / Duolingo → Educación > curso_online
- ICPNA / Británico / Berlitz / idiomas → Educación > idiomas
- Universidad / instituto / SENATI / ISEP → Educación > universidad
- Colegio / pensión escolar → Educación > colegios
- Cuota préstamo BCP/BBVA/Interbank → Finanzas > prestamo
- Pago tarjeta crédito / TC → Finanzas > tarjeta_credito
- SOAT / seguro vehicular / seguro de vida → Finanzas > seguro
- Comisión banco / ITF / porte → Finanzas > comision_banco
- Software / SaaS / herramientas trabajo → Trabajo_Negocio > herramientas
- Meta Ads / Google Ads / publicidad → Trabajo_Negocio > publicidad

REGLAS POR BANCO:
- BCP transferencia a terceros / interbancaria (BCP, BBVA, Interbank, Scotiabank cuando dice "Realizaste una transferencia" + "Enviado a"):
  * tipo: gasto
  * metodo_pago: "Transferencia"
  * El campo "Mensaje" del correo es la SEÑAL PRIMARIA de categoría/subcategoría (más fuerte que el beneficiario).
    Ejemplos:
      "Cuota 3 turismo" / "viaje" / "tour" → Otros > viaje
      "Alquiler" / "renta departamento" → Vivienda > alquiler
      "Préstamo" / "devuelvo plata" → Finanzas > prestamo
      "Almuerzo" / "cena" / "comida" → Alimentación > restaurante
      "Curso" / "matrícula" / "pensión colegio" → Educación > curso_online | colegios
      "Sueldo" / "honorarios" → tipo: ingreso, Finanzas > sin_categoria
      sin mensaje claro → Otros > sin_categoria
  * comercio: construir como "<Beneficiario> — <propósito principal del mensaje>" cuando el mensaje aporta contexto.
    Ejemplos:
      "Quipuzco Valles Danny L." + mensaje "Cuota 3 turismo" → comercio: "Quipuzco Valles Danny L. — cuota turismo"
      "Maria Lopez" + mensaje "alquiler abril" → comercio: "Maria Lopez — alquiler"
      "Juan Perez" sin mensaje claro → comercio: "Juan Perez"
    El propósito debe ser 1-3 palabras lowercase, sin números, sin meses, sin "menos", "y", "más", etc.
    Esto permite que Neto aprenda reglas distintas por propósito aunque sea el mismo beneficiario.
- BCP débito/crédito: buscar campo "Empresa" o descripción del consumo
- BBVA: buscar campo "Comercio" o descripción de consumo
- Interbank: buscar campo "Empresa" para pagos de servicio
- Scotiabank: buscar campo "Empresa o institución" para el comercio real
- YAPE:
  * "Realizaste un yapeo" / "Yapeaste" / "yapeo de S/" enviado → tipo: gasto
  * "Recibiste un yapeo" / "Te yapearon" / "yapeo recibido" → tipo: ingreso
  * Extraer monto después de "S/", comercio del campo "Nombre del Beneficiario" o "Enviado por"
  * fecha del campo "Fecha y Hora de la operación", banco: Yape
  * categoria: Otros (gasto) o Finanzas (ingreso), subcategoria: sin_categoria (a menos que sea comercio conocido)
- Plin:
  * "Realizaste un plin" / "Pago exitoso" / "plin enviado" → tipo: gasto
  * "Recibiste un plin" / "Te hicieron un plin" / "plin recibido" → tipo: ingreso
  * Extraer monto, comercio del destinatario/remitente, banco: Plin
- Banco Falabella: buscar campo "Comercio" o "Establecimiento", banco: Falabella
- Banco Ripley: buscar campo "Comercio", banco: Ripley
- BanBif: buscar campo "Comercio" o "Empresa", banco: BanBif
- Mibanco: buscar campo "Descripción" o "Empresa", banco: Mibanco
- Cajas municipales (CMAC Huancayo, Piura, Trujillo, Cusco, Ica, Sullana): banco: CMAC

REGLA CRÍTICA DE MONEDA (aplicar SIEMPRE antes de asignar moneda):
- Si el correo contiene "$", "USD", "US$" → moneda: "USD" sin excepción
- Si el correo dice "S/", "PEN", "soles" → moneda: "PEN"
- Comercios internacionales que SIEMPRE son USD: Netflix, NETFLIX.COM, DLOCAL*NETFLIX, Spotify, Disney+, Amazon Prime, YouTube Premium, Apple, Steam, Xbox, PlayStation, Google One, iCloud, ChatGPT, OpenAI, Claude, Claude.AI, Anthropic, Canva, Dropbox, Adobe, Microsoft 365, GitHub, Notion, Figma, Slack, Zoom, Shopify
- Si ves "$ 8.73" o "$8.73" en el correo → monto: 8.73, moneda: "USD"
- Tarjeta de crédito BCP/BBVA/Interbank con símbolo "$" → moneda: "USD"
- NUNCA registres en PEN un gasto que tenga símbolo "$" en el cuerpo del correo

REGLA CRÍTICA DE COMERCIO:
- "comercio" debe ser SOLO el nombre del establecimiento/empresa/persona (ej: "Plaza Vea", "Netflix", "Rappi")
- NUNCA incluir montos, fechas, tipo de operación ni frases descriptivas en el campo comercio
- Si el correo NO tiene un comercio identificable (ej: "operación pendiente", "cargo automático", "pago de servicio" sin nombre):
  → comercio: nombre del banco (ej: "BCP", "BBVA", "Interbank")
  → NO poner "Gasto pendiente de BCP S/5 del 2026-04-02" ni frases similares
- Si el correo dice "consumo en APPARKA PLAZA SAN MIGUE" → comercio: "Apparka Plaza San Miguel"
- Limpiar nombres: quitar códigos, asteriscos, números de referencia

REGLAS GENERALES:
- fecha en formato YYYY-MM-DD (año actual 2026)
- monto siempre número sin símbolos
- tipo=ingreso cuando el usuario RECIBE dinero:
  * "Recibiste un yapeo/plin/transferencia/abono/depósito"
  * "Te yapearon" / "Te hicieron un plin" / "Te transfirieron"
  * "Abono recibido" / "Depósito recibido" / "Transferencia recibida"
  * Sueldo, salario, honorarios cobrados
  * El campo "Enviado por" indica quién mandó el dinero al usuario
  * Para ingresos: comercio = nombre de quien envía el dinero, categoria: Finanzas, subcategoria: sin_categoria
- tipo=gasto cuando el usuario ENVÍA dinero:
  * "Realizaste un yapeo/plin/transferencia/pago"
  * "Yapeaste" / "Pagaste" / "Consumo con tarjeta"
  * Consumos, pagos, compras, transferencias enviadas
  * El campo "Enviado a" o "Beneficiario" indica a quién le pagó el usuario
- subcategoria NUNCA puede ser null — usar sin_categoria si no sabes
- comercio: nombre limpio sin códigos (no "DLC*PEDIDOSYA" sino "PedidosYa")`;

/**
 * Construye el bloque de prompt con categorías custom del usuario.
 * categoriasCustom: array de { nombre, subcategorias: [{ nombre }] } obtenido
 * con services/categories.js → obtenerCategoriasUsuario(usuarioId)
 */
function buildCategoriasCustomPrompt(categoriasCustom) {
  if (!categoriasCustom || categoriasCustom.length === 0) return '';
  const lineas = categoriasCustom.map(c => {
    const subs = (c.subcategorias || []).map(s => s.nombre).filter(Boolean);
    return '- ' + c.nombre + (subs.length ? ' → ' + subs.join(' | ') : ' (sin subcategorías)');
  }).join('\n');
  return `

CATEGORÍAS CUSTOM DEL USUARIO (PRIORIDAD SOBRE CANÓNICAS):
El usuario ha creado estas categorías propias. Si alguna encaja mejor con el contexto del correo (especialmente para transferencias con mensaje), úsala EN LUGAR de la canónica. Devuelve el "nombre" exacto tal como aparece aquí, respetando mayúsculas y acentos.

${lineas}

REGLA DE PRIORIDAD:
- Si el correo describe un viaje y el usuario tiene categoría "Viajes" custom → usa "Viajes" (no "Otros > viaje")
- Si el correo describe deudas y el usuario tiene categoría "Deudas" custom → usa "Deudas" (no la canónica más cercana)
- Solo cae a categoría canónica si NINGUNA custom encaja con el contexto
- subcategoria debe ser una de las listadas para esa categoría custom; si no hay match exacto, usar "sin_categoria"`;
}

async function parsearCorreoBancario(texto, contexto, categoriasCustom) {
  const systemPrompt = BANK_PARSER_PROMPT + buildCategoriasCustomPrompt(categoriasCustom);
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Parsea este correo bancario' + (contexto ? ' (asunto: ' + contexto + ')' : '') + ':\n\n' + texto }
    ],
    temperature: 0
  });
  const raw = res.choices[0].message.content.trim();
  const clean = raw.startsWith('{') ? raw : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  const parsed = JSON.parse(clean);
  if (parsed.comercio) parsed.comercio = normalizarComercio(parsed.comercio);
  // Últimos 4 de la tarjeta: extracción determinística sobre el correo original
  // (más fiable que el LLM). Si el modelo ya devolvió tarjeta_last4, se respeta;
  // si no, se intenta del texto.
  const last4 = normalizarLast4(parsed.tarjeta_last4) || extraerLast4(texto);
  if (last4) parsed.tarjeta_last4 = last4;
  return parsed;
}

// Sub-1 amount fallback: el modelo a veces devuelve ok:false o monto=0 ante microtransacciones
// (ej. "Gasté 0.0001 USD en tus servicios ayer" — cripto/fees). Si el modelo falló pero el msg
// contiene un patrón claro de "<1 + moneda explícita", reconstruimos el parsed manualmente.
// Solo se activa con moneda explícita para no abrir falsos positivos en montos sin contexto.
// Cubre ambos órdenes: "0.0001 USD" y "S/0.50".
const RE_MONTO_POST_MONEDA = /(\d+[.,]\d+)\s*(USD|EUR|GBP|PEN|d[oó]lares?|euros?|libras?|soles?|cripto|btc|eth)\b/i;
const RE_MONTO_PRE_MONEDA = /\b(USD|EUR|GBP|PEN|S\/\.?|\$)\s*(\d+[.,]\d+)/i;
const RE_VERBO_GASTO_MSG = /\b(gast[eé]|gaste|pagu[eé]|compr[eé]|bot[eé]|tir[eé]|perd[ií])\b/i;

function parseMonedaToken(token) {
  const t = (token || '').toLowerCase();
  if (/usd|d[oó]lar|^\$$/.test(t)) return 'USD';
  if (/eur|euro/.test(t)) return 'EUR';
  if (/gbp|libra/.test(t)) return 'GBP';
  // soles, S/, PEN, cripto/btc/eth → tratamos como PEN para mantener compat con el resto del flujo
  return 'PEN';
}

function extraerMontoSub1ConMoneda(msg) {
  if (!msg) return null;
  let m = RE_MONTO_POST_MONEDA.exec(msg);
  if (m) {
    const monto = parseFloat(m[1].replace(',', '.'));
    if (Number.isFinite(monto) && monto > 0 && monto < 1) {
      return { monto, moneda: parseMonedaToken(m[2]) };
    }
  }
  m = RE_MONTO_PRE_MONEDA.exec(msg);
  if (m) {
    const monto = parseFloat(m[2].replace(',', '.'));
    if (Number.isFinite(monto) && monto > 0 && monto < 1) {
      return { monto, moneda: parseMonedaToken(m[1]) };
    }
  }
  return null;
}

async function parsearRegistroManual(msg, fechaHoy) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: `Extrae datos de un registro manual de gasto o ingreso en lenguaje natural. Devuelve SOLO JSON:
{ "tipo":"gasto"|"ingreso", "monto":numero, "moneda":"PEN"|"USD", "comercio":"descripcion breve", "categoria":"ver lista", "subcategoria":"ver lista", "fecha":"YYYY-MM-DD", "ok":true|false }

Si no puedes extraer un monto claro, devuelve { "ok": false }.

Hoy es ${fechaHoy}.
REGLA CRÍTICA DE FECHA: Si el usuario NO menciona explícitamente una fecha (palabras como "ayer", "antier", "anteayer", "hoy", "el lunes/martes/...", "la semana pasada", "hace N días", "el 5", "5/5", "el 15 de abril", "3 de marzo", etc.), DEBES devolver fecha exactamente igual a "${fechaHoy}". NUNCA restes ni calcules días si el usuario no lo pide. Solo cuando el usuario diga "ayer" restas 1 día; "el lunes" / "la semana pasada" calculas la fecha correcta. Para fechas con día+mes ("el 15 de abril", "3 de marzo"), usa ese día y mes del año actual (o del año anterior si esa fecha aún no ha ocurrido este año). En cualquier otro caso, fecha = "${fechaHoy}" sin modificar.

tipo=ingreso: sueldo, salario, honorarios, abono recibido, ingreso, cobré, me pagaron, depósito recibido.
tipo=gasto: gasté, pagué, compré, anota un gasto, registra gasto. También cuenta como gasto: "boté", "tiré", "se me fueron", "perdí" (en contexto de dinero).

MODISMOS PERUANOS PARA SOLES (regla estricta 1:1, NUNCA multiplicar):
- "lucas" = soles. Ej: "50 lucas" = 50 soles. NUNCA interpretar como "1 luca = 1000 soles" aunque históricamente era así.
- "cocos" = soles. Ej: "20 cocos" = 20 soles.
- "mangos" = soles. Ej: "100 mangos" = 100 soles.
- "mortadelos" = soles. Ej: "30 mortadelos" = 30 soles.
- "soles", "S/", "S/.", "PEN" = soles (estándar).
- "dólares", "USD", "$", "verdes" = dólares (moneda=USD).
Si el usuario escribe sólo un número sin moneda, asumir PEN (soles).

CATEGORÍAS (usa exactamente):
Alimentación: delivery|restaurante|supermercado|mercado|cafeteria|snacks
Transporte: uber_cabify|taxi|bus_micro|metro_bus|gasolina|peaje|estacionamiento
Vivienda: alquiler|mantenimiento|electricidad|agua|gas|internet|cable
Salud: farmacia|medico|clinica|laboratorio|seguro_salud|optica
Entretenimiento: streaming|cine|juegos|bares_clubs|eventos|hobbies
Compras: ropa|calzado|electronico|hogar|belleza|mascotas
Educación: universidad|instituto|curso_online|utiles|idiomas|colegios
Finanzas: prestamo|tarjeta_credito|seguro|ahorro|inversion|comision_banco
Trabajo_Negocio: herramientas|publicidad|oficina|logistica|contador
Otros: regalo|donacion|multa|viaje|sin_categoria

Para ingresos: comercio="Sueldo" o la fuente del ingreso, categoria="Finanzas", subcategoria="sin_categoria".` },
      { role: 'user', content: msg }
    ],
    temperature: 0
  });
  const raw2 = res.choices[0].message.content.trim();
  const clean2 = raw2.startsWith('{') ? raw2 : raw2.slice(raw2.indexOf('{'), raw2.lastIndexOf('}') + 1);
  const parsed = JSON.parse(clean2);
  // Sub-1 fallback: si el modelo no extrajo monto pero el msg tiene "<1 + moneda explícita",
  // reconstruimos la TX manualmente. Cubre amt-006 (microtransacciones cripto/fee).
  if (!parsed.ok || !parsed.monto || parsed.monto <= 0) {
    const found = extraerMontoSub1ConMoneda(msg);
    if (found) {
      const tipo = RE_VERBO_GASTO_MSG.test(msg) ? 'gasto' : 'ingreso';
      return {
        ok: true,
        monto: found.monto,
        moneda: found.moneda,
        tipo,
        comercio: 'sin_descripcion',
        categoria: tipo === 'ingreso' ? 'Finanzas' : 'Otros',
        subcategoria: 'sin_categoria',
        fecha: fechaHoy,
      };
    }
  }
  return parsed;
}

async function parsearCorreccionesMultiples(msg) {
  try {
    const hoy = hoyPeru();
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'system',
        content: `Eres un parser de correcciones de gastos financieros. La fecha de hoy es ${hoy}.
El usuario lista varios gastos que quiere reclasificar en un solo mensaje.
Extrae TODAS las correcciones y devuelve SOLO un array JSON con este formato:
[
  {
    "comercio": "nombre del comercio tal como aparece",
    "monto": numero o null,
    "fecha": "YYYY-MM-DD" o null,
    "categoria_nueva": "nombre de la categoria en español, capitalizada",
    "subcategoria_nueva": "subcategoria si se menciona, sino null"
  }
]
Reglas:
- "menu" o "almuerzo" → categoria_nueva="Alimentación"
- "gasolina" o "combustible" → categoria_nueva="Transporte", subcategoria_nueva="Gasolina"
- "uber", "taxi", "bus" → categoria_nueva="Transporte"
- "farmacia", "médico", "clinica" → categoria_nueva="Salud"
- Si dice "pasalo a X" o "ponlo en X" o "es de X" → categoria_nueva=X
- Si solo dice una palabra sin "pasalo"/"ponlo", esa palabra es la categoria o subcategoria
- Capitaliza la primera letra de categoria_nueva
IMPORTANTE: Devuelve SOLO el array JSON, sin texto adicional.`
      }, {
        role: 'user',
        content: msg
      }],
      temperature: 0
    });
    const raw = res.choices[0].message.content.trim();
    const arr = JSON.parse(raw.startsWith('[') ? raw : raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1));
    return Array.isArray(arr) ? arr : [];
  } catch(e) {
    log.error({ tag: 'PARSE_MULT', err: e.message }, 'Error parseando correcciones múltiples');
    return [];
  }
}

async function interpretarComandoPresupuesto(texto) {
  try {
    var aiRes = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: 'Extrae datos de presupuesto. SOLO JSON: {"es_presupuesto":true/false,"categoria":"nombre","monto":numero,"alerta_porcentaje":numero 1-100 default 80}' }, { role: 'user', content: texto }], temperature: 0 });
    var raw = aiRes.choices[0].message.content.trim();
    return JSON.parse(raw.startsWith('{') ? raw : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}')+1));
  } catch(e) { return { es_presupuesto: false }; }
}

module.exports = {
  parsearCorreoBancario,
  parsearRegistroManual,
  parsearCorreccionesMultiples,
  interpretarComandoPresupuesto,
  extraerMontoSub1ConMoneda,
  extraerLast4,
  normalizarLast4,
};
