export const CATEGORIAS = [
  { nombre: 'Alimentación', emoji: '🍽️', subs: ['delivery','restaurante','supermercado','mercado','cafeteria','snacks'] },
  { nombre: 'Transporte', emoji: '🚌', subs: ['uber_cabify','taxi','bus_micro','metro_bus','gasolina','peaje','estacionamiento'] },
  { nombre: 'Vivienda', emoji: '🏠', subs: ['alquiler','mantenimiento','electricidad','agua','gas','internet','cable'] },
  { nombre: 'Salud', emoji: '💊', subs: ['farmacia','medico','clinica','laboratorio','seguro_salud','optica'] },
  { nombre: 'Entretenimiento', emoji: '🎰', subs: ['streaming','cine','juegos','bares_clubs','eventos','hobbies'] },
  { nombre: 'Compras', emoji: '🛒', subs: ['ropa','calzado','electronico','hogar','belleza','mascotas'] },
  { nombre: 'Educación', emoji: '📚', subs: ['universidad','instituto','curso_online','utiles','idiomas','colegios'] },
  { nombre: 'Finanzas', emoji: '💳', subs: ['prestamo','tarjeta_credito','seguro','ahorro','inversion','comision_banco'] },
  { nombre: 'Trabajo_Negocio', emoji: '💼', subs: ['herramientas','publicidad','oficina','logistica','contador'] },
  { nombre: 'Otros', emoji: '📋', subs: ['regalo','donacion','multa','viaje','sin_categoria'] }
] as const;

export const CATEGORIA_EMOJI: Record<string, string> = Object.fromEntries(
  CATEGORIAS.map(c => [c.nombre, c.emoji])
);

export const MESES = ['','Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

export const SOCIAL_LINKS = {
  whatsapp: 'https://wa.me/51933014505',
  facebook: 'https://www.facebook.com/profile.php?id=61578664208419',
  instagram: 'https://www.instagram.com/neto_peru/',
  web: 'https://neto.pe',
};
