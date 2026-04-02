const log = require('../../lib/logger');

module.exports = {
  intents: [
    'crear_espacio', 'ver_espacios', 'registrar_gasto_espacio',
    'ver_balance_espacio', 'liquidar_espacio', 'invitar_espacio', 'unirse_espacio',
  ],
  async handle({ intencion, msg, datos, usuario, from, ctx }) {
    const { supabase } = ctx;
    const {
      crearEspacio, unirseEspacio, registrarGastoCompartido,
      obtenerBalanceEspacio, liquidarCuentas, obtenerEspaciosUsuario, obtenerResumenEspacio,
    } = require('../../services/shared-spaces');
    const { checkProLimit } = require('../../helpers/pro-wall');

    switch (intencion) {

      case 'crear_espacio': {
        try {
          // Check space limit
          const espacios = await obtenerEspaciosUsuario(usuario.id);
          const limitCheck = checkProLimit(usuario, 'maxSpaces', espacios.length);
          if (limitCheck.blocked) {
            return '🔒 Ya tienes ' + espacios.length + ' espacio compartido.\n\n_Con *Neto Pro* puedes crear espacios ilimitados._\nEscribe "ver premium" para más info.';
          }

          const nombre = datos.nombre || 'Mi espacio';
          const tipo = datos.tipo || 'custom';
          const space = await crearEspacio(usuario.id, nombre, tipo);

          const link = 'https://app.neto.pe/join/space/' + space.invite_code;
          return '🏠 *Espacio creado: ' + nombre + '*\n\n' +
            '🔗 Link de invitación:\n' + link + '\n\n' +
            '_Comparte este link con quien quieras agregar al espacio._\n' +
            '_También pueden unirse escribiéndole a Neto: "unirme al espacio ' + space.invite_code + '"_';
        } catch (e) {
          log.error({ tag: 'CREAR_ESPACIO', err: e.message }, 'Error creando espacio');
          return 'No pude crear el espacio. Intenta de nuevo.';
        }
      }

      case 'ver_espacios': {
        try {
          const espacios = await obtenerEspaciosUsuario(usuario.id);
          if (!espacios || espacios.length === 0) {
            return '🏠 No tienes espacios compartidos.\n\n_Crea uno: "crear espacio Depa" o "crear espacio pareja"_';
          }

          let resp = '🏠 *Tus espacios compartidos*\n\n';
          for (const e of espacios) {
            const tipoEmoji = e.type === 'pareja' ? '💑' : e.type === 'roommates' ? '🏘️' : '👥';
            resp += tipoEmoji + ' *' + e.name + '* (' + e.role + ')\n';
          }
          resp += '\n_Escribe "ver balance espacio [nombre]" para ver detalles._';
          return resp;
        } catch (e) {
          log.error({ tag: 'VER_ESPACIOS', err: e.message }, 'Error listando espacios');
          return 'No pude consultar tus espacios. Intenta de nuevo.';
        }
      }

      case 'registrar_gasto_espacio': {
        try {
          const monto = datos.monto ? parseFloat(datos.monto) : null;
          if (!monto || monto <= 0) return 'Dime el monto. Ej: _"pagué 200 de luz del depa"_';

          // Find the target space
          const espacios = await obtenerEspaciosUsuario(usuario.id);
          if (!espacios || espacios.length === 0) return 'No tienes espacios compartidos. Crea uno con _"crear espacio Depa"_.';

          let space = espacios[0];
          if (datos.nombre_espacio && espacios.length > 1) {
            const found = espacios.find(e => e.name.toLowerCase().includes(datos.nombre_espacio.toLowerCase()));
            if (found) space = found;
          }

          const descripcion = datos.descripcion || null;
          const categoria = datos.categoria || null;
          const { expense, memberCount } = await registrarGastoCompartido(
            usuario.id, space.id, monto, descripcion, categoria
          );

          const share = Math.round(monto / memberCount * 100) / 100;
          return '✅ *Gasto compartido registrado*\n\n' +
            '🏠 ' + space.name + '\n' +
            '💸 S/ ' + monto.toFixed(2) + (descripcion ? ' — ' + descripcion : '') + '\n' +
            '👥 Dividido entre ' + memberCount + ' personas (S/ ' + share.toFixed(2) + ' c/u)\n\n' +
            '_Los demás miembros ya fueron notificados._';
        } catch (e) {
          log.error({ tag: 'GASTO_ESPACIO', err: e.message }, 'Error registrando gasto compartido');
          return 'No pude registrar el gasto. Intenta de nuevo.';
        }
      }

      case 'ver_balance_espacio': {
        try {
          const espacios = await obtenerEspaciosUsuario(usuario.id);
          if (!espacios || espacios.length === 0) return 'No tienes espacios compartidos.';

          let space = espacios[0];
          if (datos.nombre_espacio && espacios.length > 1) {
            const found = espacios.find(e => e.name.toLowerCase().includes(datos.nombre_espacio.toLowerCase()));
            if (found) space = found;
          }

          const resumen = await obtenerResumenEspacio(usuario.id, space.id);
          if (!resumen) return 'No tienes acceso a ese espacio.';

          const { balance, members, recentExpenses } = resumen;
          let resp = '🏠 *' + space.name + '* — Balance\n\n';

          // Members
          resp += '👥 *Miembros:* ' + (members || []).map(m => m.usuarios?.nombre?.split(' ')[0] || '?').join(', ') + '\n\n';

          // Debts summary
          if (balance.debts.length === 0) {
            resp += '✅ ¡Están al día! No hay deudas pendientes.\n';
          } else {
            resp += '💰 *Deudas pendientes:*\n';
            for (const d of balance.debts) {
              const fromName = d.fromNombre?.split(' ')[0] || '?';
              const toName = d.toNombre?.split(' ')[0] || '?';
              const isMe = d.from === usuario.id;
              if (isMe) {
                resp += '  → Le debes S/ ' + d.amount.toFixed(2) + ' a ' + toName + '\n';
              } else if (d.to === usuario.id) {
                resp += '  → ' + fromName + ' te debe S/ ' + d.amount.toFixed(2) + '\n';
              } else {
                resp += '  → ' + fromName + ' le debe S/ ' + d.amount.toFixed(2) + ' a ' + toName + '\n';
              }
            }
          }

          // Recent expenses
          if (recentExpenses && recentExpenses.length > 0) {
            resp += '\n📋 *Últimos gastos:*\n';
            for (const exp of recentExpenses.slice(0, 5)) {
              const payer = exp.usuarios?.nombre?.split(' ')[0] || '?';
              resp += '  · ' + payer + ': S/ ' + parseFloat(exp.amount).toFixed(2) + (exp.description ? ' (' + exp.description + ')' : '') + '\n';
            }
          }

          resp += '\n_Dashboard: https://app.neto.pe/dashboard/espacios_';
          return resp;
        } catch (e) {
          log.error({ tag: 'BALANCE_ESPACIO', err: e.message }, 'Error balance espacio');
          return 'No pude obtener el balance. Intenta de nuevo.';
        }
      }

      case 'liquidar_espacio': {
        try {
          const monto = datos.monto ? parseFloat(datos.monto) : null;
          const contraparte = datos.contraparte || null;
          if (!monto || monto <= 0) return 'Dime cuánto pagaste. Ej: _"le pagué 150 a Juan del depa"_';
          if (!contraparte) return 'Dime a quién le pagaste. Ej: _"le pagué 150 a Juan del depa"_';

          // Find space
          const espacios = await obtenerEspaciosUsuario(usuario.id);
          if (!espacios || espacios.length === 0) return 'No tienes espacios compartidos.';

          let space = espacios[0];
          if (datos.nombre_espacio && espacios.length > 1) {
            const found = espacios.find(e => e.name.toLowerCase().includes(datos.nombre_espacio.toLowerCase()));
            if (found) space = found;
          }

          // Find counterpart member
          const { data: members } = await supabase.from('space_members')
            .select('user_id, usuarios(nombre)')
            .eq('space_id', space.id);
          const target = (members || []).find(m =>
            m.user_id !== usuario.id &&
            m.usuarios?.nombre?.toLowerCase().includes(contraparte.toLowerCase())
          );
          if (!target) return 'No encontré a "' + contraparte + '" en el espacio *' + space.name + '*.';

          await liquidarCuentas(space.id, usuario.id, target.user_id, monto);
          const targetName = target.usuarios?.nombre?.split(' ')[0] || contraparte;
          return '✅ *Pago registrado*\n\n' +
            'Le pagaste S/ ' + monto.toFixed(2) + ' a ' + targetName + ' en *' + space.name + '*.\n\n' +
            '_' + targetName + ' fue notificado/a._';
        } catch (e) {
          log.error({ tag: 'LIQUIDAR', err: e.message }, 'Error liquidando');
          return 'No pude registrar el pago. Intenta de nuevo.';
        }
      }

      case 'invitar_espacio': {
        try {
          const espacios = await obtenerEspaciosUsuario(usuario.id);
          if (!espacios || espacios.length === 0) return 'No tienes espacios compartidos. Crea uno con _"crear espacio Depa"_.';

          let space = espacios[0];
          if (datos.nombre_espacio && espacios.length > 1) {
            const found = espacios.find(e => e.name.toLowerCase().includes(datos.nombre_espacio.toLowerCase()));
            if (found) space = found;
          }

          // Check member limit
          const { data: members } = await supabase.from('space_members').select('id').eq('space_id', space.id);
          const memberLimit = checkProLimit(usuario, 'maxSpaceMembers', members?.length || 0);
          if (memberLimit.blocked) {
            return '🔒 Tu espacio tiene ' + (members?.length || 0) + ' miembros (máximo ' + memberLimit.limit + ').\n\n_Con *Neto Pro* puedes tener hasta 6 miembros._';
          }

          const link = 'https://app.neto.pe/join/space/' + space.invite_code;
          return '🔗 *Invitación a ' + space.name + '*\n\n' +
            'Link: ' + link + '\n\n' +
            'También pueden unirse escribiéndole a Neto:\n_"unirme al espacio ' + space.invite_code + '"_';
        } catch (e) {
          log.error({ tag: 'INVITAR', err: e.message }, 'Error invitando');
          return 'No pude generar la invitación. Intenta de nuevo.';
        }
      }

      case 'unirse_espacio': {
        try {
          const codigo = datos.codigo || null;
          if (!codigo) return 'Necesito el código de invitación. Ej: _"unirme al espacio ABC12345"_';

          const result = await unirseEspacio(usuario.id, codigo);
          if (!result) return 'No encontré un espacio con ese código. Verifica e intenta de nuevo.';

          if (result.alreadyMember) {
            return '👍 Ya eres parte de *' + result.space.name + '*.\n_Escribe "ver balance espacio" para ver detalles._';
          }

          return '🎉 *¡Te uniste a ' + result.space.name + '!*\n\n' +
            '_Los gastos compartidos se dividirán equitativamente entre todos los miembros._\n' +
            '_Escribe "ver balance espacio" para ver detalles._';
        } catch (e) {
          log.error({ tag: 'UNIRSE', err: e.message }, 'Error uniéndose');
          return 'No pude unirte al espacio. Intenta de nuevo.';
        }
      }

    }
  }
};
