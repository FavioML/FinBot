const log = require('../../lib/logger');

// El LLM a veces clasifica queries como register_transaction tras un burst de gastos
// previos en el contexto (bal-001/004/005). Cuando el parser falla por falta de monto,
// chequeamos si es una query disfrazada y redirigimos al handler correcto.
function detectarQuerySinMonto(msg) {
  const m = (msg || '').toLowerCase().trim();
  if (!m) return null;
  // \b en JS no se lleva con caracteres unicode (é/ó/á): /\bgasté\b/ falla porque
  // la `é` no es word-char ASCII y el boundary post-tilde no encaja. Usamos boundary manual.
  const reCuanto = /(?:^|\s)cu[aá]nto(?:s)?(?:\s|$|,|\?)/;
  const reGasto = /(?:^|\s)(gast[eéó]|llev[oó]|he\s+gastado|gastad[oa]s?)(?:\s|$|,|\?)/;
  const reQueda = /(?:^|\s)(me\s+queda|me\s+sobra|tengo\s+disponible|me\s+resta|disponible)(?:\s|$|,|\?)/;
  const rePresupuesto = /presupuesto/;
  const reMayor = /(?:^|\s)(mayor|m[aá]s\s+alto|m[aá]s\s+grande|m[aá]ximo)(?:\s|$|,|\?)/;
  const reMenor = /(?:^|\s)(menor|m[aá]s\s+(?:bajo|peque[nñ]o|chico)|m[ií]nimo)(?:\s|$|,|\?)/;
  const reCualGasto = /(?:^|\s)cu[aá]l(?:es)?\s.*(gasto|gastos)/;
  const reSaldo = /(?:^|\s)(saldo|balance)(?:\s|$|,|\?|\.)/;
  const hoy = /\bhoy\b/.test(m);
  const ayer = /\bayer\b/.test(m);
  const semana = /\b(esta\s+semana|semana\s+actual)\b/.test(m);
  const mesPalabra = /\b(este\s+mes|mes\s+actual|del\s+mes)\b/.test(m);

  // Palabras-clave → categoría canónica (subset de CATEGORIA_MAP, suficiente para queries WhatsApp)
  const CATEGORY_ALIASES = [
    [/\b(comida|alimentos?|alimentaci[oó]n)\b/, 'Alimentación'],
    [/\b(transporte|taxis?|ubers?|bus|micro|gasolina)\b/, 'Transporte'],
    [/\b(salud|farmacia|cl[ií]nica|m[eé]dico)\b/, 'Salud'],
    [/\b(vivienda|hogar|alquiler|renta)\b/, 'Vivienda'],
    [/\b(entretenimiento|cine|salidas?|fiesta)\b/, 'Entretenimiento'],
    [/\b(compras|ropa|calzado)\b/, 'Compras'],
    [/\b(educaci[oó]n|cursos?|colegio|universidad)\b/, 'Educación'],
    [/\b(suscripciones|streaming|netflix|spotify)\b/, 'Suscripciones'],
  ];

  // Saldo/balance del mes: query directa, no requiere "cuánto"
  if (reSaldo.test(m)) {
    return { intencion: 'ver_balance', datos: {} };
  }
  if (reCuanto.test(m) && reQueda.test(m) && rePresupuesto.test(m)) {
    return { intencion: 'ver_presupuesto', datos: {} };
  }
  if ((reCualGasto.test(m) || reCuanto.test(m)) && reMayor.test(m)) {
    return { intencion: 'ver_gasto_mayor', datos: {} };
  }
  if ((reCualGasto.test(m) || reCuanto.test(m)) && reMenor.test(m)) {
    return { intencion: 'ver_gasto_menor', datos: {} };
  }
  if (reCuanto.test(m) && reGasto.test(m) && (hoy || ayer)) {
    return { intencion: 'listar_gastos_dia', datos: {} };
  }
  if (reCuanto.test(m) && reGasto.test(m) && semana) {
    return { intencion: 'listar_gastos_semana', datos: {} };
  }
  if (reCuanto.test(m) && reGasto.test(m) && mesPalabra) {
    return { intencion: 'ver_total_gastado', datos: { periodo: 'mes' } };
  }
  // Filtro por categoría: "cuánto he gastado en comida", "cuánto llevo en taxi"
  if (reCuanto.test(m) && reGasto.test(m)) {
    for (const [re, cat] of CATEGORY_ALIASES) {
      if (re.test(m)) {
        return { intencion: 'ver_total_gastado', datos: { categoria: cat, periodo: 'mes' } };
      }
    }
  }
  return null;
}

