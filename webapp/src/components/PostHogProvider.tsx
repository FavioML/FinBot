'use client'

import { useEffect } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import { track, EVENTS } from '@/lib/analytics'
import { getPerfilSesionSync } from '@/lib/supabase/session'
import { cuandoSeDesocupe } from '@/lib/desocupado'

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

      // El identify arranca CUANDO EL NAVEGADOR SE DESOCUPA, no al montar.
      //
      // Medido el 30-ago-2026 contra producción: esta consulta a `usuarios` llegó a
      // 3564 ms compitiendo con el arranque del dashboard, y era la petición más lenta
      // de la carga. Analytics no tiene ninguna urgencia — el `identify` sirve igual un
      // segundo después — pero sí tenía la prioridad de red de todo lo demás.
      //
      // El `authUserId` sale de la cookie y no de `getUser()`: ese `getUser()` era una
      // de las cuatro idas y vueltas a /auth/v1/user por carga. Verificar el JWT no
      // aporta acá; lo peor que hace alguien editando su propia cookie es ensuciar su
      // propio reporte de analytics. Ver `getPerfilSesionSync`.
      const perfil = getPerfilSesionSync()
      if (perfil) {
        cuandoSeDesocupe(() => {
          if (cancelado) return
          identifyNetoUser(perfil.authId, perfil.email ?? undefined, perfil.nombre ?? undefined)
        })
      }

      const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_IN' && session?.user) {
          identifyNetoUser(session.user.id, session.user.email, session.user.user_metadata?.full_name)
          track(EVENTS.WEBAPP_LOGGED_IN)
        }
        if (event === 'SIGNED_OUT') {
          yaIdentificado = false
          posthog.reset()
        }
      })

      cleanup = () => listener.subscription.unsubscribe()
      if (cancelado) cleanup()
    })

    return () => { cancelado = true; cleanup?.() }
  }, [])

  return <>{children}</>
}
