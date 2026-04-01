const { supabase } = require('../lib/db');
const { hoyPeru } = require('../lib/dates');

/**
 * Obtiene las metas de ahorro del usuario.
 * @param {string} usuarioId
 * @param {boolean} soloActivas - si true, solo metas no completadas
 */
async function obtenerMetas(usuarioId, soloActivas = false) {
  let q = supabase.from('metas_ahorro')
    .select('*, meta_aportes(*)')
    .eq('usuario_id', usuarioId)
    .order('created_at', { ascending: false });
  if (soloActivas) q = q.eq('completada', false);
  const { data } = await q;
  return data || [];
}

/**
 * Registra un aporte (o retiro) a una meta de ahorro.
 * @param {string} usuarioId
 * @param {string} nombreMeta - busca meta activa por nombre (fuzzy)
 * @param {number} monto
 * @param {'aporte'|'retiro'} tipo
 * @param {string|null} nota
 * @returns {{ meta, aporte, completada, porcentaje, milestone }}
 */
async function abonarMeta(usuarioId, nombreMeta, monto, tipo = 'aporte', nota = null) {
  // Buscar meta activa que coincida con el nombre
  const { data: metas } = await supabase.from('metas_ahorro')
    .select('*')
    .eq('usuario_id', usuarioId)
    .eq('completada', false)
    .order('created_at', { ascending: false });

  if (!metas || metas.length === 0) return null;

  let meta = metas[0]; // default: la más reciente
  if (nombreMeta && metas.length > 1) {
    const found = metas.find(m => m.nombre.toLowerCase().includes(nombreMeta.toLowerCase()));
    if (found) meta = found;
  }

  const actualAntes = parseFloat(meta.monto_actual || 0);
  const objetivo = parseFloat(meta.monto_objetivo);
  const nuevoActual = tipo === 'retiro'
    ? Math.max(0, actualAntes - monto)
    : actualAntes + monto;
  const completada = nuevoActual >= objetivo && tipo === 'aporte';

  // Insertar aporte
  const { data: aporte, error: eAporte } = await supabase.from('meta_aportes').insert({
    meta_id: meta.id,
    monto,
    tipo,
    fecha: hoyPeru(),
    nota,
  }).select().single();
  if (eAporte) throw eAporte;

  // Actualizar meta
  const updates = {
    monto_actual: nuevoActual,
    updated_at: new Date().toISOString(),
  };
  if (completada) updates.completada = true;
  const { data: metaActualizada, error: eMeta } = await supabase.from('metas_ahorro')
    .update(updates).eq('id', meta.id).select().single();
  if (eMeta) throw eMeta;

  // Detectar milestone cruzado
  const pctAntes = objetivo > 0 ? (actualAntes / objetivo) * 100 : 0;
  const pctDespues = objetivo > 0 ? (nuevoActual / objetivo) * 100 : 0;
  let milestone = null;
  for (const ms of [25, 50, 75, 100]) {
    if (pctAntes < ms && pctDespues >= ms) {
      milestone = ms;
    }
  }

  return {
    meta: metaActualizada,
    aporte,
    completada,
    porcentaje: Math.min(100, Math.round(pctDespues)),
    milestone,
  };
}

/**
 * Calcula el ritmo de ahorro necesario para una meta.
 * @param {{ monto_objetivo: number, monto_actual: number, fecha_limite: string|null }} meta
 * @returns {{ faltante, diasRestantes, montoSemanal, montoMensual, enRitmo, pctProgreso }}
 */
