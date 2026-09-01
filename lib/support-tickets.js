const { supabase } = require('./db');
const { enviarWhatsapp, META_ERR_FUERA_VENTANA } = require('./whatsapp');
const log = require('./logger');

// Estados en los que una conversación de soporte se considera ABIERTA (sesión viva).
// Solo 'cerrado' termina la sesión. Mientras esté en uno de estos, TODO mensaje del
// usuario se enruta al admin en vez de al bot (ver message-processor.procesarMensajeLibre).
const SESSION_ACTIVE_STATES = ['esperando_mensaje', 'pendiente', 'respondido'];

/**
 * VENTANA DE ESCUCHA — cuánto sigue viva una conversación de soporte sin que nadie escriba.
 *
 * Era de 48h, y con eso la sesión funcionaba como un INTERRUPTOR: mientras estaba abierta,
 * TODO mensaje de esa persona iba al admin y su asistente quedaba muerto. Un olvido del admin
 * le dejaba el bot apagado dos días a alguien que sólo quería anotar un gasto.
 *
 * Ahora es una ventana CORTA que se renueva con cada mensaje de cualquiera de los dos lados
 * (`updated_at` lo toca `registrarMensajeTicket`). Una conversación viva nunca se corta a la
 * mitad; una que se apagó expira sola en un rato. Es la diferencia entre "estás en modo
 * soporte hasta que alguien lo apague" y "te estoy escuchando ahora".
 *
 * **Las 2h son una elección, no una medición.** Con 3 feedbacks en 3 meses no hay muestra
 * para calibrarlo; se eligió el orden de magnitud de una conversación humana por chat. Si
 * algún día hay datos, el número que importa es cuánto tarda la gente en contestar.
 */
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;

// La ventana de servicio de Meta: 24h desde el último mensaje ENTRANTE de esa persona.
const VENTANA_META_MS = 24 * 60 * 60 * 1000;

/**
 * ¿La ventana de 24h de Meta está abierta para este usuario, y a qué correo se le puede
 * escribir si no lo está?
 *
 * **Se PREDICE al enviar en vez de reaccionar al callback, y es una decisión, no un atajo.**
 * El rechazo por ventana cerrada (131047) llega por callback, no en la respuesta del POST:
 * 452 de 459 fallos de 30 días entraron así, y el rechazo SÍNCRONO salió cero veces. O sea
 * que un fallback colgado del resultado del envío no se dispararía nunca. Colgarlo del
 * callback obligaría a que `lib/whatsapp.js` conozca el correo y los tickets — invirtiendo
 * las capas y armando un ciclo con `notify-user` — más idempotencia propia para no mandar
 * dos correos si el callback se repite.
 *
 * Predecir cuesta una consulta y puede equivocarse. Cuando se equivoca, el precio es UN
 * correo de más sobre una respuesta que además llegó por WhatsApp. Es el lado barato.
 *
 * La fuente es `conversaciones`, que es donde aterriza todo mensaje entrante que atiende el
 * bot. Lo que NO cubre son los mensajes escritos DENTRO de una sesión de soporte (esos van a
 * `tickets_mensajes`), y ese hueco falla del lado seguro: si alguien está en modo soporte
 * acaba de escribir, así que su ventana está abierta y lo peor que pasa es el correo de más.
 *
 * Y el correo no es un callejón: `hola@neto.pe` es una bandeja que se lee.
 *
 * @returns {Promise<{ abierta: boolean, email: string|null, recordatorios_activos: boolean }>}
 */
