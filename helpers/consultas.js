const { supabase } = require('../lib/db');
const { openai } = require('../lib/ai');
const log = require('../lib/logger');
const { obtenerConsultasPendientes, resolverConsulta, guardarReglaComercio, retroaplicarRegla } = require('../services/transactions');
const { detectarCategoriaIA, crearSubcategoriaLibreUsuario } = require('../services/categories');

async function intentarResolverConsulta(usuario, texto) {
  var pendientes = await obtenerConsultasPendientes(usuario.id);
  if (pendientes.length === 0) return null;
  var ctx = pendientes.map(function(c,i){ return (i+1)+'. '+(c.banco||'Pago')+' S/'+c.monto+' del '+c.fecha; }).join('; ');
  var parsed;
  try {
    var catsUsuario = '';
    try {
      const { data: cats } = await supabase.from('categorias_usuario').select('nombre').eq('usuario_id', usuario.id).is('padre_id', null);
      if (cats && cats.length > 0) catsUsuario = ' Categorias personalizadas del usuario: ' + cats.map(c => c.nombre).join(', ') + '.';
    } catch(e) { log.warn({ tag: 'CONSULTA', err: e.message }, 'Error cargando categorias usuario'); }
    var aiRes = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: 'Eres un clasificador de gastos pendientes. Responde SOLO con JSON valido: {"resuelve":true/false,"numero":1/2/null,"categoria":"nombre de la categoria (puede ser cualquier nombre que el usuario mencione, como Alimentación, Transporte, Auto, Hogar, etc)","subcategoria":"nombre de subcategoria si el usuario la menciona, sino null","descripcion":"descripcion corta"}. Si el usuario dice "es categoría X" o "es de X" o indica cual de los pendientes es (por numero, monto o categoria), resuelve=true y usa esa categoría. IMPORTANTE: si el usuario esta REGISTRANDO UN GASTO NUEVO (usa verbos como "gaste", "pague", "compre", "registra", "anota", "apunta" seguidos de un monto y un comercio, ej: "registra un gasto de 10 soles en taxi"), eso NO es responder a un pendiente: responde {"resuelve":false}. Solo resuelve=true cuando el usuario esta identificando/categorizando uno de los pendientes listados.' + catsUsuario }, { role: 'user', content: 'Gastos pendientes: '+ctx+'\n\nEl usuario respondio: '+texto }], temperature: 0 });
    var raw = aiRes.choices[0].message.content.trim();
    parsed = JSON.parse(raw.startsWith('{') ? raw : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}')+1));
  } catch(e) { return null; }
  if (!parsed.resuelve || !parsed.numero) return null;
  var consulta = pendientes[parsed.numero-1]; if (!consulta) return null;
  var detCat = await detectarCategoriaIA(texto, usuario.id);
  var catFinal = detCat.categoria || parsed.categoria;
  var subFinal = detCat.subcategoria || parsed.subcategoria || null;
  if (subFinal && /^null$/i.test(String(subFinal).trim())) subFinal = null;
  if (subFinal) subFinal = subFinal.charAt(0).toUpperCase() + subFinal.slice(1);
  const comercioFinal = parsed.descripcion || consulta.banco;
  const fueResuelto = await resolverConsulta(consulta.id);
  if (!fueResuelto) return null;
  await supabase.from('transacciones').update({ categoria: catFinal, subcategoria: subFinal || 'sin_categoria', comercio: comercioFinal }).eq('id', consulta.transaccion_id);
  if (subFinal && subFinal !== 'sin_categoria') {
    crearSubcategoriaLibreUsuario(usuario.id, catFinal, subFinal);
  }
  if (comercioFinal) {
    guardarReglaComercio(usuario.id, comercioFinal, catFinal, subFinal);
    retroaplicarRegla(usuario.id, comercioFinal, catFinal, subFinal);
  }
  var resto = pendientes.length > 1 ? '\n\nAun tienes ' + (pendientes.length-1) + ' gasto(s) pendiente(s). Escribe */pendientes*.' : '';
  return 'Listo! Actualice *'+(comercioFinal||'el pago')+'* (S/ '+parseFloat(consulta.monto).toFixed(2)+') a *'+catFinal+'*'+(subFinal?' > '+subFinal:'')+'.'+resto;
}

module.exports = { intentarResolverConsulta };
