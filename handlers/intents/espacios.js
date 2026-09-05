const log = require('../../lib/logger');

module.exports = {
  intents: [
    'crear_espacio', 'ver_espacios', 'registrar_gasto_espacio',
    'ver_balance_espacio', 'liquidar_espacio', 'invitar_espacio', 'unirse_espacio',
    'editar_split_espacio',
  ],
  async handle({ intencion, msg, datos, usuario, from, ctx }) {
    const { supabase } = ctx;
    const {
      crearEspacio, unirseEspacio, notificarNuevoMiembro, registrarGastoCompartido,
      obtenerBalanceEspacio, liquidarCuentas, obtenerEspaciosUsuario, obtenerResumenEspacio,
    } = require('../../services/shared-spaces');
    const { effectiveSplitPercents, shareCents } = require('../../services/spaces-split');
    const { checkProLimit } = require('../../helpers/pro-wall');
    const { validarMonto } = require('../../lib/validators');
    const { estaEnMuro, enlaceApp } = require('../../lib/trial');

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
          // `parseFloat` solo no alcanza: "1e999" sobrevive como Infinity y
          // `!Infinity` es false, asi que un monto absurdo pasaba el guard y
          // descuadraba el balance del grupo. `validarMonto` es el mismo tope
          // (999999.99) que ya aplican la webapp y el resto del backend.
          const monto = validarMonto(datos.monto);
          if (!monto) return 'Dime el monto. Ej: _"pagué 200 de luz del depa"_';

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
          const { snapshot } = await registrarGastoCompartido(
            usuario.id, space.id, monto, descripcion, categoria
          );

          // El resumen sale de la division real con la que se guardo el gasto.
          // Antes anunciaba siempre "partes iguales", que era mentira en cuanto el
          // espacio tenia porcentajes desiguales o una regla por categoria.
          const miParte = shareCents(snapshot, usuario.id) / 100;
          const personas = snapshot.shares.filter(s => s.cents > 0).length;
          const detalle = snapshot.source === 'rule'
            ? '👥 Dividido según la regla de ' + (categoria || 'la categoría') + ' (tu parte: S/ ' + miParte.toFixed(2) + ')'
            : '👥 Dividido entre ' + personas + ' persona' + (personas === 1 ? '' : 's') + ' (tu parte: S/ ' + miParte.toFixed(2) + ')';

          return '✅ *Gasto compartido registrado*\n\n' +
            '🏠 ' + space.name + '\n' +
            '💸 S/ ' + monto.toFixed(2) + (descripcion ? ' — ' + descripcion : '') + '\n' +
            detalle + '\n\n' +
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
          // Mismo guard que el gasto: una liquidacion con monto absurdo o Infinity
          // mueve el ledger del espacio igual de lejos.
          const monto = validarMonto(datos.monto);
          const contraparte = datos.contraparte || null;
          if (!monto) return 'Dime cuánto pagaste. Ej: _"le pagué 150 a Juan del depa"_';
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
          // Con esta lectura caída, `members || []` deja el `.find` sin nada que encontrar y la
          // respuesta era 'No encontré a "Juan" en el espacio Depa' — una afirmación sobre quién
          // está adentro, hecha sin haber podido mirar. Y el pago no se registra.
          const { data: members, error: errMembers } = await supabase.from('space_members')
            .select('user_id, usuarios(nombre)')
            .eq('space_id', space.id);
          if (errMembers) {
            log.warn({ tag: 'LECTURA_CAIDA', intencion, usuarioId: usuario.id, spaceId: space.id, err: errMembers.message }, 'liquidar_espacio: no se pudo leer space_members');
            throw errMembers;
          }
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
          // El único de los catorce que falla ABIERTO: `members?.length || 0` le pasa 0 al límite,
          // así que un premium con los 6 miembros llenos igual se llevaba el link. (A un free lo
          // frena igual: `maxSpaceMembers` es 0 y `0 >= 0` bloquea con cualquier conteo.)
          const { data: members, error: errMembersInv } = await supabase.from('space_members').select('id').eq('space_id', space.id);
          if (errMembersInv) {
            log.warn({ tag: 'LECTURA_CAIDA', intencion, usuarioId: usuario.id, spaceId: space.id, err: errMembersInv.message }, 'invitar_espacio: no se pudo contar los miembros, el limite no se puede evaluar');
            throw errMembersInv;
          }
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

      // Editar el reparto NO se puede por WhatsApp, y hasta el 05-sep-2026 tampoco se
      // derivaba: los otros siete intents de este archivo no cubren "cambia mi reparto al
      // 30%", así que el mensaje caía al NLP y salía cualquier cosa. La matriz de canales
      // declaraba "❌ (redirige)" y el redirect no existía — el link a /dashboard/espacios
      // solo aparecía al unirse y al listar, o sea nunca en el momento en que se pide.
      //
      // Por qué es solo-app y no un hueco: el reparto son porcentajes por miembro y las
      // reglas por categoría son una matriz. Un menú numerado en dos mensajes es justo la
      // forma que se retiró de Gmail por guardar estado entre mensaje y mensaje.
      //
      // `/dashboard/espacios` NO está en `RUTAS_SIN_MURO` (a diferencia de configuración),
      // así que a quien está en el muro se le dice, en vez de mandarlo a una pared muda.
      case 'editar_split_espacio': {
        const { url, requiereActivacion } = enlaceApp(usuario, '/dashboard/espacios');
        const donde = requiereActivacion
          ? 'Activa tu cuenta acá y lo encuentras en *Espacios*:\n🔗 ' + url
          : 'Los porcentajes por persona y las reglas por categoría se editan acá:\n🔗 ' + url +
            '\n_Entra al espacio: los porcentajes están en *Miembros* y las reglas por categoría en *Reglas de División*._';
        // Los dos nombres salen de los <h2> de webapp/src/app/dashboard/espacios/[id]/page.tsx
        // (secciones C y D). La primera version decia 'busca *Reparto*' y esa palabra NO existe en
        // esa pantalla: habria sido la cuarta afirmacion falsa de la misma clase en esta sesion,
        // atrapada esta vez ANTES de shippear, abriendo el archivo en vez de confiando en el nombre.
        const base = '⚖️ *El reparto se ajusta en la app*\n\n' + donde +
          '\n\n_Por WhatsApp sigo registrando los gastos del espacio y dándote el balance._';
        return estaEnMuro(usuario)
          ? base + '\n\nOjo que esa pantalla es de *Neto Pro*, así que te va a pedir activarlo.'
          : base;
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

          await notificarNuevoMiembro(result.space.id, usuario.id);

          // El % que se anuncia sale del mismo motor que cobra. Antes decia
          // siempre "se dividiran equitativamente", que era falso en cuanto el
          // espacio tenia un reparto personalizado.
          const conNuevo = (result.miembrosPrevios || []).concat([
            { user_id: usuario.id, split_percentage: result.member.split_percentage },
          ]);
          const miParte = effectiveSplitPercents(conNuevo)[usuario.id] ?? 0;

          return '🎉 *¡Te uniste a ' + result.space.name + '!*\n\n' +
            'Por defecto te toca el ' + miParte + '% de cada gasto compartido.\n\n' +
            '_Pueden ajustar el reparto en https://app.neto.pe/dashboard/espacios_\n' +
            '_Escribe "ver balance espacio" para ver detalles._';
        } catch (e) {
          log.error({ tag: 'UNIRSE', err: e.message }, 'Error uniéndose');
          return 'No pude unirte al espacio. Intenta de nuevo.';
        }
      }

    }
  }
};