async function estadoVentana(usuarioId) {
  // La política ante la duda, en UN solo lugar y ARRIBA de todos los returns: tiene tres
  // entradas (sin usuario, lectura caída, y el `catch`), y hasta hace un rato la primera
  // devolvía una forma propia, sin `recordatorios_activos`.
  //
  // **Quien de verdad sostiene la garantía es `email: null`, y conviene saberlo antes de
  // "simplificar" este objeto.** La revisión adversarial propuso que la seguridad dependía del
  // orden de dos líneas —que poner `abierta: false` acá mandaría correo a quien se dio de
  // baja— y se midió: **es falso**. `correoPara = ventana.abierta ? null : ventana.email`
  // toma `email`, que en este objeto es null, así que con `abierta: false` tampoco sale nada.
  // La mutación lo confirmó: `{ abierta: false, …, recordatorios_activos: true }` deja la
  // suite ENTERA en verde, porque no hay daño que detectar.
  //
  // `recordatorios_activos: false` se queda igual, por lo que sí es cierto: no sabemos si esa
  // persona se dio de baja, y codificar un desconocido como "sí, mandale" es la afirmación
  // equivocada de las dos. Es un cinturón redundante, no el que aguanta.
  const ANTE_LA_DUDA = { abierta: true, email: null, recordatorios_activos: false };
  if (!usuarioId) return ANTE_LA_DUDA;
  try {
    const [{ data: u, error: errUsuario }, { data: conv, error: errConv }] = await Promise.all([
      supabase.from('usuarios').select('email, recordatorios_activos').eq('id', usuarioId).maybeSingle(),
      supabase.from('conversaciones').select('created_at')
        .eq('usuario_id', usuarioId).eq('rol', 'usuario')
        .order('created_at', { ascending: false }).limit(1),
    ]);
    // **El `catch` de abajo era INALCANZABLE para el modo de fallo real.** supabase-js no
    // lanza: devuelve `{ data: null, error }`. Sin leer ese error, una lectura caída no
    // llegaba nunca a la política declarada — y no caia en un punto neutro sino en el
    // OPUESTO: con `conversaciones` caída, `conv` llega null, `ultimo` queda en 0 y
    // `abierta` sale FALSE, o sea que la duda decidía MANDAR el correo. El comentario del
    // catch declaraba justo lo contrario, dos lineas más abajo.
    if (errUsuario || errConv) {
      log.warn({ tag: 'SOPORTE', usuarioId, err: (errUsuario || errConv).message },
        'No pude evaluar la ventana de Meta (lectura caida): asumo abierta y no mando correo');
      return ANTE_LA_DUDA;
    }
    const ultimo = conv && conv.length ? new Date(conv[0].created_at).getTime() : 0;
    return {
      abierta: ultimo > 0 && (Date.now() - ultimo) < VENTANA_META_MS,
      email: (u && u.email) || null,
      // Se devuelve CRUDO y la decision la toma quien manda. Sacarla de acá no es estilo: el
      // guard de `canal-unico-sin-cuenta-web` mira la funcion que DECLARA el correo, asi que
      // esconder el flag en un helper lo deja ciego (clase `guard-partido-por-una-extraccion`).
      // El nombre de la COLUMNA y no un alias en camelCase: el guard busca
      // `.recordatorios_activos` en una decision, y renombrarlo lo deja ciego sobre una regla
      // que si se cumple. Un invariante que el instrumento no puede ver no es un invariante.
      recordatorios_activos: !u || u.recordatorios_activos !== false,
    };
  } catch (e) {
    // Ante la duda, se ASUME ABIERTA: el correo es el canal excepcional, y mandarlo por un
    // hipo de la base convierte un error de lectura en un mail que la persona no esperaba.
    log.warn({ tag: 'SOPORTE', usuarioId, err: e.message }, 'No pude evaluar la ventana de Meta');
    return ANTE_LA_DUDA;
  }
}

/**
 * Responde a un ticket de soporte: manda el mensaje del admin al usuario por
 * WhatsApp (como NETO) y marca el ticket como respondido.
 *
 * Fuente única para las TRES puertas del admin: el comando /responder por
 * WhatsApp, el mismo comando por Telegram, y el panel de la webapp. Antes esta
 * lógica vivía sólo en el webhook de WhatsApp; el panel de la webapp escribía
 * columnas que no existen (`respuesta_admin`/`respondido_at`) y ni siquiera
 * mandaba el WhatsApp, así que "Responder" desde la web fallaba en silencio.
 *
 * Acepta el número directo (comandos, el admin lo teclea) o un `ticketId` (panel
 * webapp, que ya tiene la fila). Si sólo viene el número, actualiza el ticket
 * pendiente más reciente de ese número.
 *
 * Ojo con la ventana de 24h de Meta: si el usuario no escribió en las últimas
 * 24h, el WhatsApp libre no se entrega (error 131047) y esto devuelve el fallo.
 *
 * @param {{ numDestino?: string|null, mensaje: string, ticketId?: string|null }} args
 * `wamid` sale para que el llamador pueda colgarlo del turno en el hilo: es lo que cruza el
 * mensaje con su fila de `notification_deliveries`, o sea con su ENTREGA real.
 *
 * @returns {Promise<{ ok: boolean, msg: string, wamid?: string|null }>}
 */
