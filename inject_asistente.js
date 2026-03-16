const fs = require('fs');
let c = fs.readFileSync('C:/finbot/index.js', 'utf8').replace(/\r\n/g, '\n');

const FN = 
// =================================================================
// ASISTENTE FINANCIERO CONVERSACIONAL
// Responde preguntas en lenguaje natural sobre los gastos del usuario
// =================================================================
async function asistenteFinanciero(pregunta, usuario) {
  try {
    // Obtener contexto financiero del usuario
    const hoy = new Date();
    const primero = new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString().split('T')[0];
    const hace7 = new Date(Date.now() - 7*24*60*60*1000).toISOString().split('T')[0];

    const { data: txsMes } = await supabase.from('transacciones').select('*')
      .eq('usuario_id', usuario.id).eq('tipo', 'gasto').gte('fecha', primero)
      .order('fecha', { ascending: false });
    const { data: txsSemana } = await supabase.from('transacciones').select('*')
      .eq('usuario_id', usuario.id).eq('tipo', 'gasto').gte('fecha', hace7)
      .order('fecha', { ascending: false });

    const totalMes = (txsMes||[]).reduce((s,t)=>s+parseFloat(t.monto),0);
    const totalSemana = (txsSemana||[]).reduce((s,t)=>s+parseFloat(t.monto),0);

    // Resumen por categoria del mes
    const porCatMes = {};
    (txsMes||[]).forEach(t => {
      const k = t.subcategoria ? t.categoria+' > '+t.subcategoria : (t.categoria||'Otro');
      porCatMes[k] = (porCatMes[k]||0) + parseFloat(t.monto);
    });
    const resumenCats = Object.entries(porCatMes).sort((a,b)=>b[1]-a[1]).map(([k,v]) => k+': S/'+v.toFixed(2)).join(', ');

    // Ultimas 10 transacciones
    const ultimas = (txsMes||[]).slice(0,10).map(t =>
      t.fecha+' | '+(t.comercio||t.banco||'Sin nombre')+' | S/'+t.monto+' | '+(t.subcategoria?t.categoria+'>'+t.subcategoria:t.categoria||'Otro')
    ).join('; ');

    const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : 'el usuario';
    const mesNombre = hoy.toLocaleString('es-PE', { month: 'long', year: 'numeric' });

    const ctx = 'Eres FinBot, asistente de finanzas personales de '+primerNombre+' via WhatsApp. ' +
      'Datos de '+mesNombre+': total gastado S/'+totalMes.toFixed(2)+' en '+((txsMes||[]).length)+' transacciones. ' +
      'Esta semana: S/'+totalSemana.toFixed(2)+'. ' +
      'Por categoria: '+resumenCats+'. ' +
      'Ultimas transacciones: '+ultimas+'. ' +
      'Responde en espanol, de forma concisa (max 5 lineas), usa *negrita* para numeros importantes. ' +
      'Si el usuario pide el resumen, dalo. Si pregunta por una categoria especifica, detallala. ' +
      'No inventes datos que no tienes. Si no hay datos suficientes, dilo.';

    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: ctx },
        { role: 'user', content: pregunta }
      ],
      temperature: 0.3,
      max_tokens: 300
    });
    return res.choices[0].message.content.trim();
  } catch(e) {
    console.error('[ASISTENTE] Error:', e.message);
    return 'Ups, no pude procesar tu consulta. Prueba con */mes* o */semana*.';
  }
}
// =================================================================

;

const ANCHOR = "app.post('/webhook'";
if (!c.includes(ANCHOR)) { console.error('ANCHOR NOT FOUND'); process.exit(1); }
c = c.substring(0, c.indexOf(ANCHOR)) + FN + c.substring(c.indexOf(ANCHOR));
console.log('Funcion inyectada OK');

fs.writeFileSync('C:/finbot/index.js', c.replace(/\n/g, '\r\n'), 'utf8');

// Verificar sintaxis
const { execSync } = require('child_process');
try {
  execSync('node --check C:/finbot/index.js', {stdio:'pipe'});
  console.log('SINTAXIS OK - lineas:', c.split('\n').length);
} catch(e) {
  console.error('SINTAXIS ERROR:', e.stderr.toString().substring(0,200));
  process.exit(1);
}