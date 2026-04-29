/**
 * Dry-run del cron checkRecordatoriosCostos.
 *
 * Lee admin_costs y muestra qué WhatsApp se enviaría HOY al admin,
 * sin disparar el envío real ni tocar last_reminder_sent_at.
 *
 * Uso:
 *   node scripts/preview-recordatorios-costos.js
 *   node scripts/preview-recordatorios-costos.js 2026-05-06   # simular otra fecha
 *
 * Util para:
 *   - Verificar que las fechas next_due_date estan bien seteadas
 *   - Probar el formato del mensaje antes del primer envio real
 *   - Debug post-deploy si el admin no recibio recordatorio en una fecha esperada
 */

require('dotenv').config();
const { supabase } = require('../lib/db');
const { hoyPeru } = require('../lib/dates');
const { ADMIN_NUMBER } = require('../lib/config');

async function main() {
  const fechaSim = process.argv[2] || hoyPeru();
  console.log(`\n=== Dry-run recordatorio de costos ===`);
  console.log(`Fecha simulada: ${fechaSim}`);
  console.log(`Admin destino: ${ADMIN_NUMBER}\n`);

  const { data: costos, error } = await supabase.from('admin_costs')
    .select('id, label, amount_pen, currency, amount_original, frequency, next_due_date, last_reminder_sent_at, active')
    .eq('active', true)
    .eq('next_due_date', fechaSim);

  if (error) {
    console.error('Error consultando admin_costs:', error.message);
    process.exit(1);
  }

  if (!costos || costos.length === 0) {
    console.log(`Ningun costo activo vence el ${fechaSim}. Cron no enviaria mensaje.\n`);
    process.exit(0);
  }

  const aNotificar = costos.filter(c => {
    if (!c.last_reminder_sent_at) return true;
    const last = new Date(c.last_reminder_sent_at);
    const lastDayLima = new Date(last.toLocaleString('en-US', { timeZone: 'America/Lima' }))
      .toISOString().split('T')[0];
    return lastDayLima !== fechaSim;
  });

  if (aNotificar.length === 0) {
    console.log(`${costos.length} costo(s) vencen hoy pero ya fueron notificados. Cron skipea.\n`);
    process.exit(0);
  }

  let msg = '💸 *Recordatorio de costos — vencen hoy*\n\n';
  let totalPen = 0;
  for (const c of aNotificar) {
    const amount = parseFloat(c.amount_pen);
    totalPen += amount;
    const freqLabel = c.frequency === 'monthly' ? 'mensual'
      : c.frequency === 'yearly' ? 'anual' : 'único';
    let line = '• *' + c.label + '* — S/ ' + amount.toFixed(2);
    if (c.currency === 'USD' && c.amount_original) {
      line += ' ($' + parseFloat(c.amount_original).toFixed(2) + ')';
    }
    line += ' _(' + freqLabel + ')_\n';
    msg += line;
  }
  msg += '\n*Total a pagar hoy: S/ ' + totalPen.toFixed(2) + '*\n\n';
  msg += '_Cuando los pagues, marcalos como pagados desde app.neto.pe/admin/costs_';

  console.log('--- Mensaje que se enviaria ---');
  console.log(msg);
  console.log('--- Fin del mensaje ---\n');
  console.log(`Costos notificados: ${aNotificar.length}`);
  console.log(`Total: S/ ${totalPen.toFixed(2)}`);
  console.log('\nNo se envio ningun WhatsApp ni se modifico la DB. Dry-run completo.\n');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
