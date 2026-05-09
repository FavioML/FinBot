// Categorizador puro post-OpenAI por keywords fuertes. Cero LLM, cero prompt.
// Solo se invoca como override cuando el LLM clasifica `sin_categoria` en
// mensajes largos (prosa). Espejo conservador del CATEGORY_ALIASES de queries.
//
// Diccionario kw → categoría canónica. Cada regex apunta a términos
// inequívocos del vertical (ej: "alternador" solo aparece en contexto auto;
// "farmacia" solo en salud). Evitar términos genéricos como "comida" /
// "compra" que pueden colisionar entre verticales.

const KEYWORDS_FUERTES = [
  { categoria: 'Transporte', re: /\b(mec[aá]nico|alternador|cig[uü]e[nñ]al|bujias?|carburador|caja\s+de\s+cambios|llanta|cauchos?|bater[ií]a\s+(?:del?\s+)?(?:auto|carro|coche|veh[ií]culo)|gasolinera|grifo|combustible|gasolina|peaje|soat|seguro\s+vehicular|gnv|taller(?:\s+(?:mec[aá]nico|automotriz))?|ll[aá]ntera|veh[ií]culo|veh[ií]culos|moto(?:cicleta)?)\b/i },
  { categoria: 'Salud', re: /\b(farmacia|cl[ií]nica|hospital|dentista|odont[oó]logo|medicamento|pastillas?|laboratorio\s+cl[ií]nico|ex[aá]menes?\s+m[eé]dicos?|cita\s+m[eé]dica|consulta\s+m[eé]dica|radiograf[ií]a|tomograf[ií]a|ecograf[ií]a|inkafarma|mifarma|boticas?\s+(?:y\s+salud|per[uú])|ciruj[aá]no)\b/i },
  { categoria: 'Vivienda', re: /\b(alquiler|renta\s+(?:del?\s+)?(?:depa|departamento|casa|cuarto|habitaci[oó]n)|recibo\s+(?:de\s+)?(?:luz|agua|gas)|sedapal|enel|edemsa|wifi|internet\s+(?:de\s+)?casa|condominio|arbitrios|mantenimiento\s+(?:del?\s+)?(?:edificio|departamento|condominio))\b/i },
  { categoria: 'Suscripciones', re: /\b(netflix|spotify|disney\+?|hbo\s*(?:max)?|apple\s+(?:music|tv|one)|youtube\s+premium|prime\s+video|amazon\s+prime|chatgpt\s+plus|claude\.ai|github\s+copilot)\b/i },
  { categoria: 'Educación', re: /\b(matr[ií]cula|mensualidad\s+(?:del?\s+)?(?:colegio|universidad)|universidad|colegio|nido|academia\s+preuniversitaria|cepre|tutor[ií]a|udemy|coursera|platzi)\b/i },
  { categoria: 'Entretenimiento', re: /\b(cine|cinemark|cineplanet|teatro|concierto|discoteca|bar(?:\s+|es\b)|restaurante|restaurant|cafeter[ií]a|escape\s+room|bowling)\b/i },
  { categoria: 'Compras', re: /\b(saga\s+falabella|ripley|oechsle|paris\.pe|hyperonline|shopstar|tienda\s+de\s+ropa|zapatos|zapatillas|polo|camisa|chaqueta|pantal[oó]n|vestido)\b/i },
  { categoria: 'Alimentación', re: /\b(supermercado|wong|metro|plaza\s+vea|tottus|vivanda|makro|mass|panader[ií]a|carnicer[ií]a|fruter[ií]a|verduler[ií]a|bodega\s+de\s+(?:la\s+)?esquina|mercado\s+central)\b/i },
];

function categorizarPorKeywords(msg) {
  if (!msg || typeof msg !== 'string') return null;
  for (const { categoria, re } of KEYWORDS_FUERTES) {
    if (re.test(msg)) return categoria;
  }
  return null;
}

module.exports = { categorizarPorKeywords, KEYWORDS_FUERTES };
