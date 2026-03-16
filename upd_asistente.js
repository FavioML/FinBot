const fs = require('fs');
let c = fs.readFileSync('C:/finbot/index.js', 'utf8').replace(/\r\n/g, '\n');

const OLD_FN = c.substring(c.indexOf('// ASISTENTE FINANCIERO'), c.indexOf('// =================================================================\n\napp.post'));

const NEW_FN = // ASISTENTE FINANCIERO CONVERSACIONAL
// Responde preguntas en lenguaje natural sobre gastos, categorias, presupuestos
// =================================================================
async function asistenteFinanciero(pregunta, usuario) {
  try {
    const hoy = new Date();
    const primero = new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString().split('T')[0];
    const hace7 = new Date(Date.now() - 7*24*60*60*1000).toISOString().split('T')[0];
    const mesNombre = hoy.toLocaleString('es-PE', { month: 'long', year: 'numeric' });
    const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : 'el usuario';

    // Todas las transacciones del mes (sin limite)
    const { data: txsMes } = await supabase.from('transacciones').select('*')
      .eq('usuario_id', usuario.id).eq('tipo', 'gasto').gte('fecha', primero)
      .order('fecha', { ascending: false });

    // Transacciones de la semana
    const { data: txsSemana } = await supabase.from('transacciones').select('*')
      .eq('usuario_id', usuario.id).eq('tipo', 'gasto').gte('fecha', hace7)
      .order('fecha', { ascending: false });

    // Presupuestos del mes con gasto real
    const { data: presups } = await supabase.from('presupuestos').select('*')
      .eq('usuario_id', usuario.id).eq('mes', hoy.getMonth()+1).eq('anio', hoy.getFullYear());

    // Total por categoria Y subcategoria del mes
    const porCatMes = {};
    const porSubMes = {};
    (txsMes||[]).forEach(t => {
      const cat = t.categoria || 'Otro';
      porCatMes[cat] = (porCatMes[cat]||0) + parseFloat(t.monto);
      if (t.subcategoria) {
        const key = cat + ' > ' + t.subcategoria;
        porSubMes[key] = (porSubMes[key]||0) + parseFloat(t.monto);
      }
    });
    const totalMes = (txsMes||[]).reduce((s,t)=>s+parseFloat(t.monto),0);
    const totalSemana = (txsSemana||[]).reduce((s,t)=>s+parseFloat(t.monto),0);

    // Resumen categorias
    const resumenCats = Object.entries(porCatMes).sort((a,b)=>b[1]-a[1])
      .map(([k,v]) => k+': S/'+v.toFixed(2)).join(', ');

    // Resumen subcategorias
    const resumenSubs = Object.keys(porSubMes).length > 0
      ? Object.entries(porSubMes).sort((a,b)=>b[1]-a[1]).map(([k,v]) => k+': S/'+v.toFixed(2)).join(', ')
      : 'sin subcategorias registradas aun';

    // Presupuestos con estado
    const resumenPresups = (presups||[]).length > 0
      ? (presups||[]).map(p => {
          const gastado = porCatMes[p.categoria] || 0;
          const limite = parseFloat(p.monto_limite);
          const pct = ((gastado/limite)*100).toFixed(0);
          const sub = p.subcategoria ? ' > '+p.subcategoria : '';
          return p.categoria+sub+': gastado S/'+gastado.toFixed(2)+' de limite S/'+limite.toFixed(2)+' ('+pct+'%)';
        }).join(', ')
      : 'sin presupuestos configurados';

    // Lista completa de transacciones del mes
    const listaTxs = (txsMes||[]).map(t =>
      t.fecha+'|'+(t.comercio||t.banco||'Sin nombre')+'|S/'+parseFloat(t.monto).toFixed(2)+'|'+(t.categoria||'Otro')+(t.subcategoria?'>'+t.subcategoria:'')
    ).join('; ');

    const ctx = 'Eres FinBot Peru, asistente de finanzas de '+primerNombre+' por WhatsApp. '+
      'Responde en espanol, conciso (max 8 lineas), usa *negrita* para numeros clave. '+
      'Datos de '+mesNombre+':\\n'+
      '- Total gastado: S/'+totalMes.toFixed(2)+' en '+((txsMes||[]).length)+' transacciones\\n'+
      '- Esta semana: S/'+totalSemana.toFixed(2)+' en '+((txsSemana||[]).length)+' transacciones\\n'+
      '- Por categoria: '+resumenCats+'\\n'+
      '- Por subcategoria: '+resumenSubs+'\\n'+
      '- Presupuestos: '+resumenPresups+'\\n'+
      '- Todas las transacciones: '+listaTxs+'\\n'+
      'Si no tienes datos para responder algo, dilo claramente. No inventes cifras.';

    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: ctx },
        { role: 'user', content: pregunta }
      ],
      temperature: 0.3,
      max_tokens: 400
    });
    return res.choices[0].message.content.trim();
  } catch(e) {
    console.error('[ASISTENTE] Error:', e.message);
    return 'No pude procesar tu consulta. Prueba con */mes* o */semana*.';
  }
}
;

if (!c.includes('// ASISTENTE FINANCIERO')) { console.error('ASISTENTE NOT FOUND'); process.exit(1); }
c = c.replace(OLD_FN, NEW_FN);
console.log('Funcion reemplazada OK');

fs.writeFileSync('C:/finbot/index.js', c.replace(/\n/g, '\r\n'), 'utf8');
const { execSync } = require('child_process');
try {
  execSync('node --check C:/finbot/index.js', {stdio:'pipe'});
  console.log('SINTAXIS OK - lineas:', c.split('\n').length);
} catch(e) {
  console.error('ERROR:', e.stderr.toString().substring(0,300));
  process.exit(1);
}