async function responderTicket({ numDestino = null, mensaje, ticketId = null, usuarioId: usuarioIdArg = null }) {
  const texto = String(mensaje || '').trim();
  if (!texto) return { ok: false, msg: 'Escribe el mensaje de respuesta.' };

  let numero = String(numDestino || '').replace(/\+/g, '').trim();
  let targetTicketId = ticketId || null;

  // Panel webapp: vino el id del ticket, resolvemos el número desde la fila. El `usuario_id`
  // sale del mismo viaje: lo necesita el ledger de entrega para que la fila sea atribuible.
  // El llamador puede traerlo (contactarUsuario lo tiene de la fila de nlp_errors). Sin esto,
  // responder un feedback sin abrir conversacion dejaba la fila del ledger SIN atribuir: existe
  // pero no se puede cruzar con el usuario, que es la mitad de para que sirve.
  let usuarioId = usuarioIdArg || null;
  if (targetTicketId) {
    const { data: t, error: errTicket } = await supabase
      .from('tickets_soporte').select('whatsapp, usuario_id').eq('id', targetTicketId).maybeSingle();
    // Sin esto la lectura caída sale por la MISMA puerta que "ese ticket no existe": el número
    // queda vacio y el admin lee "No encontre el número del ticket" sobre una fila que si
    // esta. Se corta y se dice, que además es reintentable — el panel es de una persona. Y no
    // es solo el número: sin `usuario_id` la fila del ledger nace SIN ATRIBUIR, que es la
    // mitad de para que sirve.
    if (errTicket) {
      log.error({ tag: 'SOPORTE', ticketId: targetTicketId, err: errTicket.message },
        'No pude leer el ticket para responder');
      return { ok: false, msg: '❌ No pude leer el ticket (problema de base). Reintenta en un momento.' };
    }
    if (t) {
      if (!numero) numero = t.whatsapp ? String(t.whatsapp).replace(/\+/g, '').trim() : '';
      usuarioId = usuarioId || t.usuario_id || null;
    }
  }

  if (!numero) return { ok: false, msg: 'No encontré el número del ticket.' };

  try {
    // enviarWhatsapp NO lanza ante error de Meta: devuelve { ok, code, error }. Hay que
    // mirar el retorno, o el ✅ sería un falso positivo (ej: fuera de la ventana de 24h).
    // **El `tipo` no es telemetría: es lo que hace que exista la fila del ledger.** Sin él,
    // `registrarEntrega` hace `if (!tipo) return` y el callback de status de Meta no matchea
    // nada, así que el desenlace REAL de la respuesta no se sabe nunca — el panel decía
    // "Respuesta enviada" y esa frase sólo significaba que Meta aceptó el POST. Sobre 30
    // días, de 556 aceptados se entregaron 67 (452 fallos por la ventana de 24h).
    //
    // La excepción que declara `registrarEntrega` en su docblock —las respuestas del webhook
    // no se registran porque siempre están dentro de la ventana— NO cubre este caso: acá el
    // admin puede contestar días después, que es justo cuando la ventana ya cerró.
    const envio = await enviarWhatsapp(
      numero,
      '👤 *Respuesta del equipo Neto:*\n\n' + texto +
      '\n\n_Si necesitas más ayuda, cuéntanos o escríbenos a hola@neto.pe_',
      { tipo: 'soporte_respuesta', usuarioId: usuarioId || null }
    );

    if (!envio || !envio.ok) {
      // No se entregó → NO marcamos el ticket como respondido (queda visible como pendiente).
      if (envio && envio.code === META_ERR_FUERA_VENTANA) {
        return { ok: false, msg: '⏳ No se entregó: el usuario no escribe hace más de 24h (ventana de Meta cerrada). Pídele que te escriba algo y reintenta.' };
      }
      return {
        ok: false,
        msg: '❌ Meta rechazó el envío' + (envio && envio.code ? ' (code ' + envio.code + ')' : '') + '. No marqué el ticket como respondido.',
      };
    }

    // Entregado. Si no vino ticketId (comandos), tomamos el pendiente más reciente del número.
    // El mensaje YA salió, así que una lectura caída no puede abortar nada — pero tampoco es
    // inocua: sin el ticket, la respuesta no entra al hilo ni marca `respondido`, y el ticket
    // sigue apareciendo como pendiente en /tickets y en el panel. El admin lo lee como "no
    // contesté todavía" y contesta dos veces. Se loguea, y el retorno lo DICE en vez de un ✅
    // liso que significa otra cosa.
    let avisoRegistro = '';
    if (!targetTicketId) {
      const { data: tickets, error: errPendiente } = await supabase
        .from('tickets_soporte').select('id')
        .eq('whatsapp', numero).in('estado', ['pendiente', 'esperando_mensaje'])
        .order('created_at', { ascending: false }).limit(1);
      if (errPendiente) {
        log.error({ tag: 'SOPORTE', numero, err: errPendiente.message },
          'No pude buscar el ticket pendiente de ese número');
        // **Dice que no pudo VERIFICAR, no que quedó pendiente.** Lo segundo era falso en el
        // camino de contactarUsuario, que entra siempre acá —nunca pasa ticketId— y cuyo
        // destinatario en el PRIMER contacto no tiene ticket: viene de nlp_errors, y la
        // conversación la abre esa misma función unas líneas después. (Deja de no tenerlo
        // apenas la persona contesta, así que la premisa vale para el primer contacto y no
        // para siempre; el texto de abajo es cierto en los dos.) El sufijo existe para que el
        // admin no conteste dos veces; afirmando de más, era él quien lo provocaba.
        avisoRegistro = ' (no pude verificar si quedaba un ticket que marcar)';
      }
      targetTicketId = tickets && tickets.length > 0 ? tickets[0].id : null;
    }

    if (targetTicketId) {
      await registrarMensajeTicket({
        ticketId: targetTicketId, rol: 'admin', mensaje: texto,
        patchExtra: { estado: 'respondido' },
        // Con el wamid, el turno del admin se cruza con su fila de `notification_deliveries`
        // y el panel puede decir ENTREGADO o NO ENTREGADO en vez de sólo "enviada".
        wamid: envio.msgId || null,
      });
    }

    // ── La campana ────────────────────────────────────────────────────────────────────
    // El WhatsApp ya salió arriba con su propio encabezado y su fila en el ledger; lo único
    // que falta acá es el aviso in-app, y por eso el canal es único y va con su motivo.
    //
    // Por qué agregarla, si el WhatsApp se entregó: **el hilo de soporte vive en WhatsApp,
    // pero el aviso de que existe no tiene por qué**. La campana es el único canal que llega
    // a todos —incluidos los usuarios web-first, que son a donde van las altas nuevas— y no
    // depende de la ventana de 24h de Meta. No es una segunda bandeja: es un cartel que dice
    // "te contestamos, mirá WhatsApp".
    //
    // Best-effort de verdad: si la campana falla, la respuesta YA se entregó y el retorno
    // tiene que seguir diciendo que salió. Un throw acá convertiría un éxito en un error.
    if (usuarioId) {
      try {
        // El correo va SÓLO si la ventana de Meta parece cerrada. En paralelo siempre sería
        // duplicarle el mensaje a todo el mundo por un caso que casi nunca ocurre: el admin ve
        // el feedback el mismo día, así que la ventana suele estar abierta.
        const ventana = await estadoVentana(usuarioId);
        // **El correo respeta la baja.** El pie de cada email promete por escrito que darse de
        // baja apaga TODOS los canales; mandarle igual una respuesta nos convierte en mentirosos
        // sobre lo unico que le prometimos por escrito. No queda sin respuesta: el WhatsApp se
        // intenta igual y la campana sale siempre.
        let correoPara = ventana.abierta ? null : ventana.email;
        if (ventana.recordatorios_activos === false) correoPara = null;
        const { notificarUsuario, CANALES } = require('./notify-user');
        await notificarUsuario({
          canales: CANALES.SOLO_IN_APP,
          motivo: 'el WhatsApp lo manda esta misma función, con su encabezado de equipo y su fila en el ledger; acá sólo falta la campana',
          usuarioId,
          tipo: 'soporte_respuesta_in_app',
          titulo: 'El equipo de Neto te respondió',
          mensaje: texto,
          tipoInApp: 'sistema',
          // `email` es otra DIMENSIÓN, no un cuarto valor de CANALES: no aplica a casi ningún
          // aviso y necesita un asunto que el enum no tiene dónde llevar.
          // Literal SIEMPRE, con el destinatario en null cuando la ventana está abierta. Dos
          // razones: `notificaciones-duales` verifica ESTÁTICAMENTE que todo canal de correo
          // declarado traiga asunto, y un ternario lo deja ciego. Y el no-op deja fila
          // (`skipped_no_email`), así que "el correo no salió porque no hacía falta" queda
          // distinguible de "nadie llamó al canal".
          email: {
            to: correoPara,
            asunto: 'Respuesta del equipo de Neto',
          },
        });
      } catch (e) {
        log.warn({ tag: 'SOPORTE', usuarioId, err: e.message }, 'No se pudo dejar la campana de la respuesta');
      }
    }

    return { ok: true, msg: '✅ Respuesta enviada a ' + numero + '.' + avisoRegistro, wamid: envio.msgId || null };
  } catch (e) {
    log.error({ tag: 'RESPONDER', err: e.message }, 'Error enviando respuesta admin');
    return { ok: false, msg: '❌ Error enviando la respuesta: ' + e.message };
  }
}

