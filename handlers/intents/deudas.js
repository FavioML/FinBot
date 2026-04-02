const log = require('../../lib/logger');

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
          let montoClasif = parseFloat(datos.monto);
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
          if (mMes) { const n = numPalabras[mMes[1].toLowerCase()] || parseInt(mMes[1]); if (n > 0) { const d = new Date(); d.setMonth(d.getMonth() + n); fechaVenc = d.toISOString().split('T')[0]; } }

          // Detectar multi-moneda: "100 soles y 10 dólares"
          const montos = [];
          const reMontos = /(\d+(?:[.,]\d+)?)\s*(?:soles?|pen|s\/)/gi;
          const reMontosUsd = /(\d+(?:[.,]\d+)?)\s*(?:d[oó]lares?|usd|\$)|(?:\$)\s*(\d+(?:[.,]\d+)?)/gi;
          let mPen;
          while ((mPen = reMontos.exec(msg)) !== null) {
            montos.push({ monto: parseFloat(mPen[1].replace(',', '.')), moneda: 'PEN' });
          }
          let mUsd;
          while ((mUsd = reMontosUsd.exec(msg)) !== null) {
            montos.push({ monto: parseFloat((mUsd[1] || mUsd[2]).replace(',', '.')), moneda: 'USD' });
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
          if ((!montoClasif || isNaN(montoClasif)) && montos.length === 1) {
            montoClasif = montos[0].monto;
            monedaClasif = montos[0].moneda;
          }

          if (!contraparte || !montoClasif || montoClasif <= 0 || isNaN(montoClasif)) {
            return 'Mmm, no pillé bien los datos. Dime algo como:\n_"debo S/200 a Juan"_\n_"Pedro me debe S/150 por la cena"_';
          }
          // Corrección automática: si existe deuda reciente con mismo monto/contraparte pero tipo opuesto, eliminarla
          const tipoOpuesto = tipo === 'debo' ? 'me_deben' : 'debo';
          const { data: duplicadaOpuesta } = await supabase
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
          if (duplicadaOpuesta && duplicadaOpuesta.length > 0) {
            await supabase.from('deudas').delete().eq('id', duplicadaOpuesta[0].id);
          }
          await registrarDeuda(usuario.id, tipo, contraparte, montoClasif, monedaClasif, descripcion, fechaVenc);
          const sym = monedaClasif === 'USD' ? '$' : 'S/';
          if (tipo === 'debo') {
            return 'Anotado. Le debes *' + sym + ' ' + montoClasif.toFixed(2) + '* a *' + contraparte + '*.' + (descripcion ? ' (' + descripcion + ')' : '') + fmtVenc + '\n\n_Escribe "mis deudas" para ver el resumen._';
          } else {
            return 'Anotado. *' + contraparte + '* te debe *' + sym + ' ' + montoClasif.toFixed(2) + '*.' + (descripcion ? ' (' + descripcion + ')' : '') + fmtVenc + '\n\n_Escribe "mis deudas" para ver el resumen._';
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
          let montoAbono = parseFloat(datos.monto);

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
          if ((!montoAbono || isNaN(montoAbono)) && contraparte) {
            const { data: deudasCalc } = await supabase.from('deudas')
              .select('monto_pendiente')
              .eq('usuario_id', usuario.id).eq('estado', 'activa')
              .ilike('contraparte', '%' + contraparte.trim() + '%')
              .order('created_at', { ascending: false }).limit(1);
            if (deudasCalc && deudasCalc.length > 0) {
              const pendiente = parseFloat(deudasCalc[0].monto_pendiente);
              if (/\b(la mitad|medio)\b/i.test(msg)) montoAbono = pendiente * 0.5;
              else if (/\b(un tercio|la tercera parte)\b/i.test(msg)) montoAbono = pendiente / 3;
              else if (/\b(un cuarto|la cuarta parte)\b/i.test(msg)) montoAbono = pendiente * 0.25;
              else {
                const pctMatch = msg.match(/(\d+)\s*%/);
                if (pctMatch) montoAbono = pendiente * (parseInt(pctMatch[1]) / 100);
              }
              if (montoAbono) montoAbono = Math.round(montoAbono * 100) / 100;
            }
          }

          // Fallback: extraer monto del mensaje si el clasificador no lo capturó
          if ((!montoAbono || isNaN(montoAbono))) {
            const mMontoFb = msg.match(/(\d+(?:[.,]\d+)?)/);
            if (mMontoFb) montoAbono = parseFloat(mMontoFb[1].replace(',', '.'));
          }

          if (!contraparte || !montoAbono || montoAbono <= 0 || isNaN(montoAbono)) {
            return '¿A quién y cuánto? Dime algo como:\n_"le pagué 100 a Juan"_\n_"Annie me dio la mitad"_\n_"mi tía Jenny me pagó 500"_';
          }
          const resultado = await abonarDeuda(usuario.id, contraparte, montoAbono);
          if (!resultado) {
            return 'No encontré deuda activa con *' + contraparte + '*. Revisa con _"mis deudas"_ a ver si el nombre está bien.';
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
          const montoTotal = parseFloat(mSplit[1].replace(',', '.'));
          const numPersonas = parseInt(mSplit[2]);
          if (isNaN(montoTotal) || montoTotal <= 0 || numPersonas < 2) return 'Necesito un monto válido y al menos 2 personas.';
          const perPerson = Math.round((montoTotal / numPersonas) * 100) / 100;
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
          await supabase.from('gasto_participantes').insert(participantes);
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
