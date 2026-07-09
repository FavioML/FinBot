import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/supabase/service';
import { NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/rate-limit';

// La llamada a OpenAI puede colgarse; sin un límite de duración la función
// serverless se mata sola y Vercel lo reporta como 502 intermitente. El fetch
// aborta a los 12s (ver OPENAI_TIMEOUT_MS), dentro de este margen.
export const maxDuration = 20;

const OPENAI_TIMEOUT_MS = 12_000;

async function getNetoUserId() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // maybeSingle: el usuario auth puede no tener fila en `usuarios`. single()
  // devuelve 406 con 0 filas; maybeSingle() devuelve null y lo tratamos como null.
  const { data } = await getServiceClient()
    .from('usuarios')
    .select('id')
    .eq('supabase_auth_id', user.id)
    .maybeSingle();
  return data?.id || null;
}

export async function POST(request: Request) {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Consejo IA es Pro-only
  const { data: usuario } = await getServiceClient()
    .from('usuarios')
    .select('plan')
    .eq('id', userId)
    .maybeSingle();
  if (usuario?.plan !== 'premium') {
    return NextResponse.json({ error: 'Pro only', upsell: 'Recibe consejos IA diarios con Pro' }, { status: 403 });
  }

  if (!checkRateLimit(userId, 10)) {
    return NextResponse.json({ error: 'Demasiadas solicitudes' }, { status: 429 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'AI not configured' }, { status: 503 });
  }

  const body = await request.json();

  // Sanitizar inputs para prevenir prompt injection
  const totalGastos = Math.round(Number(body.totalGastos) || 0);
  const totalIngresos = Math.round(Number(body.totalIngresos) || 0);
  const scoreFinanciero = Math.min(100, Math.max(0, Math.round(Number(body.scoreFinanciero) || 0)));
  const topCategorias = typeof body.topCategorias === 'string'
    ? body.topCategorias.slice(0, 200).replace(/[^\w\sáéíóúñÁÉÍÓÚÑ,.:%-]/gi, '')
    : 'Sin datos';
  const subscriptionTotal = Math.round(Number(body.subscriptionTotal) || 0);

  const prompt = `Eres NETO, un asistente financiero personal para jóvenes peruanos. Analiza estos datos del mes y da UN consejo específico, accionable y motivador en máximo 2 oraciones. Usa moneda soles (S/). Sé directo y amigable, tutea al usuario.

Datos del mes:
- Ingresos: S/${totalIngresos}
- Gastos: S/${totalGastos}
- Ahorro: S/${totalIngresos - totalGastos}
- Score financiero: ${scoreFinanciero}/100
- Top categorías de gasto: ${topCategorias}
${subscriptionTotal ? `- Suscripciones mensuales: S/${subscriptionTotal}` : ''}

Responde SOLO con el consejo, sin introducciones ni explicaciones.`;

  // Aborta el fetch a OpenAI si tarda demasiado, para responder con un error
  // controlado en vez de dejar que la función serverless expire (502 de Vercel).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 150,
        temperature: 0.7,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('OpenAI error:', response.status, err);
      // 503: dependencia externa caída/lenta. Es un fallo transitorio de un
      // upstream, no un gateway roto de nuestra función.
      return NextResponse.json({ error: 'AI temporarily unavailable' }, { status: 503 });
    }

    const data = await response.json();
    const advice = data.choices?.[0]?.message?.content?.trim() || '';

    return NextResponse.json({ advice });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.error('OpenAI advice timeout after', OPENAI_TIMEOUT_MS, 'ms');
      return NextResponse.json({ error: 'AI timed out' }, { status: 504 });
    }
    console.error('AI advice error:', error);
    return NextResponse.json({ error: 'AI request failed' }, { status: 500 });
  } finally {
    clearTimeout(timeout);
  }
}
