/**
 * ¿El destinatario de una captura "¡Yapeaste!" es el propio usuario? (24-oct-2026)
 *
 * Caso de producción: un psicólogo recibe por WhatsApp el comprobante que le manda su paciente.
 * La captura sale del celular de QUIEN PAGA, así que dice "¡Yapeaste! S/120 Jaime Car*", y el
 * prompt de Vision mapea "¡Yapeaste!" a gasto sin saber quién es el usuario. Cuatro cobros
 * entraron como egresos. Le pasa a todo independiente que cobra por Yape o Plin.
 *
 * Decide el CÓDIGO y no solo el prompt, por la misma razón que `anclarAnioDeCaptura`: el prompt
 * ayuda, pero depende de que el modelo obedezca.
 *
 * Falla hacia NO voltear. Exige nombre Y apellido del titular, y que la captura muestre los dos:
 * con solo "Jaime", un Jaime que le paga a otro Jaime vería su gasto convertido en ingreso. Yape
 * enmascara el apellido ("Jaime Car*"), así que el apellido se acepta por PREFIJO de al menos tres
 * letras; Plin y los bancos lo invierten ("Carrillo Cruz Jaime C."), así que el orden no importa.
 *
 * Límite declarado: "Jaime Car*" también es Jaime Cárdenas. Si el titular se llama Jaime Carrillo y
 * le paga a un Jaime Cárdenas, ese gasto sale ingreso. Es raro y se ve en la respuesta del bot.
 */

function tokens(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[^a-z ]+/g, ' ').split(/\s+/).filter(Boolean);
}

/**
 * @param {string} destinatario  el `comercio` que leyó Vision ("Jaime Car*")
 * @param {Array<string|null>} nombresTitular  nombres conocidos del usuario (perfil de Google, de WhatsApp...)
 * @returns {boolean}
 */
function destinatarioEsTitular(destinatario, nombresTitular) {
  const d = tokens(destinatario);
  if (d.length < 2) return false;
  return (nombresTitular || []).some((nombre) => {
    const t = tokens(nombre);
    if (t.length < 2) return false;
    const [primero, ...apellidos] = t;
    if (!d.includes(primero)) return false;
    // Un token de la captura que NO sea el nombre de pila tiene que nombrar un apellido.
    return d.some((c) => c !== primero && c.length >= 3 && apellidos.some((a) => a.startsWith(c)));
  });
}

module.exports = { destinatarioEsTitular };
