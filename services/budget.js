const { supabase } = require('../lib/db');
const { barraProgreso } = require('../lib/formatters');
const { hoyPeru } = require('../lib/dates');
const { validarMonto } = require('../lib/validators');
const log = require('../lib/logger');

function _mesAnioPeru() {
  const parts = hoyPeru().split('-');
  return { mes: parseInt(parts[1], 10), anio: parseInt(parts[0], 10), primero: parts[0] + '-' + parts[1] + '-01' };
}

// Las categorías a veces se guardan con tilde ('Alimentación') y otras sin ('Alimentacion').
// Para filtros y matching usamos versión normalizada (sin tildes, lowercase).
function _normCat(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

async function guardarPresupuesto(usuarioId, categoria, monto) {
  // Guard duro: este era el único write de dinero del backend fuera de validarMonto.
  // El intent ya valida y da mensaje amigable; acá es defensa para cualquier otro caller.
  const montoValidado = validarMonto(monto);
  if (montoValidado === null) throw new Error('Monto de presupuesto inválido: ' + monto);
  const { mes, anio } = _mesAnioPeru();
  const { data, error } = await supabase.from('presupuestos').upsert({
    usuario_id: usuarioId, categoria, monto_limite: montoValidado,
    mes, anio
  }, { onConflict: 'usuario_id,categoria,subcategoria,mes,anio' }).select().single();
  if (error) throw error;
  return data;
}

async function obtenerPresupuestosMes(usuarioId) {
  const { mes, anio } = _mesAnioPeru();
  const { data, error } = await supabase.from('presupuestos').select('*').eq('usuario_id', usuarioId)
    .eq('mes', mes).eq('anio', anio);
  // La alimenta `generarResumenSemanal` (cron que empuja): con `[]`, `limiteTotal` queda en 0
  // y el bloque de presupuesto DESAPARECE del mensaje sin decirlo. Y por el lado del usuario,
  // `formatearEstadoPresupuesto` responde "No tienes presupuestos configurados", que sobre una
  // lectura caida es falso y encima invita a volver a crearlos.
  if (error) throw error;
  return data || [];
}

/**
 * La alerta de presupuesto que se pega a la confirmación del gasto.
 *
 * Recibe la FILA del usuario, no su id, y eso es el gate: "llevas S/450 de tus S/500 en
 * Alimentación (90%)" es un agregado sobre el mes, o sea exactamente lo que el muro cobra.
 * Se colaba gratis porque los presupuestos se crean durante el trial y seguían disparando
 * su alerta para siempre después de caer al muro — el único agregado que sobrevive al muro
 * es el total del mes pegado a la confirmación, y este no es ese (B9, auditoría CTO ola 4).
 *
 * Escribir NO se corta: el gasto ya se registró antes de llegar acá. Lo único que se calla
 * es la lectura agregada.
 *
 * **La firma pide la fila a propósito.** Con un `usuarioId` el gate necesitaría una query
 * extra en el camino más caliente del bot (cada gasto registrado), y sobre todo sería
 * opcional: quien no la hiciera se saltaría el muro en silencio. Pidiendo la fila, un
 * llamador que no la tenga no compila mentalmente. Si igual llega un string, se falla
 * CERRADO (sin alerta) y se loguea: un gate que ante la duda entrega es un gate roto.
 *
 * @param {object} usuario  fila de `usuarios` (necesita al menos `id` y `plan`)
 */
async function verificarAlertaPresupuesto(usuario, categoria, subcategoria) {
  if (!usuario || typeof usuario !== 'object' || !usuario.id) {
    log.error({ tag: 'PRESUPUESTO', tipo: typeof usuario },
      'verificarAlertaPresupuesto recibió algo que no es la fila del usuario: sin alerta');
    return null;
  }
  // require diferido: lib/trial arrastra la cadena de envío (activacion → whatsapp) y
  // cargarla arriba acoplaría este módulo a algo que no necesita para calcular un total.
  const { estaEnMuro } = require('../lib/trial');
  if (estaEnMuro(usuario)) return null;

  const usuarioId = usuario.id;
  const { mes, anio, primero } = _mesAnioPeru();
  const alertas = [];
  const catNorm = _normCat(categoria);

  // Buscar presupuesto y transacciones tolerando mismatch de tilde entre Alimentación / Alimentacion
  const [{ data: presupuestosMes, error: errPres }, { data: gastosMes, error: errGastos }] = await Promise.all([
    supabase.from('presupuestos').select('*')
      .eq('usuario_id', usuarioId).eq('mes', mes).eq('anio', anio),
    supabase.from('transacciones').select('monto,monto_pen,categoria,subcategoria')
      .eq('usuario_id', usuarioId).eq('tipo', 'gasto').gte('fecha', primero),
  ]);
  // **Aca NO se lanza, y el motivo esta en cuando corre esta funcion: DESPUES de que el gasto
  // ya se escribio.** Sus cuatro call-sites le pegan el resultado a la confirmacion; un throw
  // se llevaria puesta la confirmacion de un gasto que SI quedo guardado, y la persona lo
  // volveria a mandar. La alerta se pierde, que es lo caro pero es lo barato de los dos.
  //
  // Y falla CERRADA sola, que es la direccion correcta: sin presupuestos no hay `presCat` y
  // sin gastos el total da 0, asi que una lectura caida nunca INVENTA una alerta. Lo unico
  // que faltaba era el rastro de por que no salio.
  if (errPres || errGastos) {
    log.error({ tag: 'PRESUPUESTO', usuarioId, errPres: errPres && errPres.message, errGastos: errGastos && errGastos.message },
      'No se pudo leer el presupuesto o los gastos del mes: el gasto se confirma sin alerta');
    return null;
  }

  const presCat = (presupuestosMes || []).find(p => _normCat(p.categoria) === catNorm && !p.subcategoria);
  if (presCat) {
    const totalCat = (gastosMes || [])
      .filter(t => _normCat(t.categoria) === catNorm)
      .reduce((s, t) => s + parseFloat(t.monto_pen ?? t.monto), 0);
    const limiteCat = parseFloat(presCat.monto_limite);
    const pctCat = (totalCat / limiteCat) * 100;
    if (pctCat >= 100) alertas.push('🚨 Limite de *' + categoria + '* superado: S/ ' + totalCat.toFixed(2) + ' / S/ ' + limiteCat.toFixed(2));
    else if (pctCat >= (presCat.alerta_porcentaje || 80)) alertas.push('⚠️ *' + categoria + '*: llevas S/ ' + totalCat.toFixed(2) + ' de S/ ' + limiteCat.toFixed(2) + ' (' + pctCat.toFixed(0) + '%)');
  }

  if (subcategoria) {
    const subNorm = _normCat(subcategoria);
    const presSub = (presupuestosMes || []).find(p => _normCat(p.categoria) === catNorm && _normCat(p.subcategoria) === subNorm);
    if (presSub) {
      const totalSub = (gastosMes || [])
        .filter(t => _normCat(t.categoria) === catNorm && _normCat(t.subcategoria) === subNorm)
        .reduce((s, t) => s + parseFloat(t.monto_pen ?? t.monto), 0);
      const limiteSub = parseFloat(presSub.monto_limite);
      const pctSub = (totalSub / limiteSub) * 100;
      if (pctSub >= 100) alertas.push('🚨 Limite de *' + subcategoria + '* superado: S/ ' + totalSub.toFixed(2) + ' / S/ ' + limiteSub.toFixed(2));
      else if (pctSub >= (presSub.alerta_porcentaje || 80)) alertas.push('⚠️ *' + subcategoria + '*: llevas S/ ' + totalSub.toFixed(2) + ' de S/ ' + limiteSub.toFixed(2) + ' (' + pctSub.toFixed(0) + '%)');
    }
  }
  return alertas.length > 0 ? alertas.join('\n') : null;
}

async function formatearEstadoPresupuesto(usuarioId) {
  const presupuestos = await obtenerPresupuestosMes(usuarioId);
  if (!presupuestos.length) return 'No tienes presupuestos configurados.\n\nEj: _"pon limite de 500 en Comida"_';
  const { primero } = _mesAnioPeru();
  const MESES_LARGO = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const mesNombre = MESES_LARGO[parseInt(primero.split('-')[1], 10) - 1];
  // Una sola query del mes; filtrado por categoría se hace en JS con normalización tilde-insensible
  const { data: allTxs, error } = await supabase.from('transacciones').select('monto,monto_pen,categoria')
    .eq('usuario_id', usuarioId).eq('tipo', 'gasto').gte('fecha', primero);
  // Esta si lanza, y la diferencia con `verificarAlertaPresupuesto` es lo que se imprime: con
  // `allTxs` en null cada categoria sale con "S/ 0.00 / S/ 500 (resta S/ 500)" y la barra de
  // progreso vacia. No es un bloque que falta, es un numero de plata FALSO — y el que mas
  // dano hace, porque dice que no gastaste nada. `obtenerPresupuestosMes`, dos lineas arriba,
  // ya lanza por lo mismo desde el item 7, asi que los dos call-sites ya toleran el throw.
  if (error) throw error;
  let msg = '*Tu presupuesto de ' + mesNombre + '*\n---------------\n\n';
  for (const p of presupuestos) {
    const catNorm = _normCat(p.categoria);
    const gastado = (allTxs || [])
      .filter(t => _normCat(t.categoria) === catNorm)
      .reduce((s, t) => s + parseFloat(t.monto_pen ?? t.monto), 0);
    const limite = parseFloat(p.monto_limite);
    const pct = (gastado / limite) * 100;
    msg += '*' + p.categoria + '*\n' + barraProgreso(pct) + '\nS/ ' + gastado.toFixed(2) + ' / S/ ' + limite.toFixed(2) + ' (resta S/ ' + Math.max(limite - gastado, 0).toFixed(2) + ')\n\n';
  }
  return msg;
}

module.exports = {
  guardarPresupuesto, obtenerPresupuestosMes,
  verificarAlertaPresupuesto, formatearEstadoPresupuesto,
};
