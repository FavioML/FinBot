'use client'

import posthog from 'posthog-js'
import { PostHogProvider as PHProvider, usePostHog } from 'posthog-js/react'
import { useEffect } from 'react'
import { createBrowserClient } from '@supabase/ssr'

function PostHogUserIdentifier() {
  const ph = usePostHog()

  useEffect(() => {
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    )

    supabase.auth.getUser().then(({ data }) => {
      if (data.user && ph) {
        ph.identify(data.user.id, {
          email: data.user.email,
          name: data.user.user_metadata?.full_name,
        })
      }
    })

    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session?.user && ph) {
        ph.identify(session.user.id, {
          email: session.user.email,
          name: session.user.user_metadata?.full_name,
        })
      }
      if (event === 'SIGNED_OUT' && ph) {
        ph.reset()
      }
    })

    return () => listener.subscription.unsubscribe()
  }, [ph])

  return null
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY
    if (!key) return

    posthog.init(key, {
      api_host: 'https://us.i.posthog.com',
      person_profiles: 'identified_only',
      capture_pageview: true,
      capture_pageleave: true,
    })
    posthog.register({ site: 'neto-app' })
  }, [])

  return (
    <PHProvider client={posthog}>
      <PostHogUserIdentifier />
      {children}
    </PHProvider>
  )
}