/**
 * Lista los tickets de soporte pendientes (para el comando /tickets del admin).
 * @returns {Promise<string>} texto listo para enviar al admin.
 */
async function listarTicketsPendientes() {
  const { data: ticketsList, error } = await supabase
    .from('tickets_soporte').select('*')
    .in('estado', ['pendiente', 'esperando_mensaje'])
    .order('created_at', { ascending: false }).limit(10);

  // "Todo tranquilo" sobre una lectura caída es la misma mentira que /panel contestando "No
  // hay usuarios registrados" con más de cien: el único estado que el admin NO puede
  // distinguir es justo el que le importa. Son mensajes distintos a propósito.
  if (error) {
    log.error({ tag: 'SOPORTE', err: error.message }, 'No pude listar los tickets pendientes');
    return '⚠️ No pude leer los tickets (problema de base). Reintenta en un momento.';
  }

  if (!ticketsList || ticketsList.length === 0) {
    return '📭 No hay tickets pendientes. ¡Todo tranquilo!';
  }

  let msg = '🎫 *Tickets pendientes (' + ticketsList.length + '):*\n\n';
  ticketsList.forEach((t, i) => {
    msg += (i + 1) + '. ' + (t.nombre_usuario || 'Sin nombre') + ' (' + t.whatsapp + ')\n';
    msg += '   📋 ' + t.estado + ' | ' + new Date(t.created_at).toLocaleDateString('es-PE') + '\n';
    if (t.mensaje_usuario) msg += '   💬 ' + t.mensaje_usuario.substring(0, 80) + '\n';
    msg += '\n';
  });
  msg += '_Responde con:_\n/responder <número> <mensaje>';
  return msg;
}

