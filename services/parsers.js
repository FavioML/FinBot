const { openai } = require('../lib/ai');
const { hoyPeru } = require('../lib/dates');
const log = require('../lib/logger');

const BANK_PARSER_PROMPT = `Eres un parser experto de notificaciones bancarias peruanas. Devuelve SOLO JSON sin markdown:
{ "tipo":"gasto"|"ingreso", "monto":numero, "moneda":"PEN"|"USD", "comercio":"nombre limpio del comercio", "categoria":"ver lista", "subcategoria":"ver lista", "banco":"BCP|Interbank|BBVA|Scotiabank|Yape|Plin|Falabella|Ripley|BanBif|Mibanco|CMAC|Otro", "metodo_pago":"Debito|Credito|Yape|Plin|Efectivo|Otro", "fecha":"YYYY-MM-DD", "descripcion_original":"texto original" }

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
- BCP débito/crédito: buscar campo "Empresa" o descripción del consumo
- BBVA: buscar campo "Comercio" o descripción de consumo
- Interbank: buscar campo "Empresa" para pagos de servicio
- Scotiabank: buscar campo "Empresa o institución" para el comercio real
- YAPE: extraer monto después de "S/", comercio del campo "Nombre del Beneficiario",
  fecha del campo "Fecha y Hora de la operación", banco: Yape, tipo: gasto,
  categoria: Otros, subcategoria: sin_categoria (a menos que sea comercio conocido)
- Plin: similar a Yape
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

REGLAS GENERALES:
- fecha en formato YYYY-MM-DD (año actual 2026)
- monto siempre número sin símbolos
- tipo=ingreso solo si es depósito, sueldo, abono recibido, transferencia entrante
- tipo=gasto para consumos, pagos, transferencias enviadas
- subcategoria NUNCA puede ser null — usar sin_categoria si no sabes
- comercio: nombre limpio sin códigos (no "DLC*PEDIDOSYA" sino "PedidosYa")`;

async function parsearCorreoBancario(texto, contexto) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: BANK_PARSER_PROMPT },
      { role: 'user', content: 'Parsea este correo bancario' + (contexto ? ' (asunto: ' + contexto + ')' : '') + ':\n\n' + texto }
    ],
    temperature: 0
  });
  const raw = res.choices[0].message.content.trim();
  const clean = raw.startsWith('{') ? raw : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  return JSON.parse(clean);
}

async function parsearRegistroManual(msg, fechaHoy) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: `Extrae datos de un registro manual de gasto o ingreso en lenguaje natural. Devuelve SOLO JSON:
{ "tipo":"gasto"|"ingreso", "monto":numero, "moneda":"PEN"|"USD", "comercio":"descripcion breve", "categoria":"ver lista", "subcategoria":"ver lista", "fecha":"YYYY-MM-DD", "ok":true|false }

Si no puedes extraer un monto claro, devuelve { "ok": false }.

Hoy es ${fechaHoy}. Si el usuario dice "ayer" restar 1 día. Si dice "el lunes", "la semana pasada", etc., calcular la fecha correcta.

tipo=ingreso: sueldo, salario, honorarios, abono recibido, ingreso, cobré, me pagaron, depósito recibido.
tipo=gasto: gasté, pagué, compré, anota un gasto, registra gasto.

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
  return JSON.parse(clean2);
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
};