function calcularRitmoAhorro(meta) {
  const objetivo = parseFloat(meta.monto_objetivo);
  const actual = parseFloat(meta.monto_actual || 0);
  const faltante = Math.max(0, objetivo - actual);
  const pctProgreso = objetivo > 0 ? Math.round((actual / objetivo) * 100) : 0;

  if (!meta.fecha_limite) {
    return { faltante, diasRestantes: null, montoSemanal: null, montoMensual: null, enRitmo: null, pctProgreso };
  }

  const hoy = new Date();
  const limite = new Date(meta.fecha_limite + 'T23:59:59');
  const diasRestantes = Math.max(1, Math.ceil((limite - hoy) / 86400000));
  const semanasRestantes = Math.max(1, diasRestantes / 7);
  const mesesRestantes = Math.max(0.1, diasRestantes / 30);

  const montoSemanal = Math.ceil(faltante / semanasRestantes);
  const montoMensual = Math.ceil(faltante / mesesRestantes);

  // ¿Está en ritmo? Progreso lineal esperado
  const createdAt = meta.created_at ? new Date(meta.created_at) : hoy;
  const diasTotales = Math.max(1, Math.ceil((limite - createdAt) / 86400000));
  const diasTranscurridos = Math.max(1, Math.ceil((hoy - createdAt) / 86400000));
  const progresoEsperado = (diasTranscurridos / diasTotales) * objetivo;
  const enRitmo = actual >= progresoEsperado * 0.85; // 15% de margen

  return { faltante, diasRestantes, montoSemanal, montoMensual, enRitmo, pctProgreso };
}

/**
 * Registra un logro (badge) para el usuario. Skip si ya existe.
 * @param {string} usuarioId
 * @param {string} tipo - e.g. 'milestone_50', 'racha_3', 'meta_cumplida'
 * @param {string|null} metaId
 * @param {object} datos - metadata adicional
 * @returns {object|null} el logro creado, o null si ya existía
 */
async function registrarLogro(usuarioId, tipo, metaId = null, datos = {}) {
  const { data, error } = await supabase.from('logros').upsert({
    usuario_id: usuarioId,
    tipo,
    meta_id: metaId,
    datos,
    fecha: hoyPeru(),
  }, { onConflict: 'usuario_id,tipo,meta_id', ignoreDuplicates: true }).select().single();

  if (error) return null; // ya existe o error
  return data;
}

/**
 * Obtiene los logros del usuario.
 */
async function obtenerLogros(usuarioId) {
  const { data } = await supabase.from('logros')
    .select('*')
    .eq('usuario_id', usuarioId)
    .order('created_at', { ascending: false });
  return data || [];
}

/**
 * Verifica la racha de aportes consecutivos (semanas) a una meta.
 * @returns {number} cantidad de semanas consecutivas con al menos 1 aporte
 */
async function verificarRachaAportes(usuarioId, metaId) {
  const { data: aportes } = await supabase.from('meta_aportes')
    .select('fecha')
    .eq('meta_id', metaId)
    .eq('tipo', 'aporte')
    .order('fecha', { ascending: false });

  if (!aportes || aportes.length === 0) return 0;

  // Agrupar por semana ISO
  const semanas = new Set();
  for (const a of aportes) {
    const d = new Date(a.fecha + 'T12:00:00');
    // Semana ISO: año + número de semana
    const oneJan = new Date(d.getFullYear(), 0, 1);
    const numSemana = Math.ceil(((d - oneJan) / 86400000 + oneJan.getDay() + 1) / 7);
    semanas.add(d.getFullYear() + '-W' + String(numSemana).padStart(2, '0'));
  }

  // Contar semanas consecutivas desde la más reciente
  const semanasOrdenadas = Array.from(semanas).sort().reverse();
  let racha = 1;
  for (let i = 1; i < semanasOrdenadas.length; i++) {
    const [anioAct, semAct] = semanasOrdenadas[i - 1].split('-W').map(Number);
    const [anioPrev, semPrev] = semanasOrdenadas[i].split('-W').map(Number);

    // Verificar consecutividad
    const esConsecutiva = (anioAct === anioPrev && semAct - semPrev === 1)
      || (anioAct - anioPrev === 1 && semPrev >= 52 && semAct === 1);

    if (esConsecutiva) racha++;
    else break;
  }

  return racha;
}

module.exports = {
  obtenerMetas,
  abonarMeta,
  calcularRitmoAhorro,
  registrarLogro,
  obtenerLogros,
  verificarRachaAportes,
};
