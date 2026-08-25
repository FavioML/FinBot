const log = require('../../lib/logger');
const { sumarMeses } = require('../../lib/dates');
// Fuente única de validación de montos. Acá se usaba `parseFloat` + `> 0` + `isNaN`,
// que es el gemelo exacto de B18 (cerrado para transacciones, no para deudas):
// `isNaN(Infinity)` es false y no había techo, así que un "debo 1e999 a Juan" entraba
// y PostgREST lo serializaba a `null`. Lo delató `tests/plata-validada.test.js`.
const { validarMonto } = require('../../lib/validators');
const { verificarEscritura, entro } = require('../../helpers/escritura-verificada');

/**
 * Las cuatro formas de pedir una PARTE de lo que se debe ("la mitad", "un tercio", "40%").
 *
 * Están acá arriba y no en línea porque `abonar_deuda` las necesita en DOS lugares: para
 * elegir la fracción, y para decidir si la lectura del pendiente era imprescindible. Escritas
 * dos veces divergen solas, y la divergencia acá se paga en plata: la guarda dejaría pasar
 * una fracción que la rama sí sabe resolver.
 */
const RE_MITAD = /\b(la mitad|medio)\b/i;
const RE_TERCIO = /\b(un tercio|la tercera parte)\b/i;
const RE_CUARTO = /\b(un cuarto|la cuarta parte)\b/i;
const RE_PORCENTAJE = /(\d+)\s*%/;
const pideFraccion = (m) => RE_MITAD.test(m) || RE_TERCIO.test(m) || RE_CUARTO.test(m) || RE_PORCENTAJE.test(m);

