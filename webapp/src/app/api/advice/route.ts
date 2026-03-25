import { createClient } from '@/lib/supabase/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

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

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'AI not configured' }, { status: 503 });
  }

  const body = await request.json();
  const { totalGastos, totalIngresos, topCategorias, scoreFinanciero, subscriptionTotal } = body;

  const prompt = `Eres NETO, un asistente financiero personal para jóvenes peruanos. Analiza estos datos del mes y da UN consejo específico, accionable y motivador en máximo 2 oraciones. Usa moneda soles (S/). Sé directo y amigable, tutea al usuario.

Datos del mes:
- Ingresos: S/${Math.round(totalIngresos || 0)}
- Gastos: S/${Math.round(totalGastos || 0)}
- Ahorro: S/${Math.round((totalIngresos || 0) - (totalGastos || 0))}
- Score financiero: ${scoreFinanciero || 0}/100
- Top categorías de gasto: ${topCategorias || 'Sin datos'}
${subscriptionTotal ? `- Suscripciones mensuales: S/${Math.round(subscriptionTotal)}` : ''}

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