/**
 * Devuelve la sesión de soporte ABIERTA de un usuario (ticket en un estado activo),
 * o null si no hay. Aplica autocierre lazy: si la sesión lleva más de 48h sin
 * actividad, la cierra y devuelve null (el usuario vuelve al bot).
 *
 * @param {string} usuarioId
 * @returns {Promise<object|null>} el ticket abierto, o null.
 */
async function obtenerSesionAbierta(usuarioId) {
  if (!usuarioId) return null;
  const { data, error } = await supabase.from('tickets_soporte').select('*')
    .eq('usuario_id', usuarioId).in('estado', SESSION_ACTIVE_STATES)
    .order('created_at', { ascending: false }).limit(1);
  // **Se falla ABIERTO (null = no hay sesión) y es una decisión, no el descarte de antes.**
  // Esta lectura corre en el arranque de CADA mensaje entrante (`procesarMensajeLibre`, dentro
  // de un `Promise.all`): propagar el error rechazaría ese Promise.all y le rompe el registro
  // de gastos a TODO el mundo por una tabla que casi nadie usa. Fallar abierto le cuesta al
  // que si esta en soporte —su mensaje se lo lleva el bot— y eso es lo que el log tiene que
  // dejar ver. Lo que cambio no es el retorno: es que ahora se SABE que pasó.
  if (error) {
    log.error({ tag: 'SOPORTE', usuarioId, err: error.message },
      'No pude leer la sesion de soporte: trato el mensaje como si no hubiera sesion');
    return null;
  }
  if (!data || data.length === 0) return null;
  const t = data[0];
  const ref = t.updated_at || t.created_at;
  if (ref && (Date.now() - new Date(ref).getTime()) > SESSION_IDLE_MS) {
    // **Se avisa, y no es cortesía.** Esta rama se dispara casi siempre por un mensaje
    // ENTRANTE: alguien escribe creyendo que sigue hablando con una persona, la ventana ya
    // venció, y ese mensaje se lo lleva el bot. Sin el aviso, la respuesta que recibe es
    // Neto contestándole sobre sus gastos a una pregunta de soporte — que es peor que el
    // silencio, porque parece que el equipo le contestó cualquier cosa.
    //
    // Va por `cerrarSesion` en vez de un UPDATE propio: es el mismo cierre, y duplicarlo
    // acá era la puerta por la que las dos copias se separan.
    await cerrarSesion({ usuarioId, avisarUsuario: true, porInactividad: true });
    log.info({ tag: 'SOPORTE', usuarioId }, 'Sesión de soporte autocerrada por inactividad');
    return null;
  }
  return t;
}

/**
 * Abre una sesión de soporte para un usuario. Idempotente: si ya hay una abierta,
 * no crea otra. El ticket nace en 'esperando_mensaje' (a la espera del primer
 * mensaje, que lo pasa a 'pendiente' y notifica al admin).
 *
 * @param {{ usuarioId: string, whatsapp: string, nombre?: string|null }} args
 * @returns {Promise<{ yaAbierta: boolean, ticket: object|null }>}
 */
async function abrirSesion({ usuarioId, whatsapp, nombre = null }) {
  const existente = await obtenerSesionAbierta(usuarioId);
  if (existente) return { yaAbierta: true, ticket: existente };
  const { data, error } = await supabase.from('tickets_soporte').insert({
    usuario_id: usuarioId,
    whatsapp,
    nombre_usuario: nombre,
    estado: 'esperando_mensaje',
  }).select('id').maybeSingle();
  // El `catch` que `moderacion.js` tiene alrededor de esta llamada —el que contesta "se me
  // trabó abriendo la conversación"— es INALCANZABLE si el insert es rechazado: supabase-js
  // no lanza. Sin ticket, `/soporte` igual contestaba "*Modo soporte activado*, escribe tu
  // consulta y se la hago llegar al equipo", y lo que la persona escribía después no
  // encontraba sesión (`obtenerSesionAbierta` devuelve null) y se lo llevaba el bot: cree
  // estar hablando con una persona y Neto le contesta sobre sus gastos. Es lo que este mismo
  // archivo llama, en otra rama, "peor que el silencio".
  if (error) {
    log.error({ tag: 'SOPORTE', usuarioId, err: error.message }, 'No pude abrir la sesion de soporte');
  }
  return { yaAbierta: false, ticket: data || null };
}

