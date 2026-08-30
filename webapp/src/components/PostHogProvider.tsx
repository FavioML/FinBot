'use client'

import { useEffect } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import { track, EVENTS } from '@/lib/analytics'
import { getPerfilSesionSync } from '@/lib/supabase/session'
import { cuandoSeDesocupe } from '@/lib/desocupado'
import { alSaberIdNeto, olvidarIdNeto } from '@/lib/analytics/identidad-neto'

// Project API key de PostHog (pública por diseño: va en el bundle cliente,
// igual que en la landing). El env var de Vercel la puede sobreescribir.
const POSTHOG_PUBLIC_KEY = 'phc_oWcB57kywdubiAVa2ewYF32YBDFzgPxMoKWPQaPuE8Jb'

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    let cleanup: (() => void) | undefined
    // `cleanup` se asigna DENTRO del `.then()` del import dinámico, así que un desmontaje
    // anterior a que resuelva ese import corre el return de abajo con `cleanup` todavía
    // undefined: la suscripción a `onAuthStateChange` nace después, huérfana, y nadie la
    // desuscribe. `cancelado` cierra las dos puntas — no suscribe si ya se desmontó, y si
    // llegó a suscribir igual (carrera), desuscribe en el acto.
    let cancelado = false
    // Se asignan dentro del `.then()`, igual que `cleanup`, y por el mismo motivo se
    // limpian en el return: si no, la suscripción al id y el temporizador sobreviven al
    // desmontaje.
    let desuscribirId: (() => void) | undefined
    let timerIdentify: number | undefined

    // Defer posthog-js (~170 KB) fuera del First Load crítico: se carga vía
    // dynamic import DESPUÉS de la hidratación, así nunca bloquea el render
    // inicial. El singleton se comparte con lib/analytics.ts.
    import('posthog-js').then(({ default: posthog }) => {
      const key = process.env.NEXT_PUBLIC_POSTHOG_KEY || POSTHOG_PUBLIC_KEY
      if (!key) return

      posthog.init(key, {
        api_host: 'https://us.i.posthog.com',
        person_profiles: 'identified_only',
        capture_pageview: 'history_change',
        capture_pageleave: true,
        // Funnel dirigido, no autocapture indiscriminado.
        autocapture: false,
        // Consent ligero: respetar Do Not Track del navegador.
        respect_dnt: true,
        // App financiera: enmascarar TODO el texto e inputs en session replay.
        // Se ve layout, clics, navegación y drop-off, nunca una cifra.
        session_recording: { maskAllInputs: true, maskTextSelector: '*' },
      })
      posthog.register({ site: 'neto-app' })

      const supabase = createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
      )

      // Identifica con el id de la tabla `usuarios` (mismo distinct_id que el
      // backend de WhatsApp) para que el funnel stitchee landing -> WhatsApp ->
      // webapp por una sola identidad, no por el supabase auth id.
      //
      // Una sola vez por carga. `onAuthStateChange` también emite SIGNED_IN al
      // restaurar una sesión existente, así que sin este flag la MISMA identificación
      // salía dos veces y con ella su consulta a `usuarios`.
      let yaIdentificado = false

      function identificarCon(idNeto: string, authUserId: string, email?: string, name?: string) {
        if (yaIdentificado) return
        yaIdentificado = true
        posthog.identify(idNeto, { email, name, supabase_auth_id: authUserId })
      }

      async function identifyNetoUser(authUserId: string, email?: string, name?: string) {
        if (yaIdentificado) return
        yaIdentificado = true
        try {
          // maybeSingle (not single): corre en cada carga sin gate y puede
          // ganarle a la propagación del token de auth; RLS devuelve 0 filas y
          // single() responde 406 (visible en consola aunque el catch trague el
          // error JS). maybeSingle() devuelve null sin 406.
          const { data } = await supabase
            .from('usuarios')
            .select('id')
            .eq('supabase_auth_id', authUserId)
            .maybeSingle()
          if (data?.id) {
            posthog.identify(String(data.id), { email, name, supabase_auth_id: authUserId })
          } else {
            // No hay fila: que un SIGNED_IN posterior pueda reintentar. Es el caso del
            // alta web-first, donde la fila de `usuarios` nace después de la sesión.
            yaIdentificado = false
          }
        } catch {
          yaIdentificado = false
          /* noop — analytics jamás debe romper el login */
        }
      }

      // Quién está autenticado AHORA. Sale de la COOKIE y no de `getUser()`: ese
      // `getUser()` era una de las cuatro idas y vueltas a /auth/v1/user por carga.
      // Verificar el JWT no aporta acá; lo peor que hace alguien editando su propia
      // cookie es ensuciar su propio reporte de analytics. Ver `getPerfilSesionSync`.
      //
      // Es mutable porque un SIGNED_IN posterior la pisa: sin eso, un cierre de sesión
      // seguido de otro ingreso en la misma pestaña identificaría a la persona nueva con
      // el `supabase_auth_id` de la anterior.
      let authActual = getPerfilSesionSync()
      // `perfil` congela si HABÍA sesión al montar. Lo lee el SIGNED_IN de abajo para
      // distinguir una restauración de un ingreso desde anónimo.
      const perfil = authActual

      // En el dashboard el `usuarios.id` lo publica el bootstrap, que ya lo trajo en
      // /api/dashboard: ahí este identify no cuesta NINGUNA petición. Fuera del
      // dashboard (login, onboarding, /join) nadie publica y se cae a la consulta, ya
      // sin prisa. Ver `lib/analytics/identidad-neto` para por qué esto es un canal y
      // no un parámetro, y por qué diferir la consulta no alcanzaba.

      if (perfil) {
        const porConsulta = () => {
          if (cancelado || !authActual) return
          identifyNetoUser(authActual.authId, authActual.email ?? undefined, authActual.nombre ?? undefined)
        }

        desuscribirId = alSaberIdNeto((idNeto) => {
          if (cancelado || !authActual) return
          identificarCon(idNeto, authActual.authId, authActual.email ?? undefined, authActual.nombre ?? undefined)
        })

        // El fallback tiene que existir igual: fuera del dashboard nadie publica nunca,
        // y adentro el bootstrap puede fallar (402 del muro, red caída). Sin esto, esas
        // sesiones quedarían sin identificar.
        //
        // Pero en el dashboard NO puede ser `requestIdleCallback`: el navegador se
        // desocupa justamente mientras espera la red, así que el hueco llega a los
        // ~1000 ms y la consulta vuelve a caer dentro del arranque, que es lo que este
        // rodeo viene a evitar. Ahí va un temporizador largo, que solo llega a correr
        // si el bootstrap no publicó nunca.
        if (window.location.pathname.startsWith('/dashboard')) {
          timerIdentify = window.setTimeout(porConsulta, 15000)
        } else {
          cuandoSeDesocupe(porConsulta)
        }
      }

      const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_IN' && session?.user) {
          authActual = {
            authId: session.user.id,
            email: session.user.email ?? null,
            nombre: (session.user.user_metadata?.full_name as string | undefined) ?? null,
            avatarUrl: null,
          }
          // Con `perfil` la cookie YA tenía sesión al montar, así que este SIGNED_IN es
          // una restauración: el identify lo resuelve la suscripción al id publicado (o
          // su temporizador). Consultar acá volvería a meter la consulta a `usuarios`
          // dentro del arranque, que es lo que todo este rodeo evita. Sin `perfil` es un
          // ingreso desde anónimo — ahí no hay bootstrap con el que competir.
          if (!perfil) {
            identifyNetoUser(session.user.id, session.user.email, session.user.user_metadata?.full_name)
          }
          track(EVENTS.WEBAPP_LOGGED_IN)
        }
        if (event === 'SIGNED_OUT') {
          yaIdentificado = false
          authActual = null
          olvidarIdNeto()
          posthog.reset()
        }
      })

      cleanup = () => listener.subscription.unsubscribe()
      if (cancelado) cleanup()
    })

    return () => {
      cancelado = true
      cleanup?.()
      desuscribirId?.()
      if (timerIdentify !== undefined) window.clearTimeout(timerIdentify)
    }
  }, [])

  return <>{children}</>
}
