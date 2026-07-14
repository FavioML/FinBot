/**
 * Backup semanal de todas las tablas de Supabase a un GitHub Gist privado.
 * Cada backup sobrescribe el Gist anterior, pero GitHub mantiene el historial de revisiones.
 */
const { supabase } = require('../lib/db');
const log = require('../lib/logger');
const { enviarWhatsapp } = require('../lib/whatsapp');

const TABLES = [
  'usuarios',
  'transacciones',
  'presupuestos',
  'errores',
  'reglas_comercio',
  'categorias_usuario',
  'reporte_cache',
  'conversaciones',
];

const ADMIN = process.env.ADMIN_WHATSAPP || '51970398192';

async function runBackup() {
  const token = process.env.GITHUB_BACKUP_TOKEN;
  const gistId = process.env.BACKUP_GIST_ID;

  if (!token || !gistId) {
    log.warn({ tag: 'BACKUP' }, 'GITHUB_BACKUP_TOKEN o BACKUP_GIST_ID no configurados — backup omitido');
    return;
  }

  const timestamp = new Date().toISOString();
  log.info({ tag: 'BACKUP' }, 'Iniciando backup semanal...');

  try {
    const backup = { timestamp, tables: {} };

    for (const table of TABLES) {
      const { data, error } = await supabase.from(table).select('*');
      if (error) {
        log.error({ tag: 'BACKUP', table, err: error.message }, 'Error leyendo tabla');
        backup.tables[table] = { error: error.message };
      } else {
        backup.tables[table] = { count: data.length, rows: data };
      }
    }

    const content = JSON.stringify(backup, null, 2);
    const sizeKB = Math.round(Buffer.byteLength(content) / 1024);

    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json',
      },
      body: JSON.stringify({
        description: `Neto backup — ${timestamp}`,
        files: {
          'neto-backup.json': { content },
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub API ${res.status}: ${body.substring(0, 200)}`);
    }

    const totalRows = Object.values(backup.tables).reduce((sum, t) => sum + (t.count || 0), 0);
    log.info({ tag: 'BACKUP', sizeKB, totalRows, tables: TABLES.length }, 'Backup completado');
  } catch (err) {
    log.error({ tag: 'BACKUP', err: err.message }, 'Error en backup semanal');
    try {
      await enviarWhatsapp(ADMIN, `🔴 *Error en backup semanal*\n${err.message}`);
    } catch (_) { /* no propagar error de notificación */ }
  }
}

module.exports = { runBackup };
