import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/rate-limit';

const serviceClient = createSupabaseClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function getNetoUserId() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await serviceClient
    .from('usuarios')
    .select('id')
    .eq('supabase_auth_id', user.id)
    .single();
  return data?.id || null;
}

export async function POST(request: Request) {
  const userId = await getNetoUserId();
  if (!userId)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Consejo IA es Pro-only
  const { data: usuario } = await serviceClient
    .from('usuarios')
    .select('plan')
    .eq('id', userId)
    .single();
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
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('OpenAI error:', err);
      return NextResponse.json({ error: 'AI request failed' }, { status: 502 });
    }

    const data = await response.json();
    const advice = data.choices?.[0]?.message?.content?.trim() || '';

    return NextResponse.json({ advice });
  } catch (error) {
    console.error('AI advice error:', error);
    return NextResponse.json({ error: 'AI request failed' }, { status: 500 });
  }
}
