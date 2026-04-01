'use client'

import posthog from 'posthog-js'
import { PostHogProvider as PHProvider } from 'posthog-js/react'
import { useEffect } from 'react'

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    posthog.init('phc_oWcB57kywdubiAVa2ewYF32YBDFzgPxMoKWPQaPuE8Jb', {
      api_host: 'https://us.i.posthog.com',
      person_profiles: 'identified_only',
      capture_pageview: true,
      capture_pageleave: true,
    })
    posthog.register({ site: 'neto-landing' })
  }, [])

  return <PHProvider client={posthog}>{children}</PHProvider>
}