/**
 * Cierra la(s) sesión(es) de soporte abiertas de un usuario, por id o por número.
 * Opcionalmente avisa al usuario por WhatsApp (para el /cerrar del admin).
 *
 * @param {{ usuarioId?: string, whatsapp?: string, avisarUsuario?: boolean, porInactividad?: boolean }} args
 * @returns {Promise<{ ok: boolean, closed: number, msg: string|null }>} `ok` va SIEMPRE, en las
 *   seis salidas. Nació sólo en las de fallo y eso dejaba una trampa: `if (r.ok)` daba falso
 *   en el camino exitoso, y el doble de `admin-comandos-lecturas` devolvía un `{ ok: true }`
 *   que la función real no producía nunca. `ok: true` con `closed: 0` es un caso legítimo y
 *   frecuente: no había ninguna conversación abierta que cerrar.
 */
async function cerrarSesion({ usuarioId = null, whatsapp = null, avisarUsuario = false, porInactividad = false }) {
  const numero = whatsapp ? String(whatsapp).replace(/\+/g, '').trim() : null;
  let q = supabase.from('tickets_soporte').select('id, whatsapp').in('estado', SESSION_ACTIVE_STATES);
  if (usuarioId) q = q.eq('usuario_id', usuarioId);
  else if (numero) q = q.eq('whatsapp', numero);
  else return { ok: false, closed: 0, msg: 'Falta usuarioId o whatsapp.' };

  // El patrón builder: el error no existe en la linea del `supabase.from(` de arriba, solo
  // en esta. Sin leerlo, "no hay conversación abierta" y "no pude leer" salen por la misma
  // puerta — y además la sesión sigue viva, o sea que al usuario le sigue contestando el
  // admin en vez del bot mientras el admin cree haberla cerrado.
  const { data: abiertos, error: errAbiertos } = await q;
  if (errAbiertos) {
    log.error({ tag: 'SOPORTE', usuarioId, whatsapp: numero, err: errAbiertos.message },
      'No pude leer las conversaciones de soporte abiertas');
    return { ok: false, closed: 0, msg: '⚠️ No pude leer las conversaciones de soporte (problema de base). Reintenta en un momento.' };
  }
  if (!abiertos || abiertos.length === 0) {
    return { ok: true, closed: 0, msg: numero ? ('No hay conversación de soporte abierta para ' + numero + '.') : null };
  }
  const ids = abiertos.map((t) => t.id);
  const { error: errCierre } = await supabase.from('tickets_soporte')
    .update({ estado: 'cerrado', updated_at: new Date().toISOString() })
    .in('id', ids);
  if (errCierre) {
    log.error({ tag: 'SOPORTE', ids, porInactividad, err: errCierre.message },
      'No pude cerrar la conversación de soporte');
  }

  const numAviso = numero || abiertos[0].whatsapp;
  // **El aviso sigue a la decisión de RUTEO, no a la escritura, y los dos llamadores la toman
  // en momentos distintos.** Con la escritura muda, un UPDATE rechazado devolvía "✅ cerrada"
  // y le decía al usuario que su conversación estaba cerrada mientras sus mensajes seguían
  // yendo al admin. Cortar antes del aviso arregla ESE caso y rompe el otro:
  //
  //   · **/cerrar del admin** (porInactividad false): la sesión de verdad sigue viva, el admin
  //     va a reintentar, y anunciarle al usuario un cierre que no ocurrió es la mentira
  //     original. Acá el aviso SÍ depende de que el UPDATE haya entrado.
  //   · **el autocierre por inactividad** (porInactividad true, desde obtenerSesionAbierta):
  //     ese llamador devuelve null PASE LO QUE PASE con el UPDATE, o sea que el mensaje que
  //     disparó el vencimiento ya se lo lleva el bot. El aviso no anuncia la escritura:
  //     anuncia el RUTEO, que ya está decidido. Sin él, la persona escribe una pregunta de
  //     soporte y recibe a Neto hablándole de gastos — lo que el comentario de
  //     obtenerSesionAbierta llama, con esas palabras, "peor que el silencio".
  //
  // Lo que esta línea NO arregla, y va dicho entero porque la primera versión lo acotó de
  // menos: con el UPDATE caído la fila sigue activa Y `updated_at` no se mueve (el mensaje se
  // fue por la rama del bot, así que `registrarMensajeTicket` no corre), o sea que queda
  // vencida PARA SIEMPRE. Si la causa es transitoria el aviso se repite mientras dure; si es
  // estructural —una policy de RLS, un CHECK sobre `estado`— se repite en cada mensaje
  // entrante, indefinidamente. Del otro lado pasa lo simétrico: el ticket sigue apareciendo
  // en `/tickets` y en el panel como si nadie lo hubiera cerrado.
  //
  // Por eso el envío lleva `tipo`: sin él `registrarEntrega` hace `if (!tipo) return` y esto
  // no deja fila en `notification_deliveries`, o sea que "se repitió una vez" y "se repitió
  // cuatrocientas" se ven igual y ningún dedup futuro tiene qué leer. El repo ya pagó esa
  // forma: 12 avisos de onboarding idénticos a la misma persona, documentados en
  // `lib/notification-deliveries.js`.
  if (avisarUsuario && numAviso && (!errCierre || porInactividad)) {
    // Dos motivos, dos textos. "El equipo cerró tu conversación" sobre un vencimiento por
    // silencio es falso y además suena a portazo.
    const aviso = porInactividad
      ? '💚 Cerré la conversación con el equipo porque quedó sin actividad un rato.\n\nVolví a ser tu asistente: escríbeme un gasto cuando quieras.\n\n_Si necesitas retomar con una persona, escribe */soporte*._'
      : '✅ El equipo de Neto cerró tu conversación de soporte.\n\nSi necesitas algo más, escribe */soporte* cuando quieras. 💚';
    try {
      await enviarWhatsapp(numAviso, aviso, { tipo: 'soporte_cierre_sesion', usuarioId: usuarioId || null });
    } catch (e) { /* best-effort */ }
  }
  if (errCierre) {
    return { ok: false, closed: 0, msg: '❌ No pude cerrar la conversación de soporte. Reintenta en un momento.' };
  }
  return { ok: true, closed: ids.length, msg: '✅ Conversación de soporte cerrada' + (numAviso ? ' (' + String(numAviso).replace(/\+/g, '') + ')' : '') + '.' };
}