module.exports = {
  intents: ['registrar_manual', 'corregir_categoria', 'corregir_multiple', 'corregir_monto_moneda', 'eliminar_transaccion', 'editar_monto', 'editar_fecha', 'editar_comercio', 'editar_categoria_comercio', 'deshacer_ultimo', 'restaurar_eliminado', 'marcar_como_ingreso', 'dividir_gasto', 'duplicar_gasto'],
  async handle({ intencion, msg, datos, usuario, from, ctx }) {
    const {
      supabase, mesActual, anioActual, netoPrompt, historialConv,
      CATEGORIAS_VALIDAS, CATEGORIA_MAP,
      obtenerUltimaTransaccion, recategorizarTransaccion, guardarReglaComercio,
      retroaplicarRegla, corregirTransaccionEspecifica, guardarTransaccion,
      obtenerTipoCambio, verificarAlertaPresupuesto,
      crearCategoriaLibreUsuario, crearSubcategoriaLibreUsuario, detectarCategoriaIA,
      parsearRegistroManual, parsearCorreccionesMultiples,
      redactarConNETO,
      fechaHoyPeru, fechaAyerPeru, formatFecha
    } = ctx;

    switch (intencion) {

      case 'registrar_manual': {
        try {
          // Pre-check: ¿el LLM clasificó como register pero el msg es claramente una query?
          // Bajo burst de gastos previos, gpt-4o-mini hereda contexto e inventa monto incluso
          // cuando el usuario pregunta "cuánto gasté hoy". Solo redirigimos si NO hay un patrón
          // literal de "verbo + monto + en/de/por + sustantivo" (eso seguiría siendo register).
          const tienePatronGasto = /(?:gast[eé]|gaste|pagu[eé]|compr[eé])\s+\d+(?:[.,]\d{1,2})?\s+(?:soles?\s+)?(?:en|de|por)\s+[a-záéíóúñü]/i.test(msg || '');
          if (!tienePatronGasto) {
            const redirectPre = detectarQuerySinMonto(msg);
            if (redirectPre) {
              try {
                const { getHandler } = require('../intent-registry');
                const handlerRedirPre = getHandler(redirectPre.intencion);
                if (handlerRedirPre) {
                  log.info({ tag: 'QUERY_REDIRECT', from: 'registrar_manual', to: redirectPre.intencion, msg: msg.substring(0, 80) }, 'Query disfrazada como register (pre-parser)');
                  return await handlerRedirPre({ intencion: redirectPre.intencion, msg, datos: redirectPre.datos, usuario, from, ctx });
                }
              } catch(eRedirPre) { log.warn({ tag: 'QUERY_REDIRECT', err: eRedirPre.message }, 'Fallback redirect pre-parser falló'); }
            }
          }

          // Guard fecha futura: rechazar registros de gastos que aún no ocurrieron.
          // Conservador: requiere marcador temporal futuro Y verbo futuro/perífrasis.
          // Si solo aparece uno, dejamos pasar al parser (evita falsos positivos).
          {
            const _msgFutLower = (msg || '').toLowerCase();
            const _marcadorFuturo = /\bma[ñn]ana\b|\bpasado\s+ma[ñn]ana\b|\bla\s+pr[oó]xima\s+semana\b|\bel\s+pr[oó]ximo\s+(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b|\bel\s+(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\s+que\s+viene\b/i.test(_msgFutLower);
            const _verboFuturo = /\bvoy\s+a\s+(gastar|pagar|comprar|invertir|salir|comer|cenar|almorzar)\b|\bgastar[eé]\b|\bpagar[eé]\b|\bcomprar[eé]\b|\bpienso\s+(gastar|comprar|pagar)\b/i.test(_msgFutLower);
            if (_marcadorFuturo && _verboFuturo) {
              log.info({ tag: 'FUTURE_DATE_REJECT', msg: msg.substring(0, 80) }, 'Mensaje describe gasto futuro — no registrar');
              return 'No registro gastos futuros. Cuando ya hayas hecho el gasto, dime el monto y lo anoto. Si querés, decí "recuérdame mañana" y te aviso.';
            }
          }

          const fechaHoy = fechaHoyPeru();
          const parsed = await parsearRegistroManual(msg, fechaHoy);
          if (!parsed.ok || !parsed.monto || parsed.monto <= 0) {
            const redirect = detectarQuerySinMonto(msg);
            if (redirect) {
              try {
                const { getHandler } = require('../intent-registry');
                const handlerRedir = getHandler(redirect.intencion);
                if (handlerRedir) {
                  log.info({ tag: 'QUERY_REDIRECT', from: 'registrar_manual', to: redirect.intencion, msg: msg.substring(0, 80) }, 'Query disfrazada como register (post-parser-fail)');
                  return await handlerRedir({ intencion: redirect.intencion, msg, datos: redirect.datos, usuario, from, ctx });
                }
              } catch(eRedir) { log.warn({ tag: 'QUERY_REDIRECT', err: eRedir.message }, 'Fallback redirect falló'); }
            }
            return 'No pude extraer el monto. Dime algo como: "gasté S/50 en farmacia" o "mi sueldo fue S/4500".';
          }
          // Guard timezone: el modelo a veces aluciona una fecha pasada aunque el usuario no la mencione.
          // Solo respetamos parsed.fecha si el mensaje contiene una referencia explícita de fecha.
          const _msgL = (msg || '').toLowerCase();
          const _tieneFechaExplicita = /\bayer\b|\bantier\b|\banteayer\b|\bhoy\b|\b(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b|\bla\s+semana\s+pasada\b|hace\s+\d+\s*(d[ií]a|hora|semana|mes)|\bel\s+\d{1,2}(\s+de\s+\w+)?\b|\b\d{1,2}\s*\/\s*\d{1,2}\b|\b\d{1,2}-\d{1,2}\b/i.test(_msgL);
          if (parsed.fecha && parsed.fecha !== fechaHoy && !_tieneFechaExplicita) {
            log.warn({ tag: 'TZ_GUARD_REGISTRO', fechaModelo: parsed.fecha, fechaHoy, msg: (msg || '').substring(0, 80) }, 'Modelo extrajo fecha pasada sin mencion del usuario — forzando hoy');
            parsed.fecha = fechaHoy;
          }
          // Re-clasificar con categorías y subcategorías custom del usuario
          const detCat = await detectarCategoriaIA(msg, usuario.id);
          if (detCat.categoria) {
            parsed.categoria = detCat.categoria;
            if (detCat.subcategoria) parsed.subcategoria = detCat.subcategoria;
          }
          // Auto-crear categoría/subcategoría custom si es nueva
          if (parsed.categoria && !CATEGORIAS_VALIDAS.has(parsed.categoria) && !CATEGORIA_MAP[parsed.categoria]) {
            crearCategoriaLibreUsuario(usuario.id, parsed.categoria);
          }
          if (parsed.subcategoria && parsed.subcategoria !== 'sin_categoria') {
            crearSubcategoriaLibreUsuario(usuario.id, parsed.categoria, parsed.subcategoria);
          }
          const tx = await guardarTransaccion(usuario.id, parsed);
          const esIngreso = parsed.tipo === 'ingreso';
          const montoStr = parsed.moneda === 'USD' ? '$' + parseFloat(parsed.monto).toFixed(2) : 'S/' + parseFloat(parsed.monto).toFixed(2);
          let respReg = '✅ ' + montoStr + ' en ' + (esIngreso ? 'Ingresos' : (parsed.categoria || 'Otros') + ' > ' + (parsed.subcategoria || 'sin_categoria')) + ' · ' + formatFecha(parsed.fecha);
          if (!esIngreso && parsed.categoria) {
            const alerta = await verificarAlertaPresupuesto(usuario.id, parsed.categoria, parsed.subcategoria || null);
            if (alerta) respReg += '\n\n' + alerta;
          }
          // Cada 5 registros, recordar la app
          const { count: txCount } = await supabase.from('transacciones')
            .select('*', { count: 'exact', head: true })
            .eq('usuario_id', usuario.id);
          if (txCount && txCount % 5 === 0) {
            respReg += '\n\n💡 _Revisa tus gráficos en https://app.neto.pe_';
          }
          return respReg;
        } catch(e) {
          log.error({ tag: 'REGISTRAR_MANUAL', err: e.message }, 'Error registro manual');
          return 'No pude procesar eso. Dime: "gasté S/50 en farmacia ayer" y lo anoto.';
        }
      }

      case 'corregir_categoria': {
        try {
          const catRaw = datos.categoria_nueva || datos.categoria || null;
          const _subRawTmp = datos.subcategoria_nueva || datos.subcategoria || null;
          const subRaw = (_subRawTmp && /^null$/i.test(String(_subRawTmp).trim())) ? null : _subRawTmp;
          const comercioRaw = datos.comercio || null;
          if (catRaw) {
            const catLibre = catRaw.charAt(0).toUpperCase() + catRaw.slice(1);
            const subLibre = subRaw ? subRaw.charAt(0).toUpperCase() + subRaw.slice(1) : null;
            let txActualizada = null;
            if (comercioRaw) {
              const res = await recategorizarTransaccion(usuario.id, comercioRaw, catLibre, subLibre);
              if (res.ok) txActualizada = res.tx || { comercio: comercioRaw, monto: null, moneda: 'PEN' };
              if (!res.ok) return res.msg;
            } else {
              txActualizada = await obtenerUltimaTransaccion(usuario.id);
              if (txActualizada) {
                const updFields = { categoria: catLibre };
                if (subLibre) updFields.subcategoria = subLibre;
                await supabase.from('transacciones').update(updFields).eq('id', txActualizada.id);
              } else {
                return '\u00bfDe qu\u00e9 gasto hablamos? D\u00edme el comercio y lo muevo.';
              }
            }
            // Crear categoría en categorias_usuario si es libre (no canónica)
            if (!CATEGORIAS_VALIDAS.has(catLibre) && !CATEGORIA_MAP[catLibre]) {
              crearCategoriaLibreUsuario(usuario.id, catLibre);
            }
            // Crear subcategoría si el usuario la especificó
            if (subLibre && subLibre !== 'Sin_categoria') {
              crearSubcategoriaLibreUsuario(usuario.id, catLibre, subLibre);
            }
            // Guardar regla y retroaplicar usando el comercio REAL de la DB (no el del usuario, que puede tener typos)
            const comercioReal = txActualizada?.comercio || comercioRaw;
            if (comercioReal) {
              guardarReglaComercio(usuario.id, comercioReal, catLibre, subLibre);
              retroaplicarRegla(usuario.id, comercioReal, catLibre, subLibre);
            }
            // Respuesta con moneda correcta
            const monedaTxCorr = txActualizada.moneda || 'PEN';
            const montoMostrar = monedaTxCorr === 'USD'
              ? '$' + parseFloat(txActualizada.monto || 0).toFixed(2) + (txActualizada.monto_pen ? ' (~S/' + parseFloat(txActualizada.monto_pen).toFixed(2) + ')' : '')
              : 'S/ ' + parseFloat(txActualizada.monto_pen || txActualizada.monto || 0).toFixed(2);
            return 'Listo! Movi *' + (txActualizada.comercio || 'el gasto') + '* (' + montoMostrar + ') a *' + catLibre + (subLibre ? ' > ' + subLibre : '') + '*.\n\n_Aplique el cambio a todos los pagos anteriores de ' + (comercioReal || 'ese comercio') + '._';
          }
          const ultimaTx2 = await obtenerUltimaTransaccion(usuario.id);
          const _ctxCorr = 'El usuario quiere mover un gasto pero no especifico la categoria. Ultimo gasto: ' + (ultimaTx2 ? ultimaTx2.comercio + ' ' + (ultimaTx2.moneda === 'USD' ? '$' : 'S/') + ultimaTx2.monto : 'sin datos') + '. Pregunta a que categoria moverlo. Puede ser una categoria personalizada.';
          const _respCorr = await redactarConNETO(netoPrompt, _ctxCorr, msg, historialConv);
          return _respCorr || '\u00bfA qu\u00e9 categor\u00eda lo muevo? D\u00edme y lo cambio.';
        } catch(e) {
          log.error({ tag: 'CORREGIR', err: e.message }, 'Error corrigiendo categoría');
          return 'No pude procesar eso. Usa: /cambiar [comercio] [categoria]';
        }
      }
      case 'corregir_multiple': {
        try {
          const correcciones = await parsearCorreccionesMultiples(msg);
          if (!correcciones || correcciones.length === 0) {
            const { WEBAPP_URL } = require('../../lib/constants');
            return '💡 No pude procesar eso directamente. Para cambios múltiples te recomiendo usar el dashboard:\n\n'
              + '👉 ' + WEBAPP_URL + '/dashboard/transacciones\n\n'
              + 'Ahí puedes filtrar y editar varios gastos de una vez.\n'
              + '_O dime uno por uno y lo hago por acá._';
          }
          const resultados = [];
          for (const corr of correcciones) {
            if (!corr.comercio || !corr.categoria_nueva) continue;
            const catLibre = corr.categoria_nueva.charAt(0).toUpperCase() + corr.categoria_nueva.slice(1);
            const _subCorrTmp = corr.subcategoria_nueva ? corr.subcategoria_nueva.charAt(0).toUpperCase() + corr.subcategoria_nueva.slice(1) : null;
            const res = await corregirTransaccionEspecifica(usuario.id, corr.comercio, corr.monto, corr.fecha, catLibre, _subCorrTmp);
            if (!CATEGORIAS_VALIDAS.has(catLibre) && !CATEGORIA_MAP[catLibre]) {
              crearCategoriaLibreUsuario(usuario.id, catLibre);
            }
            const subCorr = corr.subcategoria_nueva ? corr.subcategoria_nueva.charAt(0).toUpperCase() + corr.subcategoria_nueva.slice(1) : null;
            if (subCorr && subCorr !== 'Sin_categoria') {
              crearSubcategoriaLibreUsuario(usuario.id, catLibre, subCorr);
            }
            if (res.ok) {
              guardarReglaComercio(usuario.id, corr.comercio, catLibre, subCorr || null);
              retroaplicarRegla(usuario.id, corr.comercio, catLibre, subCorr || null);
              const montoStr = res.moneda === 'USD' ? '$' + parseFloat(res.monto).toFixed(2) : 'S/ ' + parseFloat(res.monto).toFixed(2);
              resultados.push('✅ *' + res.comercio + '* (' + montoStr + ') → ' + catLibre);
            } else {
              resultados.push('❌ No encontré gasto de *' + corr.comercio + '*');
            }
          }
          if (resultados.length === 0) return 'No pude aplicar ninguna corrección.';
          return 'Listo! Actualicé ' + resultados.length + ' gastos:\n\n' + resultados.join('\n');
        } catch(e) {
          log.error({ tag: 'MULT', err: e.message }, 'Error corrección múltiple');
          const { WEBAPP_URL } = require('../../lib/constants');
          return '💡 Hubo un error procesando eso. Para cambios múltiples usa el dashboard:\n\n'
            + '👉 ' + WEBAPP_URL + '/dashboard/transacciones\n\n'
            + '_O dime las correcciones de una en una._';
        }
      }

      case 'corregir_monto_moneda': {
        try {
          const ultimaTxM = await obtenerUltimaTransaccion(usuario.id);
          if (!ultimaTxM) return 'No encuentro el gasto al que te refieres. \u00bfDe cu\u00e1l se trata?';
          const updates = {};
          const nuevaMoneda = datos.moneda || 'USD'; // si mencionaron "dolares" sin especificar, asumimos USD
          const nuevoMonto = datos.monto ? parseFloat(datos.monto) : parseFloat(ultimaTxM.monto);
          updates.moneda = nuevaMoneda;
          updates.monto = nuevoMonto;
          if (nuevaMoneda === 'USD') {
            const tc = await obtenerTipoCambio();
            updates.monto_pen = parseFloat((nuevoMonto * tc.venta).toFixed(2));
            updates.tipo_cambio = tc.venta;
          } else {
            updates.monto_pen = nuevoMonto;
            updates.tipo_cambio = null;
          }
          await supabase.from('transacciones').update(updates).eq('id', ultimaTxM.id);
          const comercioM = ultimaTxM.comercio || 'el gasto';
          const montoStrM = nuevaMoneda === 'USD'
            ? '$' + nuevoMonto.toFixed(2) + ' (~S/ ' + updates.monto_pen.toFixed(2) + ')'
            : 'S/ ' + nuevoMonto.toFixed(2);
          return 'Corregido. *' + comercioM + '*: ' + montoStrM + ' en ' + (ultimaTxM.categoria || 'Otros') + '.';
        } catch(e) {
          log.error({ tag: 'CORREGIR_MONEDA', err: e.message }, 'Error corrigiendo monto/moneda');
          return 'No pude corregir la moneda. Int\u00e9ntalo de nuevo.';
        }
      }

      case 'eliminar_transaccion': {
        try {
          const comercioElim = datos.comercio || null;
          const montoElimReq = datos.monto != null ? parseFloat(datos.monto) : null;
          const fechaElimReq = datos.fecha || null;
          const EPS = 0.01;

          // Build candidate query — más preciso si hay comercio+monto+fecha
          let qElim = supabase.from('transacciones').select('*').eq('usuario_id', usuario.id);
          if (comercioElim) qElim = qElim.ilike('comercio', '%' + comercioElim + '%');
          if (fechaElimReq) qElim = qElim.eq('fecha', fechaElimReq);
          qElim = qElim.order('created_at', { ascending: false }).limit(20);
          const { data: candidatosElim } = await qElim;
          let candidatos = candidatosElim || [];

          // Filtrar por monto si fue especificado
          if (montoElimReq != null && candidatos.length > 0) {
            candidatos = candidatos.filter(c => Math.abs(parseFloat(c.monto) - montoElimReq) < EPS);
          }

          // Si no hubo filtro alguno, caer al último registro
          let txElim = null;
          if (!comercioElim && montoElimReq == null && !fechaElimReq) {
            txElim = await obtenerUltimaTransaccion(usuario.id);
          } else if (candidatos.length === 1) {
            txElim = candidatos[0];
          } else if (candidatos.length === 0) {
            const detalle = [
              comercioElim ? '*' + comercioElim + '*' : null,
              montoElimReq != null ? 'S/ ' + montoElimReq.toFixed(2) : null,
              fechaElimReq || null,
            ].filter(Boolean).join(' · ');
            return 'No encontré ningún gasto que coincida' + (detalle ? ' con ' + detalle : '') + '. ¿Puedes darme más datos (monto exacto o fecha)?';
          } else {
            // Varios matches — listar para que el usuario elija, sin borrar nada
            const lista = candidatos.slice(0, 6).map((c, i) => {
              const m = c.moneda === 'USD' ? '$' + parseFloat(c.monto).toFixed(2) : 'S/ ' + parseFloat(c.monto).toFixed(2);
              return (i+1) + '. ' + (c.comercio || 'Sin comercio') + ' — ' + m + ' · ' + (c.fecha || '');
            }).join('\n');
            return 'Encontré ' + candidatos.length + ' gastos que coinciden. ¿A cuál te refieres?\n\n' + lista + '\n\n_Respóndeme con el monto o la fecha exacta._';
          }

          if (!txElim) return '¿De qué gasto me hablas? Dime el comercio, monto o fecha y lo elimino.';

          // Snapshot para auditoría + restore
          const snapshot = { ...txElim };
          await supabase.from('transacciones_eliminadas').insert({
            usuario_id: usuario.id,
            tx_id: txElim.id,
            snapshot,
          }).then(() => {}).catch((err) => {
            log.warn({ tag: 'ELIMINAR_AUDIT', err: err.message }, 'No se pudo guardar snapshot');
          });

          // Limpiar consultas_pendientes asociadas antes de eliminar
          await supabase.from('consultas_pendientes').update({ estado: 'respondida', respondida_at: new Date().toISOString() }).eq('transaccion_id', txElim.id).eq('estado', 'pendiente');
          // Si es transacción de Gmail, guardar en excluidos para evitar re-importación
          if (txElim.descripcion_original && !txElim.descripcion_original.startsWith('duplicado:')) {
            await supabase.from('gmail_excluidos').upsert({ usuario_id: usuario.id, descripcion_original: txElim.descripcion_original }, { onConflict: 'usuario_id,descripcion_original' }).then(() => {}).catch(() => {});
          }
          await supabase.from('transacciones').delete().eq('id', txElim.id);
          const montoElim = txElim.moneda === 'USD' ? '$' + parseFloat(txElim.monto).toFixed(2) : 'S/ ' + parseFloat(txElim.monto).toFixed(2);
          return 'Listo. Eliminé *' + (txElim.comercio || 'ese gasto') + '* (' + montoElim + ') del ' + txElim.fecha + '.\n\n_Si fue un error, escribe "restaura" y lo devuelvo._';
        } catch(e) {
          log.error({ tag: 'ELIMINAR', err: e.message }, 'Error eliminando transacción');
          return 'No pude eliminarlo. ¿De cuál gasto se trata?';
        }
      }

      case 'restaurar_eliminado': {
        try {
          const comercioRest = datos.comercio || null;
          const montoRest = datos.monto != null ? parseFloat(datos.monto) : null;
          const EPS = 0.01;

          const { data: pendientes } = await supabase.from('transacciones_eliminadas').select('*')
            .eq('usuario_id', usuario.id).is('restored_at', null)
            .order('deleted_at', { ascending: false }).limit(20);

          if (!pendientes || pendientes.length === 0) {
            return 'No tengo ningún gasto eliminado reciente para restaurar.';
          }

          // Filtrar por comercio/monto si se especificaron
          let candidatos = pendientes;
          if (comercioRest) {
            const needle = comercioRest.toLowerCase();
            candidatos = candidatos.filter(p => String(p.snapshot?.comercio || '').toLowerCase().includes(needle));
          }
          if (montoRest != null) {
            candidatos = candidatos.filter(p => Math.abs(parseFloat(p.snapshot?.monto || 0) - montoRest) < EPS);
          }
          if (candidatos.length === 0) {
            // Caer al más reciente si el usuario no fue específico con algo que no matcheó
            candidatos = pendientes.slice(0, 1);
          }

          const objetivo = candidatos[0];
          const snap = objetivo.snapshot || {};
          // Re-insertar la fila preservando fecha/categoría/comercio original
          const payloadRestore = {
            usuario_id: usuario.id,
            monto: snap.monto,
            monto_pen: snap.monto_pen,
            moneda: snap.moneda,
            tipo_cambio: snap.tipo_cambio,
            comercio: snap.comercio,
            categoria: snap.categoria,
            subcategoria: snap.subcategoria,
            tipo: snap.tipo,
            banco: snap.banco,
            metodo_pago: snap.metodo_pago,
            fecha: snap.fecha,
            descripcion_original: snap.descripcion_original,
          };
          const { error: insErr } = await supabase.from('transacciones').insert(payloadRestore);
          if (insErr) {
            log.error({ tag: 'RESTAURAR', err: insErr.message }, 'Error al re-insertar tx');
            return 'No pude restaurar el gasto. Intenta registrarlo manualmente.';
          }
          await supabase.from('transacciones_eliminadas').update({ restored_at: new Date().toISOString() }).eq('id', objetivo.id);

          // Si estaba en gmail_excluidos, quitarlo para que vuelva a poder importarse
          if (snap.descripcion_original && !String(snap.descripcion_original).startsWith('duplicado:')) {
            await supabase.from('gmail_excluidos').delete()
              .eq('usuario_id', usuario.id)
              .eq('descripcion_original', snap.descripcion_original)
              .then(() => {}).catch(() => {});
          }

          const montoStr = snap.moneda === 'USD' ? '$' + parseFloat(snap.monto).toFixed(2) : 'S/ ' + parseFloat(snap.monto).toFixed(2);
          return '↩️ Restauré *' + (snap.comercio || 'el gasto') + '* (' + montoStr + ') del ' + (snap.fecha || '') + '.';
        } catch(e) {
          log.error({ tag: 'RESTAURAR', err: e.message }, 'Error restaurando tx');
          return 'No pude restaurar el gasto. Intenta de nuevo.';
        }
      }

      case 'editar_monto': {
        try {
          const montoNuevo = datos.monto_nuevo ? parseFloat(datos.monto_nuevo) : null;
          if (!montoNuevo || montoNuevo <= 0) return 'Dime el monto correcto. Ej: _"el monto es 50"_, _"corrige a S/120"_.';
          let txEditM = null;
          if (datos.comercio) {
            const { data: found } = await supabase.from('transacciones').select('*')
              .eq('usuario_id', usuario.id).ilike('comercio', '%' + datos.comercio + '%')
              .order('created_at', { ascending: false }).limit(1);
            txEditM = found && found.length > 0 ? found[0] : null;
          }
          if (!txEditM) txEditM = await obtenerUltimaTransaccion(usuario.id);
          if (!txEditM) return 'No encuentro un gasto reciente para corregir.';
          const monedaEdit = txEditM.moneda || 'PEN';
          const updates = { monto: montoNuevo };
          if (monedaEdit === 'USD') {
            const tc = await obtenerTipoCambio();
            updates.monto_pen = parseFloat((montoNuevo * tc.venta).toFixed(2));
          } else {
            updates.monto_pen = montoNuevo;
          }
          await supabase.from('transacciones').update(updates).eq('id', txEditM.id);
          const montoViejo = monedaEdit === 'USD' ? '$' + parseFloat(txEditM.monto).toFixed(2) : 'S/ ' + parseFloat(txEditM.monto).toFixed(2);
          const montoNuevoStr = monedaEdit === 'USD' ? '$' + montoNuevo.toFixed(2) : 'S/ ' + montoNuevo.toFixed(2);
          return '✅ Monto corregido.\n*' + (txEditM.comercio || 'Gasto') + '*: ' + montoViejo + ' → ' + montoNuevoStr;
        } catch(e) {
          log.error({ tag: 'EDITAR_MONTO', err: e.message }, 'Error editando monto');
          return 'No pude corregir el monto. Intenta de nuevo.';
        }
      }

      case 'editar_fecha': {
        try {
          let fechaNueva = datos.fecha_nueva;
          if (!fechaNueva) return 'Dime la fecha correcta. Ej: _"fue ayer"_, _"cámbialo al 15 de marzo"_.';
          // Parsear "ayer"
          if (fechaNueva === 'ayer') {
            fechaNueva = fechaAyerPeru();
          } else if (/^\d{1,2}$/.test(fechaNueva)) {
            // Solo día → asumir mes/año actual
            fechaNueva = anioActual + '-' + String(mesActual).padStart(2,'0') + '-' + String(parseInt(fechaNueva)).padStart(2,'0');
          }
          let txEditF = null;
          if (datos.comercio) {
            const { data: found } = await supabase.from('transacciones').select('*')
              .eq('usuario_id', usuario.id).ilike('comercio', '%' + datos.comercio + '%')
              .order('created_at', { ascending: false }).limit(1);
            txEditF = found && found.length > 0 ? found[0] : null;
          }
          if (!txEditF) txEditF = await obtenerUltimaTransaccion(usuario.id);
          if (!txEditF) return 'No encuentro un gasto reciente para corregir.';
          await supabase.from('transacciones').update({ fecha: fechaNueva }).eq('id', txEditF.id);
          return '✅ Fecha corregida.\n*' + (txEditF.comercio || 'Gasto') + '*: ' + formatFecha(txEditF.fecha) + ' → ' + formatFecha(fechaNueva);
        } catch(e) {
          log.error({ tag: 'EDITAR_FECHA', err: e.message }, 'Error editando fecha');
          return 'No pude corregir la fecha. Intenta de nuevo.';
        }
      }

      case 'editar_comercio': {
        try {
          const comercioNuevo = datos.comercio_nuevo;
          if (!comercioNuevo) return 'Dime el nombre correcto. Ej: _"el comercio es Plaza Vea"_.';
          let txEditC = null;
          if (datos.comercio) {
            const { data: found } = await supabase.from('transacciones').select('*')
              .eq('usuario_id', usuario.id).ilike('comercio', '%' + datos.comercio + '%')
              .order('created_at', { ascending: false }).limit(1);
            txEditC = found && found.length > 0 ? found[0] : null;
          }
          if (!txEditC) txEditC = await obtenerUltimaTransaccion(usuario.id);
          if (!txEditC) return 'No encuentro un gasto reciente para corregir.';
          const comercioViejo = txEditC.comercio || 'Sin nombre';
          await supabase.from('transacciones').update({ comercio: comercioNuevo }).eq('id', txEditC.id);
          return '✅ Comercio corregido.\n' + comercioViejo + ' → *' + comercioNuevo + '*';
        } catch(e) {
          log.error({ tag: 'EDITAR_COMERCIO', err: e.message }, 'Error editando comercio');
          return 'No pude corregir el comercio. Intenta de nuevo.';
        }
      }

      case 'dividir_gasto': {
        try {
          const partes = datos.partes ? parseInt(datos.partes) : null;
          if (!partes || partes < 2 || partes > 20) return 'Dime entre cuántos dividir. Ej: _"divide entre 3"_, _"mitad es mío"_.';
          let txDiv = null;
          if (datos.comercio) {
            const { data: found } = await supabase.from('transacciones').select('*')
              .eq('usuario_id', usuario.id).ilike('comercio', '%' + datos.comercio + '%')
              .order('created_at', { ascending: false }).limit(1);
            txDiv = found && found.length > 0 ? found[0] : null;
          }
          if (!txDiv) txDiv = await obtenerUltimaTransaccion(usuario.id);
          if (!txDiv) return 'No encuentro un gasto reciente para dividir.';
          const montoOriginal = parseFloat(txDiv.monto);
          const montoNuevoDiv = parseFloat((montoOriginal / partes).toFixed(2));
          const updates = { monto: montoNuevoDiv };
          if (txDiv.moneda === 'USD') {
            const tc = await obtenerTipoCambio();
            updates.monto_pen = parseFloat((montoNuevoDiv * tc.venta).toFixed(2));
          } else {
            updates.monto_pen = montoNuevoDiv;
          }
          await supabase.from('transacciones').update(updates).eq('id', txDiv.id);
          const monedaDiv = txDiv.moneda === 'USD' ? '$' : 'S/ ';
          return '✅ Gasto dividido entre ' + partes + '.\n*' + (txDiv.comercio || 'Gasto') + '*: ' + monedaDiv + montoOriginal.toFixed(2) + ' → ' + monedaDiv + montoNuevoDiv.toFixed(2) + ' (tu parte)';
        } catch(e) {
          log.error({ tag: 'DIVIDIR', err: e.message }, 'Error dividiendo gasto');
          return 'No pude dividir el gasto. Intenta de nuevo.';
        }
      }

      case 'duplicar_gasto': {
        try {
          const txDup = await obtenerUltimaTransaccion(usuario.id);
          if (!txDup) return 'No encuentro un gasto reciente para duplicar.';
          const fechaDup = datos.fecha || fechaHoyPeru();
          const datosDup = {
            monto: parseFloat(txDup.monto),
            moneda: txDup.moneda || 'PEN',
            comercio: txDup.comercio,
            categoria: txDup.categoria,
            subcategoria: txDup.subcategoria,
            tipo: txDup.tipo || 'gasto',
            banco: txDup.banco,
            metodo_pago: txDup.metodo_pago,
            fecha: fechaDup,
            descripcion_original: 'duplicado:' + txDup.id
          };
          await guardarTransaccion(usuario.id, datosDup);
          const monedaDup = txDup.moneda === 'USD' ? '$' : 'S/ ';
          return '✅ Gasto duplicado.\n*' + (txDup.comercio || 'Gasto') + '*: ' + monedaDup + parseFloat(txDup.monto).toFixed(2) + ' registrado para ' + formatFecha(fechaDup) + '.';
        } catch(e) {
          log.error({ tag: 'DUPLICAR', err: e.message }, 'Error duplicando gasto');
          return 'No pude duplicar el gasto. Intenta de nuevo.';
        }
      }

      case 'deshacer_ultimo': {
        try {
          const txDeshacer = await obtenerUltimaTransaccion(usuario.id);
          if (!txDeshacer) return 'No hay transacciones recientes para deshacer.';
          const montoDeshacer = txDeshacer.moneda === 'USD' ? '$' + parseFloat(txDeshacer.monto).toFixed(2) : 'S/ ' + parseFloat(txDeshacer.monto).toFixed(2);
          // Guardar snapshot para permitir restaurar después
          await supabase.from('transacciones_eliminadas').insert({
            usuario_id: usuario.id,
            tx_id: txDeshacer.id,
            snapshot: { ...txDeshacer },
          }).then(() => {}).catch((err) => {
            log.warn({ tag: 'DESHACER_AUDIT', err: err.message }, 'No se pudo guardar snapshot');
          });
          await supabase.from('transacciones').delete().eq('id', txDeshacer.id);
          return '↩️ *Deshecho:*\n\nEliminé *' + (txDeshacer.comercio || 'último registro') + '* — ' + montoDeshacer + ' del ' + (txDeshacer.fecha || '') + '.\n\n_Si fue un error, escribe "restaura" y lo devuelvo._';
        } catch(e) {
          log.error({ tag: 'DESHACER', err: e.message }, 'Error deshacer último');
          return 'No pude deshacer la última acción. Intenta de nuevo.';
        }
      }

      case 'editar_categoria_comercio': {
        try {
          const comercioRegla = datos.comercio;
          const catRegla = datos.categoria;
          const subRegla = datos.subcategoria || null;
          if (!comercioRegla || !catRegla) return 'Dime el comercio y la categoría. Ej: _"todo lo de Rappi siempre va en Delivery"_';
          await guardarReglaComercio(usuario.id, comercioRegla, catRegla, subRegla);
          const retro = await retroaplicarRegla(usuario.id, comercioRegla, catRegla, subRegla);
          return '✅ *Regla creada:*\n\n' + comercioRegla + ' → *' + catRegla + '* (siempre)\n\n' + (retro > 0 ? '🔄 Actualicé ' + retro + ' transacciones anteriores con esta regla.' : 'Se aplicará a las próximas transacciones.') + '\n\n_Puedes cambiarlo cuando quieras._';
        } catch(e) {
          log.error({ tag: 'REGLA_CAT', err: e.message }, 'Error editar categoría comercio');
          return 'No pude crear la regla. Intenta de nuevo.';
        }
      }

      case 'marcar_como_ingreso': {
        try {
          let txMarcar = null;
          if (datos.comercio) {
            const { data: found } = await supabase.from('transacciones').select('*')
              .eq('usuario_id', usuario.id).ilike('comercio', '%' + datos.comercio + '%')
              .order('created_at', { ascending: false }).limit(1);
            txMarcar = found && found.length > 0 ? found[0] : null;
          }
          if (!txMarcar) txMarcar = await obtenerUltimaTransaccion(usuario.id);
          if (!txMarcar) return 'No hay transacciones recientes para modificar.';
          const tipoNuevo = datos.tipo_nuevo || 'ingreso';
          await supabase.from('transacciones').update({ tipo: tipoNuevo }).eq('id', txMarcar.id);
          const montoMarcar = txMarcar.moneda === 'USD' ? '$' + parseFloat(txMarcar.monto).toFixed(2) : 'S/ ' + parseFloat(txMarcar.monto).toFixed(2);
          return '✅ *' + (txMarcar.comercio || 'Transacción') + '* (' + montoMarcar + ') ahora está marcado como *' + tipoNuevo + '*.\n\n_Tu balance se ha actualizado._';
        } catch(e) {
          log.error({ tag: 'MARCAR_INGRESO', err: e.message }, 'Error marcar como ingreso');
          return 'No pude cambiar el tipo. Intenta de nuevo.';
        }
      }

      default:
        return null;
    }
  }
};
