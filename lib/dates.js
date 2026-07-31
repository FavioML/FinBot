// Funciones de fecha centralizadas — siempre zona horaria Perú (UTC-5)

function hoyPeru() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
}

function ayerPeru() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  d.setDate(d.getDate() - 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function ahoraPeru() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
}

function primeroDeMesPeru() {
  const d = ahoraPeru();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01';
}

function mesActualPeru() {
  const d = ahoraPeru();
  return { mes: d.getMonth() + 1, anio: d.getFullYear() };
}

function ultimoDiaMes(anio, mes) {
  return new Date(anio, mes, 0).getDate();
}

// Suma (o resta) meses a una fecha 'YYYY-MM-DD' preservando el día del mes, y si ese día
// no existe en el mes destino lo recorta al último día. Devuelve 'YYYY-MM-DD'.
//
// `Date.prototype.setMonth` NO sirve para esto: desborda al mes siguiente.
// 31-ene + 1 mes da 3-mar, no 28-feb. Dónde dolía:
//   - `services/referrals.js`: el mes de Pro por referidos regalaba días de yapa.
//   - `cron/checks.js`: la próxima fecha de cobro de una suscripción perdía el día del mes
//     de forma PERMANENTE (el avance es iterativo), y como el aviso solo sale si faltan
//     exactamente SUB_LEAD_DIAS, el recordatorio dejaba de salir sin dejar rastro.
// Es aritmética de calendario pura sobre enteros: sin objeto Date, sin zona horaria, así
// que tampoco puede correrse un día por el ida y vuelta de `toISOString()`.
function sumarDias(fechaISO, dias) {
  const [y, m, d] = String(fechaISO).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) throw new Error('sumarDias: fecha inválida: ' + fechaISO);
  // Mediodía UTC para no cruzar límites de día por DST/desfase de zona.
  const dt = new Date(Date.UTC(y, m - 1, d + dias, 12, 0, 0));
  return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
}

function sumarMeses(fechaISO, meses) {
  const [y, m, d] = String(fechaISO).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) throw new Error('sumarMeses: fecha inválida: ' + fechaISO);
  const totalMeses = (y * 12) + (m - 1) + meses;
  const anioDest = Math.floor(totalMeses / 12);
  const mesDest = (totalMeses % 12) + 1;
  const diaDest = Math.min(d, ultimoDiaMes(anioDest, mesDest));
  return anioDest + '-' + String(mesDest).padStart(2, '0') + '-' + String(diaDest).padStart(2, '0');
}

const DOW_MAP = {
  domingo: 0, lunes: 1, martes: 2,
  miercoles: 3, 'miércoles': 3,
  jueves: 4, viernes: 5,
  sabado: 6, 'sábado': 6
};

// Si el msg contenía "el <weekday> pasado/pasada" y la fecha del parser no
// cae en ese día, devuelve el <weekday> más reciente ANTES de fechaHoy
// (YYYY-MM-DD). Si no aplica, devuelve null. fechaHoy en TZ Lima (UTC-5).
function resolverDiaSemanaPasado(msg, fechaParseada, fechaHoy) {
  const m = (msg || '').toLowerCase().match(/\bel\s+(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\s+pasad[oa]\b/i);
  if (!m) return null;
  const targetDow = DOW_MAP[m[1].toLowerCase()];
  if (targetDow === undefined) return null;
  if (fechaParseada && /^\d{4}-\d{2}-\d{2}$/.test(fechaParseada)) {
    const [py, pm, pd] = fechaParseada.split('-').map(Number);
    if (new Date(py, pm - 1, pd).getDay() === targetDow) return null;
  }
  const [hy, hm, hd] = fechaHoy.split('-').map(Number);
  const d = new Date(hy, hm - 1, hd);
  let diff = d.getDay() - targetDow;
  if (diff <= 0) diff += 7;
  d.setDate(d.getDate() - diff);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Si el msg contenía un marcador temporal relativo ("ayer", "anteayer/antier",
// "hace N días") y la fecha del parser no coincide con lo que ese marcador
// implica, devuelve la fecha esperada (YYYY-MM-DD). Si no aplica, devuelve null.
// Espejo del fix de tmp-004: validador puro post-OpenAI, cero prompt.
const _DIAS_PALABRAS = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
  seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10
};

function resolverFechaRelativa(msg, fechaParseada, fechaHoy) {
  if (!msg || !fechaHoy) return null;
  const m = msg.toLowerCase();
  let diasAtras = null;

  // anteayer / antier → 2 días. Chequear ANTES que ayer (\b lo distingue,
  // pero el orden hace explícita la prioridad).
  if (/\b(anteayer|antier)\b/.test(m)) {
    diasAtras = 2;
  } else if (/\bayer\b/.test(m)) {
    diasAtras = 1;
  } else {
    const reHace = /\bhace\s+(\d{1,3}|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+d[ií]as?\b/;
    const mh = m.match(reHace);
    if (mh) {
      const tok = mh[1];
      const n = /^\d+$/.test(tok) ? parseInt(tok, 10) : _DIAS_PALABRAS[tok];
      if (n && n >= 1 && n <= 365) diasAtras = n;
    }
  }
  if (diasAtras === null) return null;

  const [hy, hm, hd] = fechaHoy.split('-').map(Number);
  const d = new Date(hy, hm - 1, hd);
  d.setDate(d.getDate() - diasAtras);
  const fechaEsperada = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

  if (fechaParseada === fechaEsperada) return null;
  return fechaEsperada;
}

module.exports = { hoyPeru, ayerPeru, ahoraPeru, primeroDeMesPeru, mesActualPeru, ultimoDiaMes, sumarDias, sumarMeses, resolverDiaSemanaPasado, resolverFechaRelativa };