module.exports = {
  intents: ['registrar_deuda', 'ver_deudas', 'abonar_deuda', 'marcar_deuda_pagada', 'consolidar_deudas', 'saldar_todo_contraparte', 'dividir_gasto_grupal'],
  async handle({ intencion, msg, datos, usuario, from, ctx }) {
    const {
      supabase, hoyPeru,
      registrarDeuda, formatearResumenDeudas, abonarDeuda,
      marcarDeudaPagada, consolidarDeudasPorContraparte, saldarTodasDeudas
    } = ctx;

    switch (intencion) {

      case 'registrar_deuda': {
        try {
          const tipo = datos.tipo || (/\bme debe\b|le prest[eé]/i.test(msg) ? 'me_deben' : 'debo');
          let contraparte = datos.contraparte;
          let montoClasif = validarMonto(datos.monto);
          let monedaClasif = datos.moneda || 'PEN';
          const descripcion = datos.descripcion || null;

          // Fallback: extraer contraparte del mensaje si el clasificador no la encontró
          if (!contraparte) {
            const mNombre = msg.match(/(?:^|\b)([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)\s+me\s+debe/i)
              || msg.match(/(?:debo|le debo|prest[eé])\s+.*?\s+a\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)/i);
            if (mNombre) contraparte = mNombre[1].trim();
          }

          // Extraer fecha_vencimiento del mensaje
          let fechaVenc = null;
          const numPalabras = { 'un':1, 'uno':1, 'dos':2, 'tres':3, 'cuatro':4, 'cinco':5, 'seis':6, 'siete':7, 'ocho':8, 'nueve':9, 'diez':10 };
          const mDias = msg.match(/(?:en|dentro de)\s+(\d+|un[oa]?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+d[ií]as?/i);
          if (mDias) { const n = numPalabras[mDias[1].toLowerCase()] || parseInt(mDias[1]); if (n > 0) { const d = new Date(); d.setDate(d.getDate() + n); fechaVenc = d.toISOString().split('T')[0]; } }
          if (!fechaVenc && /\bma[nñ]ana\b/i.test(msg)) { const d = new Date(); d.setDate(d.getDate() + 1); fechaVenc = d.toISOString().split('T')[0]; }
          if (!fechaVenc && /\bpasado\s+ma[nñ]ana\b/i.test(msg)) { const d = new Date(); d.setDate(d.getDate() + 2); fechaVenc = d.toISOString().split('T')[0]; }
          const mSem = !fechaVenc && msg.match(/(?:en|dentro de)\s+(\d+|una?|dos|tres|cuatro)\s+semanas?/i);
          if (mSem) { const n = numPalabras[mSem[1].toLowerCase()] || parseInt(mSem[1]); if (n > 0) { const d = new Date(); d.setDate(d.getDate() + n * 7); fechaVenc = d.toISOString().split('T')[0]; } }
          const mMes = !fechaVenc && msg.match(/(?:en|dentro de)\s+(\d+|un[oa]?|dos|tres)\s+mes(?:es)?/i);
          // `setMonth` desbordaba: "en 1 mes" un 31 de enero daba 3-mar, no 28-feb.
          if (mMes) { const n = numPalabras[mMes[1].toLowerCase()] || parseInt(mMes[1]); if (n > 0) { fechaVenc = sumarMeses(hoyPeru(), n); } }

          // Detectar multi-moneda: "100 soles y 10 dólares"
          const montos = [];
          let hayMontoInvalido = false;
          // El `(?![a-záéíóúñ])` NO es cosmético: sin él, `pen` matchea dentro de
          // "pendientes", así que "le debo 100 soles, me quedan 0 pendientes" leía un
          // segundo monto de 0 PEN. Con el rechazo explícito de abajo eso perdía el
          // mensaje ENTERO (la deuda válida de S/100 incluida); antes registraba dos
          // deudas. Mismo caso con "debo 50 soles por 2 pensiones".
          const reMontos = /(\d+(?:[.,]\d+)?)\s*(?:soles?|pen|s\/)(?![a-záéíóúñ])/gi;
          const reMontosUsd = /(\d+(?:[.,]\d+)?)\s*(?:d[oó]lares?|usd|\$)(?![a-záéíóúñ])|(?:\$)\s*(\d+(?:[.,]\d+)?)/gi;
          let mPen;
          while ((mPen = reMontos.exec(msg)) !== null) {
            // Un monto inválido en la lista NO se descarta en silencio: se marca. Con
            // el `if (v !== null) push` a secas, "te debo 100 soles y 1500000 soles"
            // registraba solo la primera y respondía "Anotado" sin mencionar la otra —
            // pérdida parcial silenciosa, peor que las dos alternativas.
            const vPen = validarMonto(mPen[1].replace(',', '.'));
            if (vPen === null) hayMontoInvalido = true;
            else montos.push({ monto: vPen, moneda: 'PEN' });
          }
          let mUsd;
          while ((mUsd = reMontosUsd.exec(msg)) !== null) {
            const vUsd = validarMonto((mUsd[1] || mUsd[2]).replace(',', '.'));
            if (vUsd === null) hayMontoInvalido = true;
            else montos.push({ monto: vUsd, moneda: 'USD' });
          }

          // Si alguno de los montos del mensaje no era válido, no se registra "lo que
          // se pudo": el usuario nombró N deudas y anotar N-1 diciendo "Listo" es
          // pérdida silenciosa. Se le pide que lo repita bien.
          if (hayMontoInvalido) {
            return 'Uno de esos montos no me cuadra. Repítemelo así:\n_"debo S/200 a Juan"_\n_"le debo 100 soles y 50 dólares a Ana"_';
          }

          // Helper para mostrar fecha de vencimiento en la respuesta
          const fmtVenc = fechaVenc ? '\n📅 Vence: ' + new Date(fechaVenc + 'T12:00:00').toLocaleDateString('es-PE', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

          // Si encontramos múltiples montos, registrar cada uno
          if (montos.length >= 2 && contraparte) {
            const registros = [];
            for (const m of montos) {
              await registrarDeuda(usuario.id, tipo, contraparte, m.monto, m.moneda, descripcion, fechaVenc);
              const sym = m.moneda === 'USD' ? '$' : 'S/';
              registros.push(sym + ' ' + m.monto.toFixed(2));
            }
            if (tipo === 'debo') {
              return 'Listo, anoté que le debes a *' + contraparte + '*: ' + registros.join(' + ') + '.' + fmtVenc + '\n\n_Escribe "mis deudas" para ver todo._';
            } else {
              return 'Listo, anoté que *' + contraparte + '* te debe: ' + registros.join(' + ') + '.' + fmtVenc + '\n\n_Escribe "mis deudas" para ver todo._';
            }
          }

          // Caso normal: un solo monto
          // Si no teníamos monto del clasificador pero sí detectamos uno con regex
          if (montoClasif === null && montos.length === 1) {
            montoClasif = montos[0].monto;
            monedaClasif = montos[0].moneda;
          }

          // `validarMonto` ya devolvió null para NaN, Infinity, <= 0 y > 999999.99: acá
          // solo queda preguntar si hubo monto, no repetir los checks a mano.
          if (!contraparte || montoClasif === null) {
            return 'Mmm, no pillé bien los datos. Dime algo como:\n_"debo S/200 a Juan"_\n_"Pedro me debe S/150 por la cena"_';
          }
          if (contraparte.length > 100) contraparte = contraparte.substring(0, 100);
          // Corrección automática: si existe deuda reciente con mismo monto/contraparte pero tipo opuesto, eliminarla
          const tipoOpuesto = tipo === 'debo' ? 'me_deben' : 'debo';
          const { data: duplicadaOpuesta, error: errDupOpuesta } = await supabase
            .from('deudas')
            .select('id')
            .eq('usuario_id', usuario.id)
            .eq('estado', 'activa')
            .eq('monto_original', montoClasif)
            .eq('tipo', tipoOpuesto)
            .ilike('contraparte', '%' + contraparte.trim() + '%')
            .gte('created_at', new Date(Date.now() - 5 * 60 * 1000).toISOString()) // últimos 5 min
            .order('created_at', { ascending: false })
            .limit(1);
          // La corrección automática es lo ÚNICO accesorio de este case, y por eso no corta:
          // abortar acá perdería la deuda que la persona acaba de dictar, que es lo que vino a
          // hacer. Dos decisiones, y las dos son de este sitio y no de la clase:
          //
          //   · **cero filas es el objetivo cumplido**, no una anomalía. Este DELETE apunta a
          //     una fila que se leyó un instante antes y no lleva ninguna condición que otro
          //     pueda invalidar: si ya no está, el estado deseado —que no exista— se cumplió.
          //     Un `warn` ahí sería una falsa alarma, y un log que grita sin motivo se deja de
          //     leer. Por eso `ceroFilas: 'esperado'`.
          //   · **el error SÍ se le dice**, aunque la deuda entre igual. El desenlace no es
          //     invisible: quedan las dos anotaciones opuestas vivas ("le debes S/200 a Juan" y
          //     "Juan te debe S/200"), y la persona las va a encontrar en "mis deudas" sin
          //     ninguna pista de por qué están las dos.
          //
          // **El aviso cubre los DOS caminos al mismo desenlace, y ese es el arreglo de 9B-quater.**
          // Antes cubría sólo el DELETE que falla: con la LECTURA caída, `duplicadaOpuesta` quedaba
          // `undefined`, el DELETE ni se intentaba, y las dos anotaciones opuestas sobrevivían
          // igual — sin aviso. O sea que el aviso veía la mitad de su propia clase.
          //
          // **El texto de los dos NO es el mismo, y no es cosmética.** Cuando el DELETE falla,
          // sabemos que la opuesta está: se afirma. Cuando falla la LECTURA no sabemos si existe
          // —lo más probable es que no—, así que afirmarlo sería el mismo pecado en el otro
          // sentido: decirle algo que no medimos. Se dice lo que pasó, que es que no se pudo mirar.
          //
          // **Alcance: la rama de UN monto.** El camino multi-moneda ("100 soles y 50 dólares")
          // retorna más arriba y no pasa por acá, así que nunca tuvo corrección de la opuesta ni
          // aviso — es anterior a 9B-quater y está anotado en docs/DEFECTOS.md, no arreglado acá.
          let avisoOpuesta = '';
          if (errDupOpuesta) {
            log.warn({ tag: 'LECTURA_CAIDA', intencion, usuarioId: usuario.id, err: errDupOpuesta.message }, 'registrar_deuda: no se pudo revisar la anotacion opuesta reciente');
            avisoOpuesta = '\n\n⚠️ No pude revisar si te quedó la anotación opuesta de hace un rato. Si la ves repetida, bórrala desde _"mis deudas"_.';
          } else if (duplicadaOpuesta && duplicadaOpuesta.length > 0) {
            const vDup = await verificarEscritura(
              supabase.from('deudas').delete().eq('id', duplicadaOpuesta[0].id).select('id'),
              { sitio: 'registrar_deuda_corrige_opuesta', userId: usuario.id, campos: ['id'], ceroFilas: 'esperado' });
            if (!entro(vDup)) {
              avisoOpuesta = '\n\n⚠️ Ojo: te quedó también la anotación opuesta de hace un rato. Revísala con _"mis deudas"_.';
            }
          }
          await registrarDeuda(usuario.id, tipo, contraparte, montoClasif, monedaClasif, descripcion, fechaVenc);
          const sym = monedaClasif === 'USD' ? '$' : 'S/';
          if (tipo === 'debo') {
            return 'Anotado. Le debes *' + sym + ' ' + montoClasif.toFixed(2) + '* a *' + contraparte + '*.' + (descripcion ? ' (' + descripcion + ')' : '') + fmtVenc + avisoOpuesta + '\n\n_Escribe "mis deudas" para ver el resumen._';
          } else {
            return 'Anotado. *' + contraparte + '* te debe *' + sym + ' ' + montoClasif.toFixed(2) + '*.' + (descripcion ? ' (' + descripcion + ')' : '') + fmtVenc + avisoOpuesta + '\n\n_Escribe "mis deudas" para ver el resumen._';
          }
        } catch(e) {
          log.error({ tag: 'DEUDA_REGISTRAR', err: e.message }, 'Error al registrar deuda');
          return 'Ups, algo falló al registrar la deuda. Inténtalo de nuevo.';
        }
      }

      case 'ver_deudas': {
        try {
          return await formatearResumenDeudas(usuario.id);
        } catch(e) {
          log.error({ tag: 'DEUDA_VER', err: e.message }, 'Error al obtener deudas');
          return 'No pude obtener tus deudas. Intenta de nuevo.';
        }
      }

      case 'abonar_deuda': {
        try {
          let contraparte = datos.contraparte;
          let montoAbono = validarMonto(datos.monto);

          // Fallback: extraer contraparte de frases como "Annie me dio 50", "mi tía Jenny me pagó"
          if (!contraparte) {
            const mNombreAbono = msg.match(/\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)\s+me\s+(?:ha\s+)?(?:dio|pag[oó]|transfiri[oó]|deposit[oó]|pas[oó]|abono)/i)
              || msg.match(/(?:mi\s+)?(?:t[ií](?:a|o)|amig[oa]|hermano|hermana|primo|prima|pap[aá]|mam[aá]|jefe|compa(?:ñero)?)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)\s+me\s+(?:ha\s+)?pag/i)
              || msg.match(/(?:pagu[eé]|abon[eé]|di|pag[oó])\s+.*?\s+a\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)/i);
            if (mNombreAbono) contraparte = (mNombreAbono[1] || '').trim();
          }
          // Fallback 2: buscar "Tía Jenny", "Tío Pedro" como contraparte compuesta
          if (!contraparte) {
            const mTituloNombre = msg.match(/(?:mi\s+)?(?:t[ií](?:a|o)|amig[oa]|hermano|hermana|primo|prima)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i);
            if (mTituloNombre) contraparte = msg.match(/(?:t[ií](?:a|o))\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i)?.[0] || mTituloNombre[1];
          }

          // Soporte fracciones: "la mitad", "un tercio", "X%"
          let pendienteNoLeido = false;
          if (montoAbono === null && contraparte) {
            const { data: deudasCalc, error: errDeudasCalc } = await supabase.from('deudas')
              .select('monto_pendiente')
              .eq('usuario_id', usuario.id).eq('estado', 'activa')
              .ilike('contraparte', '%' + contraparte.trim() + '%')
              .order('created_at', { ascending: false }).limit(1);
            if (errDeudasCalc) {
              log.warn({ tag: 'LECTURA_CAIDA', intencion, usuarioId: usuario.id, err: errDeudasCalc.message }, 'abonar_deuda: no se pudo leer el pendiente para resolver la fraccion');
              pendienteNoLeido = true;
            } else if (deudasCalc && deudasCalc.length > 0) {
              const pendiente = parseFloat(deudasCalc[0].monto_pendiente);
              if (RE_MITAD.test(msg)) montoAbono = pendiente * 0.5;
              else if (RE_TERCIO.test(msg)) montoAbono = pendiente / 3;
              else if (RE_CUARTO.test(msg)) montoAbono = pendiente * 0.25;
              else {
                const pctMatch = msg.match(RE_PORCENTAJE);
                if (pctMatch) montoAbono = pendiente * (parseInt(pctMatch[1]) / 100);
              }
              // La fracción sale de una división: si `monto_pendiente` viniera
              // corrupto, esto propaga NaN. `validarMonto` redondea a 2 decimales
              // igual que el `Math.round(x*100)/100` que había acá.
              montoAbono = validarMonto(montoAbono);
            }
          }

          // **La única de las catorce donde la respuesta equivocada REGISTRA un monto, y por eso
          // corta acá — ANTES del fallback numérico de abajo.** "Annie me dio 50%" sin el
          // pendiente caía en ese fallback, que agarra el primer número del mensaje: abonaba
          // S/ 50 en vez del 50% del saldo. Y "le pagué la mitad" sin números terminaba en el
          // "¿A quién y cuánto?", que le echa la culpa a cómo escribió cuando el problema fue
          // nuestro.
          //
          // **La condición mira el DESENLACE, no la causa, y esa fue la corrección de la revisión
          // adversarial.** La primera versión cortaba por `pendienteNoLeido`, o sea sólo cuando
          // la lectura se caía. Las otras dos causas producen el mismo daño y quedaban afuera:
          // que no haya deuda activa con esa persona, y que la fila tenga `monto_pendiente` en
          // null o 0 (la columna es nullable a propósito, migración 068) — ahí la fracción sale
          // NaN, `validarMonto` la anula, y "le pagué la mitad de los 300 a Juan" abonaba 300.
          //
          // Corta SÓLO si el mensaje pedía una parte Y hay a quién. Sin fracción, esa consulta no
          // decidía nada —el monto sale del clasificador o del texto— y frenar por una lectura
          // que no se iba a usar es apagar de más: queda el log y sigue de largo.
          if (contraparte && pideFraccion(msg) && montoAbono === null) {
            return pendienteNoLeido
              ? 'No pude consultar cuánto le debes para sacar esa parte. Inténtalo de nuevo en unos segundos.'
              : 'No pude sacar esa parte: no encontré una deuda activa con saldo pendiente con *' + contraparte + '*.\n\n_Revisa con "mis deudas"._';
          }

          // Fallback: extraer monto del mensaje si el clasificador no lo capturó
          if (montoAbono === null) {
            const mMontoFb = msg.match(/(\d+(?:[.,]\d+)?)/);
            if (mMontoFb) montoAbono = validarMonto(mMontoFb[1].replace(',', '.'));
          }
          if (!contraparte || montoAbono === null) {
            return '¿A quién y cuánto? Dime algo como:\n_"le pagué 100 a Juan"_\n_"Annie me dio la mitad"_\n_"mi tía Jenny me pagó 500"_';
          }
          const resultado = await abonarDeuda(usuario.id, contraparte, montoAbono);
          if (!resultado) {
            return 'No encontré deuda activa con *' + contraparte + '*. Revisa con _"mis deudas"_ a ver si el nombre está bien.';
          }
          if (resultado.error === 'overpayment') {
            const symOver = resultado.moneda === 'USD' ? '$' : 'S/';
            return '⚠️ El abono de ' + symOver + ' ' + montoAbono.toFixed(2) + ' excede lo pendiente (' + symOver + ' ' + resultado.monto_pendiente.toFixed(2) + ').\n\nSi quieres liquidarla, escribe _"pagué todo a ' + contraparte + '"_.';
          }
          const { deuda, completada } = resultado;
          const sym = deuda.moneda === 'USD' ? '$' : 'S/';
          if (completada) {
            return 'Listo, la deuda con *' + deuda.contraparte + '* quedó saldada. 🎉';
          }
          const pct = Math.round(((parseFloat(deuda.monto_original) - parseFloat(deuda.monto_pendiente)) / parseFloat(deuda.monto_original)) * 100);
          return 'Abono anotado con *' + deuda.contraparte + '*.\nLlevas ' + sym + ' ' + (parseFloat(deuda.monto_original) - parseFloat(deuda.monto_pendiente)).toFixed(2) + ' pagado (' + pct + '%), te falta *' + sym + ' ' + parseFloat(deuda.monto_pendiente).toFixed(2) + '*.';
        } catch(e) {
          log.error({ tag: 'DEUDA_ABONAR', err: e.message }, 'Error al abonar deuda');
          return 'Algo falló al registrar el abono. Inténtalo de nuevo.';
        }
      }

      case 'marcar_deuda_pagada': {
        try {
          const contraparte = datos.contraparte;
          if (!contraparte) {
            return '¿Con quién quedó saldada? Dime algo como:\n_"ya le pagué a Juan"_ o _"Renzo ya me pagó"_';
          }
          const deuda = await marcarDeudaPagada(usuario.id, contraparte);
          if (!deuda) {
            return 'No encontré deuda activa con *' + contraparte + '*. Revisa con _"mis deudas"_.';
          }
          return 'Listo, la deuda con *' + deuda.contraparte + '* (' + (deuda.moneda === 'USD' ? '$' : 'S/') + ' ' + parseFloat(deuda.monto_original).toFixed(2) + ') quedó saldada. 🎉';
        } catch(e) {
          log.error({ tag: 'DEUDA_PAGAR', err: e.message }, 'Error al marcar deuda pagada');
          return 'No pude marcar la deuda como pagada. Intenta de nuevo.';
        }
      }

      case 'consolidar_deudas': {
        try {
          const cpCons = datos.contraparte;
          if (!cpCons) return '¿De quién quieres ver el total? Ej: _"cuánto le debo a Juan en total"_';
          const resCons = await consolidarDeudasPorContraparte(usuario.id, cpCons);
          if (!resCons) return 'No encontré deudas activas con *' + cpCons + '*.';
          let msgCons = '📊 *Resumen con ' + resCons.contraparte + '* (' + resCons.deudas.length + ' deuda' + (resCons.deudas.length > 1 ? 's' : '') + ')\n\n';
          if (resCons.debo.PEN > 0 || resCons.debo.USD > 0) {
            msgCons += '📤 *Le debes:*';
            if (resCons.debo.PEN > 0) msgCons += ' S/ ' + resCons.debo.PEN.toFixed(2);
            if (resCons.debo.USD > 0) msgCons += (resCons.debo.PEN > 0 ? ' +' : '') + ' $ ' + resCons.debo.USD.toFixed(2);
            msgCons += '\n';
          }
          if (resCons.meDeben.PEN > 0 || resCons.meDeben.USD > 0) {
            msgCons += '📥 *Te debe:*';
            if (resCons.meDeben.PEN > 0) msgCons += ' S/ ' + resCons.meDeben.PEN.toFixed(2);
            if (resCons.meDeben.USD > 0) msgCons += (resCons.meDeben.PEN > 0 ? ' +' : '') + ' $ ' + resCons.meDeben.USD.toFixed(2);
            msgCons += '\n';
          }
          msgCons += '\n_Escribe "salda todo con ' + resCons.contraparte + '" para cerrar todas._';
          return msgCons;
        } catch(e) {
          log.error({ tag: 'CONSOLIDAR', err: e.message }, 'Error consolidar deudas');
          return 'No pude consultar el total. Intenta de nuevo.';
        }
      }

      case 'saldar_todo_contraparte': {
        try {
          let cpSaldar = datos.contraparte;
          if (!cpSaldar) {
            const mCp = msg.match(/(?:salda|liquida|arregla|cancela)\s+todo\s+(?:con|de)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i);
            if (mCp) cpSaldar = mCp[1].trim();
          }
          if (!cpSaldar) return '¿Con quién quedó todo saldado? Ej: _"salda todo con Juan"_';
          const count = await saldarTodasDeudas(usuario.id, cpSaldar);
          if (!count) return 'No encontré deudas activas con *' + cpSaldar + '*.';
          return '✅ Listo, ' + count + ' deuda' + (count > 1 ? 's' : '') + ' con *' + cpSaldar + '* quedaron saldadas. 🎉';
        } catch(e) {
          log.error({ tag: 'SALDAR_TODO', err: e.message }, 'Error saldar todo');
          return 'No pude saldar las deudas. Intenta de nuevo.';
        }
      }

      case 'dividir_gasto_grupal': {
        try {
          // Support both "entre N" and "con N amigos/personas"
          const mSplit = msg.match(/(\d+[\d,.]*)\b.+?\bentre\s+(\d+)/i) ||
                         msg.match(/(\d+[\d,.]*)\b.+?\bcon\s+(\d+)\s+(?:amigos?|personas?)/i);
          if (!mSplit) return '¿Cuánto pagaste y entre cuántos? Ej: _"pagué 300 la cena entre 4"_';
          const montoTotal = validarMonto(mSplit[1].replace(',', '.'));
          const numPersonas = parseInt(mSplit[2]);
          if (montoTotal === null || numPersonas < 2) return 'Necesito un monto válido y al menos 2 personas.';
          // La parte de cada uno también se escribe (`gasto_participantes.monto_debe`),
          // así que también se valida: con un total muy chico entre muchas personas el
          // redondeo da 0, y un participante que debe S/0 no es una deuda.
          const perPerson = validarMonto(Math.round((montoTotal / numPersonas) * 100) / 100);
          if (perPerson === null) return 'Ese monto entre ' + numPersonas + ' personas no da una parte que pueda anotar. Prueba con un total mayor.';
          // Extract description - skip bare currency words
          const mDesc = msg.match(/(?:pagu[eé]|divid[eiír]|split)\s+\d+[\d,.]*\s+(?:soles?\s+|d[oó]lares?\s+|USD\s+)?(?:(?:con|de|la|el|por|en\s+una?)\s+)?(.+?)(?:\s+(?:entre|con)\s+\d+)/i);
          let descripcion = mDesc ? mDesc[1].trim() : '';
          descripcion = descripcion.replace(/^(?:soles?|d[oó]lares?|USD|PEN)\s*/i, '').replace(/\s+(?:con|entre)\s+\d+.*$/i, '').trim();
          if (!descripcion || /^(?:amigos?|personas?|gente)$/i.test(descripcion)) descripcion = 'Gasto compartido';
          // Extract participant names: "con Annie, Diego y Cesar"
          const nombresExtraidos = [];
          const mNombres = msg.match(/\b(?:con|entre)\s+([A-Za-záéíóúÁÉÍÓÚüÜñÑ][\wáéíóúüñÁÉÍÓÚÜÑ ,]+?)(?:\s+(?:en|por|para|entre|\d)|$)/i);
          if (mNombres) {
            const partes = mNombres[1].split(/,\s*|\s+y\s+/i)
              .map(n => n.trim())
              .filter(n => n.length > 1 && !/^(\d+|amigos?|personas?|gente|mis|los|sus|unos?|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)$/i.test(n));
            nombresExtraidos.push(...partes);
          }
          // Create the shared expense
          const { data: gastoComp, error: gcErr } = await supabase
            .from('gastos_compartidos')
            .insert({ creador_id: usuario.id, descripcion, monto_total: montoTotal, moneda: 'PEN', fecha: hoyPeru() })
            .select().single();
          if (gcErr) throw gcErr;
          // Create participants - use extracted names when available
          const participantes = [];
          for (let i = 0; i < numPersonas - 1; i++) {
            participantes.push({ gasto_id: gastoComp.id, nombre: nombresExtraidos[i] || ('Persona ' + (i + 1)), monto_debe: perPerson, pagado: false });
          }
          // **El peor de los quince, y el único que es plata de TERCEROS.** El padre
          // (`gastos_compartidos`) ya entró; los participantes son el reparto. Si este insert
          // no entra y se confirma igual, la persona lee *"Cada uno: S/ 75"* sobre un reparto
          // que no existe. Es la misma clase que los splits de Espacios y por eso no se
          // resuelve sólo con leer el error.
          //
          // **Dónde duele el huérfano, medido** (acá decía "indistinguible de uno saldado" a
          // secas y apuntaba al lugar equivocado; lo corrigió una revisión adversarial): en las
          // tarjetas de la webapp se ve "0/0 pagados" con el total entero, feo pero no
          // liquidado. Donde SÍ colapsa es en la API — el `PUT` de `webapp/src/app/api/split/`
          // decide con `(allParts || []).every(p => p.pagado)`, y `[].every()` es `true`, así
          // que un padre sin participantes se marca `estado: 'liquidado'`.
          //
          // **Se COMPENSA**, igual que `descartarSnapshot` en 9A. Sin borrar el padre, el
          // reintento —que es exactamente lo que la persona va a hacer después de leer "no
          // pude"— crea un SEGUNDO gasto compartido, y ahí el arreglo del mensaje habría
          // fabricado un duplicado. El caso en que la limpieza tampoco entra tiene su propio
          // copy: es el único donde queda algo a medias y hay que decir dónde mirarlo.
          //
          // (El `try/catch` de este case es código muerto para supabase-js, que no lanza: por
          // eso `gcErr` de arriba tiene su `throw` explícito y esto no puede apoyarse en él.)
          const vPart = await verificarEscritura(
            supabase.from('gasto_participantes').insert(participantes).select('id'),
            { sitio: 'dividir_gasto_grupal', userId: usuario.id, campos: ['gasto_id', 'monto_debe'] });
          if (!entro(vPart)) {
            // El `.eq('creador_id', …)` es redundante HOY —`gastoComp.id` es un uuid que nació
            // tres líneas arriba en esta misma request— y va igual: este cliente es service
            // role, así que sin él lo único que separa este DELETE de borrar el gasto
            // compartido de cualquiera es la procedencia de una variable. Con el filtro es un
            // invariante; sin él, una propiedad del flujo que el próximo refactor puede perder.
            const vLimpieza = await verificarEscritura(
              supabase.from('gastos_compartidos').delete().eq('id', gastoComp.id).eq('creador_id', usuario.id).select('id'),
              { sitio: 'dividir_gasto_grupal_limpieza', userId: usuario.id, campos: ['id'] });
            return entro(vLimpieza)
              ? 'No pude anotar el reparto, así que no dejé el gasto compartido a medias. Vuelve a dictármelo: _"pagué 300 la cena entre 4"_.'
              : '⚠️ No pude anotar el reparto y el gasto compartido me quedó a medias, sin las partes de cada uno.\n\nRevísalo en app.neto.pe > Deudas > Compartidos antes de volver a dictármelo, para no anotarlo dos veces.';
          }
          const nombresStr = participantes.map(p => p.nombre).join(', ');
          return '✅ *Gasto compartido creado*\n\n📝 ' + descripcion + '\n💰 Total: S/ ' + montoTotal.toFixed(2) + '\n👥 ' + numPersonas + ' personas (' + nombresStr + ')\n💳 Cada uno: *S/ ' + perPerson.toFixed(2) + '*\n\n_Ve a app.neto.pe > Deudas > Compartidos para editar y marcar pagos._';
        } catch(e) {
          log.error({ tag: 'DIVIDIR_GASTO', err: e.message }, 'Error dividir gasto');
          return 'No pude crear el gasto compartido. Intenta de nuevo.';
        }
      }
    }
  }
};
