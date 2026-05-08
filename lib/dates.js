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

module.exports = { hoyPeru, ayerPeru, ahoraPeru, primeroDeMesPeru, mesActualPeru, ultimoDiaMes, resolverDiaSemanaPasado };
