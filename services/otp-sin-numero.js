const { supabase } = require('../lib/db');
const log = require('../lib/logger');

/**
 * OTP inverso para quien llega SIN número: la vinculación web↔WhatsApp por BSUID.
 *
 * **Por qué existe.** El OTP normal (`handlers/webhook.js`) vive 360 líneas más abajo del
 * `if (!from)` que descarta a los usuarios username-only, así que su código nunca se leía: el
 * mensaje moría antes. Para esa persona el onboarding web quedaba colgado para siempre en
 * "Esperando tu confirmación...", sin nada que pudiera hacer al respecto — ni reintentar, ni
 * generar otro código, ni escribir de nuevo. Medido el 02-sep-2026 con un usuario real que mandó
 * 9 códigos en 9 minutos y terminó reclamando por Instagram, que es el único motivo por el que
 * nos enteramos.
 *
 * **Por qué el BSUID alcanza como prueba de posesión, que es la pregunta que decide todo esto.**
 * El modelo del OTP es "quien envía el código desde su WhatsApp probó que ese WhatsApp es suyo".
 * Lo que prueba la posesión no es el número en sí: es que el identificador del remitente lo pone
 * META en el payload y el remitente no lo puede elegir. El `from_user_id` cumple exactamente esa
 * propiedad — es opaco, lo asigna Meta y es distinto por cada negocio. Vincular por BSUID no baja
 * el estándar de seguridad del flujo normal, usa el mismo.
 *
 * **Lo que este módulo NO arregla, y hay que decirlo porque cambia lo que se le promete a la
 * persona:** al usuario username-only sigue sin podérsele responder (el envío por BSUID no está
 * habilitado en nuestra WABA, medido en v19–v25). O sea que se vincula y la web se destraba, pero
 * él nunca ve el "tu cuenta quedó verificada". Se entera porque la pantalla avanza.
 *
 * Las ramas son las MISMAS que las del OTP con número, a propósito: si el modelo de identidad
 * cambia, los dos caminos tienen que moverse juntos. Ver también `webapp/src/lib/bind-activation.ts`,
 * que es el tercer lado del mismo triángulo.
 */

/**
 * @param {string} bsuid  `from_user_id` de Meta (formato `PE.1388235929393206`)
 * @param {string} code   código ya normalizado (`NETO-123456`)
 * @returns {Promise<{estado: string, usuarioId?: string, nombre?: string, email?: string}>}
 *   `vinculada` | `fusionada` | `adoptada` | `ya_vinculada` — se vinculó Y se destrabó la webapp
 *   `vinculada_sin_destrabar` — el vínculo quedó escrito pero el código no se pudo quemar, así
 *     que la persona SIGUE viendo el spinner. Necesita mano humana; el llamador avisa al admin y
 *     le devuelve la ficha del rate limit, porque el destrabe previsto es que reenvíe.
 *   `invalido` | `sin_cuenta_web` | `conflicto` | `lectura_fallida` | `error` — no se vinculó
 */