/**
 * Anota un mensaje en el hilo de un ticket y actualiza la columna de ULTIMO mensaje del lado
 * que habló. Migración 079.
 *
 * **Es el único escritor de las dos representaciones, y por eso existe.** `tickets_soporte`
 * conserva `mensaje_usuario`/`mensaje_admin` porque el listado del panel y el `/tickets` de
 * WhatsApp muestran una línea por ticket sin traerse el hilo entero. Pero el mismo dato en dos
 * lugares diverge solo apenas hay dos escritores; acá hay uno, así que la columna no puede
 * quedar contando otra cosa que la última fila del hilo.
 *
 * El hilo es la fuente de verdad; la columna es caché. Si alguna vez hay que elegir, se
 * reconstruye la columna desde el hilo y nunca al revés.
 *
 * Best-effort y **ruidoso**: si el hilo no entra, el mensaje ya se envió igual y cortar acá no
 * lo desenvía. Pero se LOGUEA — supabase-js no lanza, así que sin leer el `{ error }` un insert
 * rechazado se ve idéntico a uno exitoso y el hilo se vaciaría en silencio.
 *
 * `wamid` es el id del mensaje en Meta cuando el turno es del admin: es lo que cruza esta
 * fila con `notification_deliveries` para saber si se ENTREGÓ. Null en el turno del usuario
 * (no es un mensaje nuestro) y en un envío que Meta rechazó de entrada.
 *
 * @param {{ ticketId: string, rol: "usuario"|"admin", mensaje: string, patchExtra?: object, wamid?: string|null }} args
 */
async function registrarMensajeTicket({ ticketId, rol, mensaje, patchExtra = {}, wamid = null }) {
  if (!ticketId || !mensaje) return;
  const texto = String(mensaje).substring(0, 1000);

  const { error: errHilo } = await supabase.from('tickets_mensajes').insert({
    ticket_id: ticketId, rol, mensaje: texto, wamid: wamid || null,
  });
  if (errHilo) {
    log.error({ tag: 'SOPORTE', ticketId, rol, err: errHilo.message }, 'No entró el mensaje al hilo');
  }

  const columna = rol === 'admin' ? 'mensaje_admin' : 'mensaje_usuario';
  const { error: errCol } = await supabase.from('tickets_soporte').update({
    [columna]: texto,
    updated_at: new Date().toISOString(),
    ...patchExtra,
  }).eq('id', ticketId);
  if (errCol) {
    log.error({ tag: 'SOPORTE', ticketId, rol, err: errCol.message }, 'No se actualizó el último mensaje del ticket');
  }
}

/**
 * Devuelve el hilo completo de un ticket, en orden cronológico. Lo usa el panel.
 * @returns {Promise<Array<{rol: string, mensaje: string, created_at: string}>>}
 */
