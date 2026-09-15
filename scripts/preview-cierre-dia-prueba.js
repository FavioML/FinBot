#!/usr/bin/env node
/**
 * Dry-run del cierre del día de la prueba: quién lo recibiría esta noche y con qué texto,
 * SIN enviar nada ni escribir nada.
 *
 * Corre las funciones REALES del cron (`seleccionarCierreDiaPrueba` y `prepararCierreDiaPrueba`
 * de `cron/checks.js`), no una copia. Es la lección de `preview-survey-triggers.js`, que
 * reimplementaba su cron y terminó divergiendo en tres puntos: un preview que copia la lógica
 * muestra lo que el preview cree, no lo que el cron va a hacer.
 *
 * Lo único que NO es del cron es el gate horario (el preview corre a la hora que sea) y el envío.
 * El dedup sí se muestra: quien ya tiene su cierre de hoy sale marcado y no se contaría.
 *
 * Uso, contra producción (necesita las variables de Railway):
 *   railway run -- node scripts/preview-cierre-dia-prueba.js
 *
 * Correrlo el día del deploy a las ~20:50 Lima: "escribió hoy" se evalúa hasta el momento de la
 * corrida, así que alguien que escriba entre las 20:50 y las 21:00 no aparece acá y sí recibe.
 */

try { require('dotenv').config(); } catch (e) { /* con `railway run` las variables ya vienen */ }

const { supabase } = require('../lib/db');
const { hoyPeru } = require('../lib/dates');
const { TITULO_CIERRE } = require('../lib/cierre-dia-prueba');
const { seleccionarCierreDiaPrueba, prepararCierreDiaPrueba } = require('../cron/checks');

async function main() {
  const ahora = new Date();
  const hoy = hoyPeru();
  const inicioHoy = new Date(hoy + 'T00:00:00-05:00').toISOString();
  console.log('Cierre del día — dry-run · ' + ahora.toLocaleString('es-PE', { timeZone: 'America/Lima' }) + ' Lima');
  if (process.env.CIERRE_DIA_PRUEBA === 'off') console.log('⚠ CIERRE_DIA_PRUEBA=off: esta noche el cron NO manda nada.');

  const destinatarios = await seleccionarCierreDiaPrueba(ahora);
  if (destinatarios.length === 0) {
    console.log('\nNadie cumple los cinco filtros ahora mismo.');
    return 0;
  }

  let saldrian = 0;
  for (const { usuario, dia } of destinatarios) {
    const { data: yaCerro, error: errDedup } = await supabase.from('notificaciones')
      .select('id').eq('usuario_id', usuario.id).eq('titulo', TITULO_CIERRE).gte('fecha', inicioHoy).limit(1);
    const dedup = errDedup ? 'dedup ilegible → el cron NO mandaría' : (yaCerro && yaCerro.length ? 'ya tiene su cierre de hoy' : null);
    const cierre = await prepararCierreDiaPrueba(usuario, dia, hoy);
    const id = String(usuario.id).slice(0, 8);
    const canal = usuario.whatsapp ? 'número' : 'BSUID';
    const web = usuario.supabase_auth_id ? 'con web' : 'sin web';
    console.log('\n──── ' + id + ' · día ' + dia + ' · ' + canal + ' · ' + web);
    if (dedup) { console.log('  (no sale: ' + dedup + ')'); continue; }
    if (!cierre) { console.log('  (no sale: escribió hoy pero no tiene gastos con fecha de hoy)'); continue; }
    saldrian++;
    // El link de activación es un token firmado: se recorta para que el preview no deje uno
    // usable en la terminal ni en un log.
    console.log(cierre.mensaje.replace(/\/activar\?t=\S+/g, '/activar?t=…').split('\n').map((l) => '  ' + l).join('\n'));
  }
  console.log('\n' + saldrian + ' de ' + destinatarios.length + ' candidatos recibirían el cierre si fuera ahora.');
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('El dry-run falló:', e && e.message ? e.message : e);
  process.exit(2);
});
