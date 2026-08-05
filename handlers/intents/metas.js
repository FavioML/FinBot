const log = require('../../lib/logger');
const { generarCodigoInvitacion, ALFABETO_META } = require('../../lib/codigos-seguros');

module.exports = {
  intents: ['ver_metas', 'crear_meta', 'editar_meta', 'eliminar_meta', 'abonar_meta', 'compartir_meta', 'viabilidad_plan', 'abandonar_plan', 'sugerir_recortes'],
  async handle({ intencion, msg, datos, usuario, from, ctx }) {
    const {
      supabase, barraProgreso, formatFecha, calcularRitmoAhorro,
      abonarMetaService, registrarLogro, verificarRachaAportes
    } = ctx;

    switch (intencion) {

      case 'ver_metas': {
        try {
          const { data: metas } = await supabase.from('metas_ahorro').select('*').eq('usuario_id', usuario.id).order('created_at', { ascending: false });
          if (!metas || metas.length === 0) return '🎯 No tienes planes de ahorro.\n\n_Crea uno: "quiero ahorrar S/5000 para julio"_';
          let msgMetas = '🎯 *Tus planes de ahorro*\n\n';
          metas.forEach(m => {
            const status = m.status || (m.completada ? 'completed' : 'active');
            const statusIcon = status === 'completed' ? '✅ ' : status === 'abandoned' ? '🚫 ' : '';
            const pctM = m.monto_objetivo > 0 ? ((m.monto_actual / m.monto_objetivo) * 100).toFixed(0) : 0;
            const barra = barraProgreso(parseFloat(pctM));
            msgMetas += statusIcon + '*' + m.nombre + '*' + (m.icono ? ' ' + m.icono : '') + '\n' + barra + '\nS/ ' + parseFloat(m.monto_actual || 0).toFixed(2) + ' / S/ ' + parseFloat(m.monto_objetivo).toFixed(2);
            if (m.fecha_limite) {
              msgMetas += ' · Meta: ' + formatFecha(m.fecha_limite);
              if (status === 'active') {
                if (m.monthly_quota) {
                  msgMetas += '\n💰 Cuota: S/ ' + parseFloat(m.monthly_quota).toFixed(0) + '/mes';
                }
                const ritmo = calcularRitmoAhorro(m);
                if (ritmo.montoMensual !== null && ritmo.montoMensual > 0) {
                  msgMetas += '\n📊 Ritmo: S/ ' + ritmo.montoMensual.toFixed(0) + '/mes ' + (ritmo.enRitmo ? '✅' : '⚠️');
                }
              }
            }
            msgMetas += '\n\n';
          });
          msgMetas += '_Abona: "ahorré 200 para [nombre]"_\n_Dashboard: https://app.neto.pe/dashboard/metas_';
          return msgMetas;
        } catch(e) {
          log.error({ tag: 'METAS', err: e.message }, 'Error consultando metas');
          return 'No pude consultar tus metas. Intenta de nuevo.';
        }
      }

      case 'crear_meta': {
        try {
          const { checkProLimit } = require('../../helpers/pro-wall');
          const { calcularCuotaMensual, analizarViabilidad } = require('../../services/metas');

          const nombreMeta = datos.nombre || 'Mi meta';
          const montoMeta = datos.monto ? parseFloat(datos.monto) : null;
          if (!montoMeta || montoMeta <= 0) return 'Dime cuánto quieres ahorrar. Ej: _"quiero ahorrar S/5000 para julio"_.';
          const fechaLimMeta = datos.fecha_limite || null;

          // Enforce maxMetas for free users (only on new creation)
          const { data: metasActivas } = await supabase.from('metas_ahorro')
            .select('id', { count: 'exact', head: true })
            .eq('usuario_id', usuario.id).eq('completada', false);
          const countActivas = metasActivas ? metasActivas.length : 0;
          const limitCheck = checkProLimit(usuario, 'maxMetas', countActivas);
          if (limitCheck.blocked) {
            return '🎯 Ya tienes ' + countActivas + ' plan de ahorro activo.\n\n_Con *Neto Pro* puedes crear planes ilimitados._\nEscribe "ver premium" para más info.';
          }

          // Calculate monthly quota if deadline exists
          const monthlyQuota = fechaLimMeta ? calcularCuotaMensual(montoMeta, 0, fechaLimMeta) : null;

          await supabase.from('metas_ahorro').insert({
            usuario_id: usuario.id, nombre: nombreMeta, monto_objetivo: montoMeta,
            monto_actual: 0, fecha_limite: fechaLimMeta, status: 'active',
            monthly_quota: monthlyQuota,
          });

          let resp = '✅ Plan de ahorro creado!\n\n🎯 *' + nombreMeta + '*\nObjetivo: S/ ' + montoMeta.toFixed(2);
          if (fechaLimMeta) resp += '\nFecha: ' + formatFecha(fechaLimMeta);
          if (monthlyQuota) resp += '\n💰 Cuota mensual: S/ ' + monthlyQuota.toFixed(0) + '/mes';

          // Viability analysis for Pro users
          if (monthlyQuota && usuario.plan === 'premium') {
            try {
              const viability = await analizarViabilidad(usuario.id, monthlyQuota);
              resp += '\n\n' + (viability.viable ? '✅' : '⚠️') + ' ' + viability.mensaje;
            } catch (e) { /* silent — non-critical */ }
          }

          resp += '\n\n_Actualiza tu progreso en https://app.neto.pe/dashboard/metas_';
          return resp;
        } catch(e) {
          log.error({ tag: 'CREAR_META', err: e.message }, 'Error creando meta');
          return 'No pude crear el plan. Intenta de nuevo.';
        }
      }

      case 'editar_meta': {
        try {
          const { data: metasEdit } = await supabase.from('metas_ahorro').select('*')
            .eq('usuario_id', usuario.id).order('created_at', { ascending: false });
          if (!metasEdit || !metasEdit.length) return 'No tienes metas de ahorro. Crea una con _"quiero ahorrar S/2000 para julio"_.';
          let metaTarget = metasEdit[0];
          if (datos.nombre && metasEdit.length > 1) {
            const found = metasEdit.find(m => m.nombre.toLowerCase().includes(datos.nombre.toLowerCase()));
            if (found) metaTarget = found;
          }
          const updates = {};
          if (datos.monto_nuevo) updates.monto_objetivo = parseFloat(datos.monto_nuevo);
          if (datos.fecha_nueva) updates.fecha_limite = datos.fecha_nueva;
          if (Object.keys(updates).length === 0) return 'Dime qué quieres cambiar. Ej: _"sube mi meta a 3000"_ o _"cambia la fecha al 30 de junio"_.';
          await supabase.from('metas_ahorro').update(updates).eq('id', metaTarget.id);
          const montoObj = updates.monto_objetivo || metaTarget.monto_objetivo;
          return '✅ Meta *' + metaTarget.nombre + '* actualizada.\n\n🎯 Objetivo: S/ ' + parseFloat(montoObj).toFixed(0) + '\n📅 Fecha límite: ' + (updates.fecha_limite || metaTarget.fecha_limite || 'Sin fecha') + '\n💰 Ahorrado: S/ ' + parseFloat(metaTarget.monto_actual || 0).toFixed(0);
        } catch(e) {
          log.error({ tag: 'EDIT_META', err: e.message }, 'Error editar meta');
          return 'No pude editar la meta. Intenta de nuevo.';
        }
      }

      case 'eliminar_meta': {
        try {
          const { data: metasDel } = await supabase.from('metas_ahorro').select('*')
            .eq('usuario_id', usuario.id).order('created_at', { ascending: false });
          if (!metasDel || !metasDel.length) return 'No tienes metas de ahorro para eliminar.';
          let metaDel = metasDel[0];
          if (datos.nombre && metasDel.length > 1) {
            const found = metasDel.find(m => m.nombre.toLowerCase().includes(datos.nombre.toLowerCase()));
            if (found) metaDel = found;
          }
          await supabase.from('metas_ahorro').delete().eq('id', metaDel.id);
          return '✅ Eliminé la meta *' + metaDel.nombre + '* (S/ ' + parseFloat(metaDel.monto_actual || 0).toFixed(0) + ' de S/ ' + parseFloat(metaDel.monto_objetivo).toFixed(0) + ').\n\n_Puedes crear otra cuando quieras._';
        } catch(e) {
          log.error({ tag: 'DEL_META', err: e.message }, 'Error eliminar meta');
          return 'No pude eliminar la meta. Intenta de nuevo.';
        }
      }

      case 'abonar_meta': {
        try {
          const montoAbono = parseFloat(datos.monto);
          if (!montoAbono || montoAbono <= 0) return 'Dime cuánto quieres abonar. Ej: _"aboné 500 a mi meta"_.';
          // Detectar retiro
          const esRetiro = /\b(saqu[eé]|retir[eé]|quit[eé]|us[eé]|tom[eé])\b/i.test(msg);
          const nombreMeta = datos.nombre_meta || datos.nombre || null;
          const resultado = await abonarMetaService(usuario.id, nombreMeta, montoAbono, esRetiro ? 'retiro' : 'aporte', datos.nota || null);
          if (!resultado) return 'No tienes metas de ahorro activas. Crea una con _"quiero ahorrar S/2000 para julio"_.';
          const { meta, completada, porcentaje, milestone } = resultado;
          const nuevoActual = parseFloat(meta.monto_actual || 0);
          const objetivo = parseFloat(meta.monto_objetivo);
          const faltante = Math.max(0, objetivo - nuevoActual);

          let respMeta = '';
          if (esRetiro) {
            respMeta = '📤 *Retiro registrado*\n\n🎯 ' + meta.nombre + '\n💰 S/ ' + nuevoActual.toFixed(0) + ' de S/ ' + objetivo.toFixed(0) + ' (' + porcentaje + '%)';
          } else if (completada) {
            respMeta = '🎉 *¡META CUMPLIDA!*\n\n🎯 ' + meta.nombre + '\n💰 S/ ' + nuevoActual.toFixed(0) + ' de S/ ' + objetivo.toFixed(0) + ' (100%)\n\n¡Felicitaciones! Lograste tu meta. 🏆';
            try { await registrarLogro(usuario.id, 'meta_cumplida', meta.id); } catch(e) { /* silent */ }
          } else {
            respMeta = '✅ *Abono registrado*\n\n🎯 ' + meta.nombre + '\n💰 S/ ' + nuevoActual.toFixed(0) + ' de S/ ' + objetivo.toFixed(0) + ' (' + porcentaje + '%)\n_Te falta S/ ' + faltante.toFixed(0) + '._';
          }

          // Ritmo de ahorro si hay fecha límite
          if (meta.fecha_limite && !completada && !esRetiro) {
            const ritmo = calcularRitmoAhorro(meta);
            if (ritmo.montoMensual !== null && ritmo.montoMensual > 0) {
              respMeta += '\n📊 Necesitas S/ ' + ritmo.montoMensual.toFixed(0) + '/mes para llegar a tiempo ' + (ritmo.enRitmo ? '✅' : '⚠️');
            }
          }

          // Milestones (gamificación)
          if (milestone && milestone !== 100) {
            respMeta += '\n\n🏅 *¡Llegaste al ' + milestone + '%!* Sigue así.';
            try { await registrarLogro(usuario.id, 'milestone_' + milestone, meta.id); } catch(e) { /* silent */ }
          }

          // Racha
          try {
            const racha = await verificarRachaAportes(usuario.id, meta.id);
            if (racha >= 3) {
              respMeta += '\n🔥 Racha: ' + racha + ' semanas seguidas ahorrando!';
              if (racha % 3 === 0) { try { await registrarLogro(usuario.id, 'racha_' + racha, meta.id, { semanas: racha }); } catch(e) { /* silent */ } }
            }
          } catch(e) { /* silent */ }

          return respMeta;
        } catch(e) {
          log.error({ tag: 'ABONAR_META', err: e.message }, 'Error abonar meta');
          return 'No pude registrar el abono. Intenta de nuevo.';
        }
      }

      case 'compartir_meta': {
        try {
          // Find an active goal to share
          const { data: metasComp } = await supabase
            .from('metas_ahorro')
            .select('id, nombre, icono, monto_objetivo, monto_actual, invite_code, colaborativa')
            .eq('usuario_id', usuario.id)
            .eq('completada', false)
            .order('created_at', { ascending: false });
          if (!metasComp || metasComp.length === 0) return 'No tienes metas activas. Crea una primero: _"quiero ahorrar 3000 para un viaje"_';
          // Use first active goal or try to match by name
          let targetMeta = metasComp[0];
          const mNombre = msg.match(/(?:meta|ahorro)\s+(?:de\s+)?(?:mi\s+)?(.+)/i);
          if (mNombre) {
            const buscar = mNombre[1].trim().toLowerCase();
            const found = metasComp.find(m => m.nombre.toLowerCase().includes(buscar));
            if (found) targetMeta = found;
          }
          // Generate invite code if not exists
          let inviteCode = targetMeta.invite_code;
          if (!inviteCode) {
            // Fuente criptografica: el codigo ES la credencial para entrar a la meta de
            // otro. Salia de Math.random(), igual que el espejo de la webapp antes de S4.
            inviteCode = generarCodigoInvitacion(ALFABETO_META, 8);
            await supabase.from('metas_ahorro').update({ invite_code: inviteCode, colaborativa: true }).eq('id', targetMeta.id);
            // Ensure creator is in meta_participantes
            await supabase.from('meta_participantes').upsert({ meta_id: targetMeta.id, usuario_id: usuario.id, rol: 'creador' }, { onConflict: 'meta_id,usuario_id' });
          }
          const link = 'https://app.neto.pe/join/meta/' + inviteCode;
          const pct = targetMeta.monto_objetivo > 0 ? Math.round((targetMeta.monto_actual / targetMeta.monto_objetivo) * 100) : 0;
          return '👥 *Meta colaborativa activada*\n\n' + (targetMeta.icono || '🎯') + ' ' + targetMeta.nombre + '\n📊 Progreso: ' + pct + '%\n\n🔗 *Link de invitación:*\n' + link + '\n\n_Comparte este link con quien quieras que aporte a tu meta._';
        } catch(e) {
          log.error({ tag: 'COMPARTIR_META', err: e.message }, 'Error compartir meta');
          return 'No pude generar el link. Intenta de nuevo.';
        }
      }

      case 'viabilidad_plan': {
        try {
          const { checkProWall } = require('../../helpers/pro-wall');
          const wall = checkProWall(usuario, 'metasViability');
          if (wall.blocked) return '🔒 El análisis de viabilidad está disponible con *Neto Pro*.\n\n_Escribe "ver premium" para más info._';

          const { analizarViabilidad, calcularCuotaMensual } = require('../../services/metas');
          const { data: metas } = await supabase.from('metas_ahorro').select('*')
            .eq('usuario_id', usuario.id).eq('completada', false).order('created_at', { ascending: false });
          if (!metas || metas.length === 0) return 'No tienes planes de ahorro activos.';

          let meta = metas[0];
          if (datos.nombre && metas.length > 1) {
            const found = metas.find(m => m.nombre.toLowerCase().includes(datos.nombre.toLowerCase()));
            if (found) meta = found;
          }

          const cuota = meta.monthly_quota ? parseFloat(meta.monthly_quota)
            : calcularCuotaMensual(parseFloat(meta.monto_objetivo), parseFloat(meta.monto_actual || 0), meta.fecha_limite);
          if (!cuota) return '📊 *' + meta.nombre + '* no tiene fecha límite. Agrega una para analizar viabilidad.';

          const viability = await analizarViabilidad(usuario.id, cuota);
          return '📊 *Viabilidad: ' + meta.nombre + '*\n\n' +
            '💰 Cuota mensual: S/ ' + cuota.toFixed(0) + '\n' +
            '📈 Margen libre: S/ ' + viability.margenLibre + '/mes\n\n' +
            (viability.viable ? '✅' : '⚠️') + ' ' + viability.mensaje;
        } catch (e) {
          log.error({ tag: 'VIABILIDAD', err: e.message }, 'Error análisis viabilidad');
          return 'No pude analizar la viabilidad. Intenta de nuevo.';
        }
      }

      case 'abandonar_plan': {
        try {
          const { abandonarPlan } = require('../../services/metas');
          const { data: metas } = await supabase.from('metas_ahorro').select('*')
            .eq('usuario_id', usuario.id).eq('completada', false).order('created_at', { ascending: false });
          if (!metas || metas.length === 0) return 'No tienes planes de ahorro activos.';

          let meta = metas[0];
          if (datos.nombre && metas.length > 1) {
            const found = metas.find(m => m.nombre.toLowerCase().includes(datos.nombre.toLowerCase()));
            if (found) meta = found;
          }

          const result = await abandonarPlan(usuario.id, meta.id);
          if (!result) return 'No pude abandonar el plan. Intenta de nuevo.';

          const ahorrado = parseFloat(meta.monto_actual || 0);
          return '🚫 Plan *' + meta.nombre + '* marcado como abandonado.\n\n' +
            (ahorrado > 0 ? '💰 Habías ahorrado S/ ' + ahorrado.toFixed(0) + '. Ese dinero sigue siendo tuyo.\n\n' : '') +
            '_Puedes crear un nuevo plan cuando quieras._';
        } catch (e) {
          log.error({ tag: 'ABANDONAR', err: e.message }, 'Error abandonar plan');
          return 'No pude procesar tu solicitud. Intenta de nuevo.';
        }
      }

      case 'sugerir_recortes': {
        try {
          const { checkProWall } = require('../../helpers/pro-wall');
          const wall = checkProWall(usuario, 'metasCuts');
          if (wall.blocked) return '🔒 Las sugerencias de recorte están disponibles con *Neto Pro*.\n\n_Escribe "ver premium" para más info._';

          const { sugerirRecortes, calcularCuotaMensual } = require('../../services/metas');
          const { data: metas } = await supabase.from('metas_ahorro').select('*')
            .eq('usuario_id', usuario.id).eq('completada', false).order('created_at', { ascending: false });
          if (!metas || metas.length === 0) return 'No tienes planes de ahorro activos.';

          let meta = metas[0];
          if (datos.nombre && metas.length > 1) {
            const found = metas.find(m => m.nombre.toLowerCase().includes(datos.nombre.toLowerCase()));
            if (found) meta = found;
          }

          const cuota = meta.monthly_quota ? parseFloat(meta.monthly_quota)
            : calcularCuotaMensual(parseFloat(meta.monto_objetivo), parseFloat(meta.monto_actual || 0), meta.fecha_limite);
          if (!cuota) return 'Tu plan no tiene cuota mensual definida. Agrega una fecha límite para obtener sugerencias.';

          const recortes = await sugerirRecortes(usuario.id, cuota);
          if (!recortes || recortes.length === 0) return 'No encontré categorías donde sugerir recortes. ¡Parece que ya eres bastante eficiente! 💪';

          let resp = '✂️ *Sugerencias de recorte para ' + meta.nombre + '*\n(Cuota: S/ ' + cuota.toFixed(0) + '/mes)\n\n';
          recortes.forEach((r, i) => {
            resp += (i + 1) + '. *' + r.categoria + '*: gastas S/ ' + r.gastoActual.toFixed(0) + '/mes\n' +
              '   → Podrías reducir ~S/ ' + r.reduccionSugerida.toFixed(0) + '\n';
          });
          resp += '\n_Estas sugerencias son orientativas. Tú decides qué ajustar._';
          return resp;
        } catch (e) {
          log.error({ tag: 'RECORTES', err: e.message }, 'Error sugerir recortes');
          return 'No pude generar sugerencias. Intenta de nuevo.';
        }
      }

    }
  }
};