async function obtenerHiloTicket(ticketId) {
  if (!ticketId) return [];
  const { data, error } = await supabase.from('tickets_mensajes')
    .select('rol, mensaje, created_at').eq('ticket_id', ticketId)
    .order('created_at', { ascending: true });
  if (error) {
    log.error({ tag: 'SOPORTE', ticketId, err: error.message }, 'No se pudo leer el hilo');
    // Se PROPAGA: devolver [] acá haría que el panel pinte "sin mensajes" sobre una lectura
    // caída, que es la mentira que este módulo ya pagó en otras pantallas.
    throw new Error(error.message);
  }
  return data || [];
}
/**
 * Contacta a un usuario que NO abrió un ticket: la respuesta del admin a un feedback o a una
 * queja desde el panel (tab "NLP Errors").
 *
 * Existe porque esas dos cosas no viven en `tickets_soporte` sino en `nlp_errors`, así que no
 * hay ticket que responder — y hasta hoy la única forma de contestarle a alguien que dejó una
 * sugerencia era escribirle desde un celular.
 *
 * **El envío va PRIMERO y la sesión sólo se abre si el mensaje se entregó.** Al revés, un fallo
 * de la ventana de 24h dejaría a la persona en modo soporte sin haber recibido nada: sus
 * mensajes siguientes irían al admin en vez del bot (message-processor:104) y su registro de
 * gastos quedaría roto hasta el autocierre, por una conversación que nunca existió.
 *
 * **El ticket se crea SIEMPRE, y ya no hay checkbox.** Hasta el 28-ago abrir la conversación
 * era opcional porque abrirla secuestraba el bot 48 horas; con la ventana corta y deslizante
 * (ver SESSION_IDLE_MS) ese miedo desapareció, y lo que quedaba era el peor de los dos mundos:
 * la respuesta del admin se enviaba y **no se guardaba en ningún lado** —no hay ticket, así
 * que no hay dónde colgar el mensaje— y si la persona contestaba, su mensaje se lo comía el
 * bot. Medido en producción el 28-ago con la primera respuesta real: llegó (`delivered_at`
 * puesto) y de su texto no quedó rastro.
 *
 * El ticket es el REGISTRO de que esta conversación existió. Que además el próximo mensaje
 * de la persona vuelva al admin es consecuencia de que la ventana esté fresca, no una
 * decisión aparte.
 *
 * @param {{ usuarioId?: string|null, whatsapp: string, nombre?: string|null, mensaje: string }} args
 * @returns {Promise<{ ok: boolean, msg: string, conversacionAbierta?: boolean }>}
 */
async function contactarUsuario({ usuarioId = null, whatsapp, nombre = null, mensaje }) {
  const numero = String(whatsapp || '').replace(/\+/g, '').trim();
  if (!numero) return { ok: false, msg: 'No encontré el número de esa persona.' };

  // Mismo envío, mismo encabezado y mismo manejo del 131047 que la respuesta a un ticket: si
  // esto se duplicara, la ventana de 24h se trataría distinto según por qué pantalla se entró.
  const envio = await responderTicket({ numDestino: numero, mensaje, usuarioId });
  if (!envio.ok) return envio;

  if (!usuarioId) {
    // `nlp_errors.usuario_id` es nullable. El mensaje se entregó igual —el número estaba—
    // pero sin usuario no hay a quién colgarle el ticket, así que esta conversación no queda
    // registrada. Se DICE, en vez de devolver un ok liso que se lee como "quedó guardado".
    return { ok: true, msg: envio.msg + ' (no quedó registrada: esa fila no tiene usuario).', conversacionAbierta: false };
  }

  const { ticket } = await abrirSesion({ usuarioId, whatsapp: numero, nombre });
  if (!ticket || !ticket.id) {
    return { ok: true, msg: envio.msg + ' (no pude registrar la conversación).', conversacionAbierta: false };
  }
  // `respondido` y no `esperando_mensaje`: el que habló fue el admin. Es un estado ACTIVO, o
  // sea que la ventana de escucha queda abierta y lo que la persona conteste vuelve al panel
  // en vez de irse al bot. Se cierra sola por inactividad (SESSION_IDLE_MS).
  await registrarMensajeTicket({
    ticketId: ticket.id, rol: 'admin', mensaje, wamid: envio.wamid || null,
    patchExtra: { estado: 'respondido' },
  });
  return { ok: true, msg: envio.msg + ' Te aviso si contesta.', conversacionAbierta: true };
}

module.exports = {
  responderTicket,
  contactarUsuario,
  registrarMensajeTicket,
  obtenerHiloTicket,
  listarTicketsPendientes,
  obtenerSesionAbierta,
  abrirSesion,
  cerrarSesion,
  SESSION_ACTIVE_STATES,
};