async function verificarCuentaWebPorBsuid(bsuid, code) {
  if (!bsuid || !code) return { estado: 'error' };
  try {
    // `PGRST116` acá NO es transitorio: `webapp_otp.code` no tiene índice único (migración 020),
    // así que dos cuentas pueden tener el mismo código de 6 dígitos pendiente y `maybeSingle()`
    // devuelve ese error sobre dos filas. Vincular una de las dos a ciegas ataría el WhatsApp a la
    // cuenta equivocada, así que cae a `invalido` — regenerar el código sí lo resuelve, porque el
    // upsert por `supabase_auth_id` reemplaza la fila de esa cuenta.
    const { data: otp, error: errOtp } = await supabase.from('webapp_otp')
      .select('id, supabase_auth_id, email, nombre, expires_at')
      .eq('code', code).is('verified_at', null).maybeSingle();
    if (errOtp && errOtp.code !== 'PGRST116') {
      log.error({ tag: 'OTP_BSUID', bsuid, err: errOtp.message }, 'No se pudo leer el código: no se declara inválido');
      return { estado: 'lectura_fallida' };
    }
    if (!otp || new Date(otp.expires_at).getTime() <= Date.now()) return { estado: 'invalido' };

    // Las dos filas candidatas. **Ninguna de las dos lecturas puede tragar su error**: sin leerlo,
    // una lectura caída se vuelve indistinguible de "esa fila no existe" y eso RAMIFICA — manda al
    // camino de vinculación directa una cuenta que en realidad ya tenía fila, y la escritura sale
    // por el lado equivocado. Es el mismo defecto que la revisión adversarial encontró en el OTP
    // con número.
    const { data: webRow, error: errWeb } = await supabase.from('usuarios')
      .select('id, nombre, email, bsuid, is_test_user').eq('supabase_auth_id', otp.supabase_auth_id).maybeSingle();
    if (errWeb) {
      log.error({ tag: 'OTP_BSUID', bsuid, err: errWeb.message }, 'No se pudo leer la cuenta web: no se elige rama a ciegas');
      return { estado: 'lectura_fallida' };
    }
    const { data: filaBsuid, error: errBs } = await supabase.from('usuarios')
      .select('id, nombre, email, supabase_auth_id, is_test_user').eq('bsuid', bsuid).maybeSingle();
    if (errBs) {
      log.error({ tag: 'OTP_BSUID', bsuid, err: errBs.message }, 'No se pudo leer la fila del BSUID: no se elige rama a ciegas');
      return { estado: 'lectura_fallida' };
    }

    // **`whatsapp_verified` queda NULL a propósito y no abre el hueco que parece.** Esa columna es
    // una de las tres por las que el borrado de cuenta barre esta tabla, y las otras dos son
    // `supabase_auth_id` y el email (`migrations/073d`, línea 166): `supabase_auth_id` es NOT NULL
    // en `webapp_otp`, así que la fila igual se borra ante un pedido de baja. Verificado leyendo la
    // función, no asumido — con número acá va el teléfono y no había equivalente para el BSUID.
    //
    // **La verificación está escrita a mano y NO usa `verificarEscritura`**, que es la misma
    // excepción que ya se tomó en la rama de link directo del OTP con número. Dos motivos, y el
    // segundo es el que manda:
    //   · este módulo necesita el CÓDIGO del error (`23505` decide `conflicto`), y el helper lo
    //     colapsa en un veredicto de tres valores;
    //   · `tests/lecturas-del-resto.test.js` tiene un tripwire que se pone rojo cuando alguien
    //     fuera de `handlers/` importa el helper, porque su parser reporta esas escrituras como
    //     mudas y el corte que lo evita vive en el guard hermano. Usarlo acá obligaba a traer ese
    //     reparto a un guard, o sea a tocar un instrumento para acomodar un módulo nuevo.
    // La verificación es la misma: se lee el `{ error }` y se exige que haya tocado una fila.
    // **Esta escritura NO es accesoria acá, y decir lo contrario fue un error de copiar el
    // razonamiento del flujo hermano.** En el OTP con número `verified_at` es sólo el fallback:
    // la señal primaria que `webapp/src/app/api/onboarding/route.ts` poletea es
    // `usuarios.whatsapp`, que ese camino escribe. **Este camino nunca escribe `whatsapp`** —no
    // hay número— así que `verified_at` es la ÚNICA señal que existe. Si el update falla, la
    // persona se queda en "Esperando tu confirmación..." y **no tiene canal por el que
    // enterarse**, que es exactamente el bug que este módulo vino a cerrar.
    //
    // Por eso decide el estado en vez de sólo loguear: devolver `vinculada` cuando esto falla
    // hace que el aviso al admin afirme "su onboarding se destrabó" sobre alguien que sigue
    // trabado. Lo encontró la revisión adversarial.
    const marcarVerificado = async (userId) => {
      const { data, error } = await supabase.from('webapp_otp')
        .update({ verified_at: new Date().toISOString() }).eq('id', otp.id).select('id');
      if (error || !data || data.length === 0) {
        log.error({ tag: 'OTP_BSUID', sitio: 'otp_bsuid_verificado', userId, err: error && error.message },
          'El vínculo quedó escrito pero NO se pudo marcar verificado: la webapp sigue trabada');
        return false;
      }
      return true;
    };

    // `marcado === false` degrada el desenlace: el vínculo se escribió (por eso no es `error`)
    // pero la pantalla del usuario no avanzó, y eso necesita una mano humana.
    /**
     * Las filas de `errores` que esta persona dejó mientras era anónima pasan a tener su
     * `usuario_id`.
     *
     * **Esto es lo que las hace BORRABLES, y por eso corre en toda salida que haya vinculado.**
     * `borrar_cuenta_total` barre `errores` por `usuario_id` y por `whatsapp`; estas filas nacen
     * sin ninguno de los dos porque todavía no sabíamos quién era, y desde el 02-sep-2026 llevan
     * ADEMÁS el texto que la persona escribió. Vincular es el instante exacto en que deja de ser
     * anónima, así que es el instante en que hay que engancharlas — la alternativa era meterle una
     * condición por BSUID al DELETE de esa función, o sea tocar lo más sensible del sistema para
     * agregar un camino nuevo cuando el que ya existe alcanza.
     *
     * Best-effort a propósito: si esto falla, la persona igual queda vinculada, que es lo único
     * que le importa a ella. Lo que se pierde queda en el log, no en silencio.
     */
    const adoptarErroresPrevios = async (usuarioId) => {
      const { error } = await supabase.from('errores')
        .update({ usuario_id: usuarioId }).eq('bsuid', bsuid).is('usuario_id', null);
      if (error) {
        log.error({ tag: 'OTP_BSUID', bsuid, usuarioId, err: error.message },
          'No se pudieron enganchar los errores previos: quedan sin usuario_id y fuera del borrado');
      }
    };

    // `esTest` viaja al llamador para que el aviso al admin pueda saltear los fixtures. Sin esto
    // un harness que le pegue al webhook de PRODUCCION —que es como se verifica este camino— le
    // manda un Telegram real a Favio en cada corrida. Es el falso positivo del 13-ago-2026, que ya
    // le costo al repo un aviso con el comando de un probe apuntando al celular de un desconocido.
    const salida = async (estado, fila, marcado) => {
      await adoptarErroresPrevios(fila.id);
      return {
        estado: marcado === false ? 'vinculada_sin_destrabar' : estado,
        usuarioId: fila.id, nombre: fila.nombre || otp.nombre, email: fila.email || otp.email,
        esTest: fila.is_test_user === true,
      };
    };

    // El BSUID ya es de esta misma cuenta web (reenvío del código, o un destrabe manual). Nada que
    // escribir sobre `usuarios`: solo quemar el código.
    if (webRow && filaBsuid && webRow.id === filaBsuid.id) {
      const m = await marcarVerificado(webRow.id);
      return await salida('ya_vinculada', webRow, m);
    }

    // Dos filas distintas → fusión atómica. `merge_and_link` rechaza los bordes inseguros (la fila
    // del BSUID ligada a OTRA cuenta Google, o un espacio/meta compartida entre ambas). El BSUID
    // sobrevive al merge sin ayuda de acá: la función lo preserva con `COALESCE(s.bsuid, l.bsuid)`.
    if (webRow && filaBsuid) {
      const { data: res, error: errMerge } = await supabase.rpc('merge_and_link', {
        p_survivor: webRow.id, p_loser: filaBsuid.id,
      });
      if (errMerge) {
        log.error({ tag: 'OTP_BSUID', bsuid, err: errMerge.message }, 'Error en merge_and_link');
        return { estado: 'error' };
      }
      if (res === 'conflict') {
        log.warn({ tag: 'OTP_BSUID', survivor: webRow.id, loser: filaBsuid.id }, 'Merge en conflicto → soporte');
        return { estado: 'conflicto', usuarioId: webRow.id, nombre: webRow.nombre || otp.nombre, email: webRow.email || otp.email, esTest: webRow.is_test_user === true };
      }
      if (res !== 'linked') {
        log.error({ tag: 'OTP_BSUID', bsuid, result: res }, 'merge_and_link resultado inesperado');
        return { estado: 'error' };
      }
      const m = await marcarVerificado(webRow.id);
      return await salida('fusionada', webRow, m);
    }

    // Hay cuenta web y el BSUID no es de nadie: el caso que motivó el módulo, y el que va a ser
    // normal de acá en más. Un usuario que llega ya con username nunca tuvo fila de WhatsApp que
    // fusionar.
    //
    // **El `.select('id')` no es cosmético.** Sin RETURNING, cero filas afectadas vuelve con la
    // MISMA forma que el éxito (`{data:null, error:null}`), y abajo se marcaría verificado un
    // vínculo que no se escribió: la persona quedaría con la web destrabada y el BSUID suelto, o
    // sea muda otra vez y sin código con el cual reintentar.
    if (webRow) {
      const { data: filas, error: errUpd } = await supabase.from('usuarios')
        .update({ bsuid, onboarding_completado: true }).eq('id', webRow.id).select('id');
      if (errUpd) {
        // 23505: el índice único parcial de `bsuid` (migración 065). Otra fila ya se lo quedó entre
        // la lectura y esta escritura. No se quema el código: el reintento funciona en cuanto la
        // carrera se resuelva, y quemarlo lo mandaría a generar otro que caería igual.
        log.error({ tag: 'OTP_BSUID', bsuid, usuarioId: webRow.id, code: errUpd.code, err: errUpd.message },
          'No se pudo escribir el BSUID en la cuenta web: no se confirma el vínculo ni se quema el código');
        return { estado: errUpd.code === '23505' ? 'conflicto' : 'error', usuarioId: webRow.id, esTest: webRow.is_test_user === true };
      }
      if (!filas || filas.length === 0) {
        log.warn({ tag: 'OTP_BSUID', bsuid, usuarioId: webRow.id },
          'El vínculo por BSUID no tocó NINGUNA fila: no se confirma ni se quema el código');
        return { estado: 'error', usuarioId: webRow.id };
      }
      const m = await marcarVerificado(webRow.id);
      return await salida('vinculada', webRow, m);
    }

    // La cuenta web no llegó a crear su fila (fallo de creación → fallback) pero el BSUID sí tiene
    // una: se vincula el auth directamente sobre ella, igual que el "link directo" del OTP normal.
    if (filaBsuid) {
      // **El borde que `merge_and_link` declara inseguro, y que esta rama NO puede saltearse por
      // no pasar por el RPC.** La función SQL corta con `'conflict'` cuando el loser ya tiene un
      // `supabase_auth_id` distinto del survivor (`migrations/072b`); acá el UPDATE lo pisaría sin
      // mirar. El caso vivo no es un ataque remoto —hay que escribir desde el BSUID de la víctima—
      // sino la persona que se loguea con un segundo Google y se auto-desvincula el primero, en
      // silencio. La rama `fusionada` respeta este corte porque delega en el RPC; ésta lo necesita
      // escrito. Lo encontró la revisión adversarial.
      if (filaBsuid.supabase_auth_id && filaBsuid.supabase_auth_id !== otp.supabase_auth_id) {
        log.warn({ tag: 'OTP_BSUID', bsuid, usuarioId: filaBsuid.id },
          'Ese WhatsApp ya pertenece a otra cuenta Google: no se pisa, va a soporte');
        return { estado: 'conflicto', usuarioId: filaBsuid.id, nombre: filaBsuid.nombre || otp.nombre, email: filaBsuid.email || otp.email, esTest: filaBsuid.is_test_user === true };
      }
      const { data: filas, error: errLink } = await supabase.from('usuarios').update({
        supabase_auth_id: otp.supabase_auth_id,
        email: otp.email || filaBsuid.email,
        nombre: filaBsuid.nombre || otp.nombre,
        onboarding_completado: true,
      }).eq('id', filaBsuid.id).select('id');
      if (errLink) {
        // 23505 acá es el índice del EMAIL: ese correo ya es de otra cuenta de WhatsApp. No se
        // marca verificado — con número esto se le contesta a la persona, y acá no hay canal.
        log.error({ tag: 'OTP_BSUID', bsuid, usuarioId: filaBsuid.id, code: errLink.code, err: errLink.message },
          'No se pudo vincular el auth sobre la fila del BSUID');
        return { estado: errLink.code === '23505' ? 'conflicto' : 'error', usuarioId: filaBsuid.id, esTest: filaBsuid.is_test_user === true };
      }
      if (!filas || filas.length === 0) {
        log.warn({ tag: 'OTP_BSUID', bsuid, usuarioId: filaBsuid.id }, 'El link directo no tocó NINGUNA fila');
        return { estado: 'error', usuarioId: filaBsuid.id };
      }
      const m = await marcarVerificado(filaBsuid.id);
      return await salida('adoptada', filaBsuid, m);
    }

    // Ni cuenta web ni fila del BSUID. El código era válido, así que la cuenta existía al
    // generarlo: entre eso y ahora la fila desapareció (una baja, un merge). No hay a qué vincular.
    log.warn({ tag: 'OTP_BSUID', bsuid, authId: otp.supabase_auth_id }, 'Código válido sin fila a la cual vincular');
    return { estado: 'sin_cuenta_web' };
  } catch (e) {
    log.error({ tag: 'OTP_BSUID', bsuid, err: e && e.message }, 'Error verificando cuenta web por BSUID');
    return { estado: 'error' };
  }
}

module.exports = { verificarCuentaWebPorBsuid };
