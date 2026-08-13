const { supabase } = require('../lib/db');
const { hoyPeru } = require('../lib/dates');
const { validarMonto } = require('../lib/validators');

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

  // `isNaN(Infinity)` es false, así que el guard viejo (`!monto || monto <= 0 ||
  // isNaN(monto)`) dejaba pasar Infinity y no tenía techo: `monto_actual` quedaba en
  // Infinity —o sea `null` al serializar— y de ahí se propaga al factor de metas del
  // score persistido. Es el mismo hueco que S2 en la webapp, por el lado de WhatsApp.
  // Lo delató `tests/plata-validada.test.js`.
  const montoValidado = validarMonto(monto);
  if (montoValidado === null) {
    return { error: 'invalid_amount' };
  }

  const actualAntes = parseFloat(meta.monto_actual || 0);
  const objetivo = parseFloat(meta.monto_objetivo);
  const nuevoActual = tipo === 'retiro'
    ? Math.max(0, actualAntes - montoValidado)
    : actualAntes + montoValidado;
  const completada = nuevoActual >= objetivo && tipo === 'aporte';

  // Insertar aporte
  const { data: aporte, error: eAporte } = await supabase.from('meta_aportes').insert({
    meta_id: meta.id,
    monto: montoValidado,
    tipo,
    fecha: hoyPeru(),
    nota,
  }).select().single();
  if (eAporte) throw eAporte;

  // Atomic update: only mark completed if not already completed
  const updates = {
    monto_actual: nuevoActual,
    updated_at: new Date().toISOString(),
  };
  if (completada) updates.completada = true;
  const { data: metaActualizada, error: eMeta } = await supabase.from('metas_ahorro')
    .update(updates)
    .eq('id', meta.id)
    .eq('completada', false) // Atomic guard: skip if already completed by concurrent request
    .select().single();
  if (eMeta) {
    // If no rows matched, meta was already completed by another request
    if (eMeta.code === 'PGRST116') {
      const { data: current } = await supabase.from('metas_ahorro').select('*').eq('id', meta.id).single();
      return { meta: current, aporte, completada: false, porcentaje: 100, milestone: null };
    }
    throw eMeta;
  }

  // Detectar milestone cruzado
  const pctAntes = objetivo > 0 ? (actualAntes / objetivo) * 100 : 0;
  const pctDespues = objetivo > 0 ? (nuevoActual / objetivo) * 100 : 0;
  let milestone = null;
  for (const ms of [25, 50, 75, 100]) {
    if (pctAntes < ms && pctDespues >= ms) {
      milestone = ms;
    }
  }

  // Dynamic adjustment: recalculate monthly_quota after deposit
  if (metaActualizada.fecha_limite && !completada && tipo === 'aporte') {
    const nuevaCuota = calcularCuotaMensual(objetivo, nuevoActual, metaActualizada.fecha_limite);
    if (nuevaCuota !== null) {
      await supabase.from('metas_ahorro')
        .update({ monthly_quota: nuevaCuota })
        .eq('id', meta.id);
      metaActualizada.monthly_quota = nuevaCuota;
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

// ═══════════════════════════════════════════════════════════════
// PLANES DE AHORRO — Extended functions (v2)
// ═══════════════════════════════════════════════════════════════

/**
 * Calculate monthly quota for a savings plan.
 * @param {number} targetAmount
 * @param {number} currentAmount
 * @param {string|null} deadline - YYYY-MM-DD
 * @returns {number|null} monthly amount needed, or null if no deadline
 */
function calcularCuotaMensual(targetAmount, currentAmount, deadline) {
  if (!deadline) return null;
  const remaining = Math.max(0, targetAmount - (currentAmount || 0));
  if (remaining === 0) return 0;
  const hoy = new Date();
  const limite = new Date(deadline + 'T23:59:59');
  const mesesRestantes = Math.max(0.5, (limite - hoy) / (30 * 86400000));
  return Math.ceil(remaining / mesesRestantes);
}

/**
 * Analyze viability: Can the user afford the monthly quota?
 * Compares quota vs average monthly surplus (last 3 months).
 * @returns {{ viable, margenLibre, cuota, mensaje }}
 */
async function analizarViabilidad(usuarioId, monthlyQuota) {
  const { construirDatosUsuario } = require('./recommendations');
  const datos = await construirDatosUsuario(usuarioId);

  const ingresos = datos.mes_actual.ingresos;
  const gastos = datos.mes_actual.gastos;
  const margenLibre = Math.max(0, ingresos - gastos);

  const viable = margenLibre >= monthlyQuota;
  let mensaje = '';
  if (viable) {
    mensaje = `Tu margen libre es S/${margenLibre.toFixed(0)}/mes — la cuota de S/${monthlyQuota.toFixed(0)} es alcanzable 💪`;
  } else {
    const mesesIdeal = Math.ceil((monthlyQuota * 1) / Math.max(1, margenLibre));
    mensaje = `Tu margen libre es S/${margenLibre.toFixed(0)}/mes. La cuota de S/${monthlyQuota.toFixed(0)} es ajustada. Considera extender el plazo ${mesesIdeal} meses más.`;
  }

  return { viable, margenLibre: Math.round(margenLibre), cuota: monthlyQuota, mensaje };
}

/**
 * Dynamic adjustment: Recalculate monthly_quota based on actual progress.
 */
async function ajustarDinamico(metaId) {
  const { data: meta } = await supabase.from('metas_ahorro')
    .select('*').eq('id', metaId).single();
  if (!meta || !meta.fecha_limite || meta.completada) return null;

  const nuevaCuota = calcularCuotaMensual(
    parseFloat(meta.monto_objetivo),
    parseFloat(meta.monto_actual || 0),
    meta.fecha_limite
  );

  if (nuevaCuota !== null) {
    await supabase.from('metas_ahorro')
      .update({ monthly_quota: nuevaCuota, updated_at: new Date().toISOString() })
      .eq('id', metaId);
  }

  return { meta, nuevaCuota, cuotaAnterior: meta.monthly_quota };
}

/**
 * Suggest spending cuts to free up monthly quota.
 * Returns top categories where the user could reduce.
 */
async function sugerirRecortes(usuarioId, monthlyQuota) {
  const { construirDatosUsuario } = require('./recommendations');
  const datos = await construirDatosUsuario(usuarioId);

  const categorias = datos.categorias
    .filter(c => !['Vivienda', 'Salud', 'Educación'].includes(c.nombre))
    .sort((a, b) => b.monto - a.monto)
    .slice(0, 3);

  return categorias.map(c => ({
    categoria: c.nombre,
    gastoActual: c.monto,
    reduccionSugerida: Math.min(c.monto * 0.3, monthlyQuota * 0.5),
    porcentajeDelTotal: c.porcentaje_del_total,
  }));
}

/**
 * Set plan status to abandoned.
 */
async function abandonarPlan(usuarioId, metaId) {
  const { data, error } = await supabase.from('metas_ahorro')
    .update({ status: 'abandoned', updated_at: new Date().toISOString() })
    .eq('id', metaId)
    .eq('usuario_id', usuarioId)
    .select()
    .single();
  if (error) return null;
  return data;
}

module.exports = {
  obtenerMetas,
  abonarMeta,
  calcularRitmoAhorro,
  registrarLogro,
  obtenerLogros,
  verificarRachaAportes,
  // v2 — Planes de Ahorro
  calcularCuotaMensual,
  analizarViabilidad,
  ajustarDinamico,
  sugerirRecortes,
  abandonarPlan,
};
