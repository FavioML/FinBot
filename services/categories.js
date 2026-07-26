const { supabase } = require('../lib/db');
const { openai } = require('../lib/ai');
const { CATEGORIAS_SUGERIDAS } = require('../lib/constants');
const { getEmojiCategoria } = require('../lib/formatters');

async function obtenerCategoriasUsuario(usuarioId) {
  const { data: cats } = await supabase.from('categorias_usuario').select('*').eq('usuario_id', usuarioId).eq('activa', true).is('padre_id', null).order('nombre');
  if (!cats || cats.length === 0) return null;
  const resultado = [];
  for (const cat of cats) {
    const { data: subs } = await supabase.from('categorias_usuario').select('*').eq('usuario_id', usuarioId).eq('padre_id', cat.id).eq('activa', true).order('nombre');
    resultado.push({ ...cat, subcategorias: subs || [] });
  }
  return resultado;
}

async function crearCategoriasDesdeIndices(usuarioId, indices) {
  const seleccionadas = indices.map(i => CATEGORIAS_SUGERIDAS[i-1]).filter(Boolean);
  for (const cat of seleccionadas) {
    const { data: catCreada } = await supabase.from('categorias_usuario').insert({ usuario_id: usuarioId, nombre: cat.nombre, emoji: cat.emoji }).select().single();
    if (!catCreada) continue;
    for (const sub of cat.subs) { await supabase.from('categorias_usuario').insert({ usuario_id: usuarioId, nombre: sub, padre_id: catCreada.id }); }
  }
}

async function detectarCategoriaIA(texto, usuarioId) {
  const cats = await obtenerCategoriasUsuario(usuarioId);
  let contexto;
  if (cats && cats.length > 0) {
    contexto = cats.map(c => c.nombre + (c.subcategorias.length > 0 ? ' (subs: '+c.subcategorias.map(s=>s.nombre).join(',')+')' : '')).join('; ');
  } else {
    contexto = CATEGORIAS_SUGERIDAS.map(c => c.nombre + (c.subs.length > 0 ? ' (subs: '+c.subs.join(',')+')' : '')).join('; ');
  }
  try {
    const res = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: 'Eres un clasificador de gastos. Elige la categoria mas apropiada de la lista proporcionada. Si el usuario menciona explicitamente una subcategoria, usa ese nombre exacto aunque no este en la lista. Responde SOLO con JSON: {"categoria":"nombre exacto","subcategoria":"nombre exacto o null"}' }, { role: 'user', content: 'Categorias disponibles: '+contexto+'\n\nGasto a clasificar: '+texto }], temperature: 0 });
    const raw = res.choices[0].message.content.trim();
    const result = JSON.parse(raw.startsWith('{') ? raw : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}')+1));
    if (result.subcategoria && /^null$/i.test(String(result.subcategoria).trim())) result.subcategoria = null;
    if (result.categoria && /^null$/i.test(String(result.categoria).trim())) result.categoria = null;
    return result;
  } catch(e) { return { categoria: null, subcategoria: null }; }
}

async function sugerirEmojiConIA(nombreCategoria) {
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Dame UN solo emoji que mejor represente la categoría de gastos llamada "' + nombreCategoria + '". Responde SOLO con el emoji, sin texto.' }],
      temperature: 0, max_tokens: 10
    });
    const emoji = res.choices[0].message.content.trim();
    return emoji.length <= 4 ? emoji : '📁';
  } catch(e) { return '📁'; }
}

// Devuelve la fila raíz existente (o null) SIN lanzar cuando hay duplicados.
// `.single()` lanzaba con >1 fila; el catch se lo tragaba y el flujo insertaba
// otra categoría igual, así que 2 duplicados se volvían 24. `.limit(1)` corta
// ese ciclo: si ya existe al menos una con ese nombre, nunca se inserta otra.
async function buscarCategoriaRaiz(usuarioId, nombre) {
  const { data } = await supabase.from('categorias_usuario')
    .select('id').eq('usuario_id', usuarioId).eq('nombre', nombre).is('padre_id', null)
    .order('created_at', { ascending: true }).limit(1);
  return (data && data[0]) || null;
}

async function crearCategoriaLibreUsuario(usuarioId, nombre) {
  try {
    if (await buscarCategoriaRaiz(usuarioId, nombre)) return;
    const emoji = getEmojiCategoria(nombre) || await sugerirEmojiConIA(nombre);
    await supabase.from('categorias_usuario').insert({ usuario_id: usuarioId, nombre, emoji, activa: true });
  } catch(e) { /* silencioso */ }
}

async function crearSubcategoriaLibreUsuario(usuarioId, categoriaNombre, subcategoriaNombre) {
  if (!categoriaNombre || !subcategoriaNombre) return;
  try {
    let padre = await buscarCategoriaRaiz(usuarioId, categoriaNombre);
    if (!padre) {
      await crearCategoriaLibreUsuario(usuarioId, categoriaNombre);
      padre = await buscarCategoriaRaiz(usuarioId, categoriaNombre);
      if (!padre) return;
    }
    const { data: existeSub } = await supabase.from('categorias_usuario')
      .select('id').eq('usuario_id', usuarioId).eq('padre_id', padre.id).ilike('nombre', subcategoriaNombre).limit(1);
    if (existeSub && existeSub.length) return;
    await supabase.from('categorias_usuario').insert({ usuario_id: usuarioId, nombre: subcategoriaNombre, padre_id: padre.id, activa: true });
  } catch(e) { /* silencioso */ }
}

module.exports = {
  obtenerCategoriasUsuario,
  crearCategoriasDesdeIndices,
  detectarCategoriaIA,
  sugerirEmojiConIA,
  crearCategoriaLibreUsuario,
  crearSubcategoriaLibreUsuario,
};
