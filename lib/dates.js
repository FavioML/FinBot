// Funciones de fecha centralizadas — siempre zona horaria Perú (UTC-5)

function hoyPeru() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
}

function ayerPeru() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

function ahoraPeru() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
}

function primeroDeMesPeru() {
  const d = ahoraPeru();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split('T')[0];
}

function mesActualPeru() {
  const d = ahoraPeru();
  return { mes: d.getMonth() + 1, anio: d.getFullYear() };
}

module.exports = { hoyPeru, ayerPeru, ahoraPeru, primeroDeMesPeru, mesActualPeru };
