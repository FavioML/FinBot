const log = require('../../lib/logger');

module.exports = {
  intents: ['registrar_manual', 'corregir_categoria', 'corregir_multiple', 'corregir_monto_moneda', 'eliminar_transaccion', 'editar_monto', 'editar_fecha', 'editar_comercio', 'editar_categoria_comercio', 'deshacer_ultimo', 'marcar_como_ingreso', 'dividir_gasto', 'duplicar_gasto'],
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
          const fechaHoy = fechaHoyPeru();
          const parsed = await parsearRegistroManual(msg, fechaHoy);
          if (!parsed.ok || !parsed.monto || parsed.monto <= 0) {
            return 'No pude extraer el monto. Dime algo como: "gasté S/50 en farmacia" o "mi sueldo fue S/4500".';
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
            return 'No pude entender las correcciones. Dime una por una: "Netflix pasalo a Entretenimiento".';
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
          return 'No pude procesar las correcciones. Intenta una por una.';
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
          let txElim = null;
          if (comercioElim) {
            const { data: txsElim } = await supabase.from('transacciones').select('*')
              .eq('usuario_id', usuario.id).ilike('comercio', '%' + comercioElim + '%')
              .order('created_at', { ascending: false }).limit(1);
            txElim = txsElim?.[0] || null;
          } else {
            txElim = await obtenerUltimaTransaccion(usuario.id);
          }
          if (!txElim) return '\u00bfDe qu\u00e9 gasto me hablas? D\u00edme el comercio y lo elimino.';
          // Limpiar consultas_pendientes asociadas antes de eliminar
          await supabase.from('consultas_pendientes').update({ estado: 'respondida', respondida_at: new Date().toISOString() }).eq('transaccion_id', txElim.id).eq('estado', 'pendiente');
          // Si es transacción de Gmail, guardar en excluidos para evitar re-importación
          if (txElim.descripcion_original && !txElim.descripcion_original.startsWith('duplicado:')) {
            await supabase.from('gmail_excluidos').upsert({ usuario_id: usuario.id, descripcion_original: txElim.descripcion_original }, { onConflict: 'usuario_id,descripcion_original' }).then(() => {}).catch(() => {});
          }
          await supabase.from('transacciones').delete().eq('id', txElim.id);
          const montoElim = txElim.moneda === 'USD' ? '$' + parseFloat(txElim.monto).toFixed(2) : 'S/ ' + parseFloat(txElim.monto).toFixed(2);
          return 'Listo. Elimin\u00e9 *' + (txElim.comercio || 'ese gasto') + '* (' + montoElim + ') del ' + txElim.fecha + '.';
        } catch(e) {
          log.error({ tag: 'ELIMINAR', err: e.message }, 'Error eliminando transacción');
          return 'No pude eliminarlo. \u00bfDe cu\u00e1l gasto se trata?';
        }
      }

      case 'editar_monto': {
        try {
          const montoNuevo = datos.monto_nuevo ? parseFloat(datos.monto_nuevo) : null;
          if (!montoNuevo || montoNuevo <= 0) return 'Dime el monto correcto. Ej: _"el monto es 50"_, _"corrige a S/120"_.';
          const txEditM = await obtenerUltimaTransaccion(usuario.id);
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
          const txEditF = await obtenerUltimaTransaccion(usuario.id);
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
          const txEditC = await obtenerUltimaTransaccion(usuario.id);
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
          const txDiv = await obtenerUltimaTransaccion(usuario.id);
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
          await supabase.from('transacciones').delete().eq('id', txDeshacer.id);
          return '↩️ *Deshecho:*\n\nEliminé *' + (txDeshacer.comercio || 'último registro') + '* — ' + montoDeshacer + ' del ' + (txDeshacer.fecha || '') + '.\n\n_Si fue un error, puedes volver a registrarlo._';
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
          const txMarcar = await obtenerUltimaTransaccion(usuario.id);
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
