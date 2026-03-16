const fs = require('fs');
let c = fs.readFileSync('C:/finbot/index.js', 'utf8').replace(/\r\n/g,'\n');

const idxFn = c.indexOf('async function asistenteFinanciero');
const idxWebhook = c.indexOf("\napp.post('/webhook'");
const oldFn = c.substring(idxFn, idxWebhook);

const newFn = `async function asistenteFinanciero(pregunta, usuario) {
  try {
    const hoy = new Date();
    const primero = new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString().split('T')[0];
    const hace7 = new Date(Date.now() - 7*24*60*60*1000).toISOString().split('T')[0];
    const mesNombre = hoy.toLocaleString('es-PE', { month: 'long', year: 'numeric' });
    const primerNombre = usuario.nombre ? usuario.nombre.split(' ')[0] : 'el usuario';

    // Todas las transacciones del mes
    const { data: txsMes } = await supabase.from('transacciones').select('*')
      .eq('usuario_id', usuario.id).gte('fecha', primero).order('fecha', { ascending: false });
    // Transacciones de la semana
    const { data: txsSemana } = await supabase.from('transacciones').select('*')
      .eq('usuario_id', usuario.id).gte('fecha', hace7).order('fecha', { ascending: false });
    // Presupuestos del mes
    const { data: presups } = await supabase.from('presupuestos').select('*')
      .eq('usuario_id', usuario.id).eq('mes', hoy.getMonth()+1).eq('anio', hoy.getFullYear());

    const gastosMes = (txsMes||[]).filter(t=>t.tipo==='gasto');
    const ingresosMes = (txsMes||[]).filter(t=>t.tipo==='ingreso');
    const totalGastoMes = gastosMes.reduce((s,t)=>s+parseFloat(t.monto),0);
    const totalIngresoMes = ingresosMes.reduce((s,t)=>s+parseFloat(t.monto),0);
    const totalGastoSemana = (txsSemana||[]).filter(t=>t.tipo==='gasto').reduce((s,t)=>s+parseFloat(t.monto),0);

    // Resumen por categoria
    const porCat = {};
    gastosMes.forEach(t => { const k=t.categoria||'Otro'; porCat[k]=(porCat[k]||0)+parseFloat(t.monto); });

    // Resumen por subcategoria
    const porSub = {};
    gastosMes.filter(t=>t.subcategoria).forEach(t => {
      const k=t.categoria+' > '+t.subcategoria; porSub[k]=(porSub[k]||0)+parseFloat(t.monto);
    });

    // Presupuestos con estado actual
    const ctxPresups = (presups||[]).length > 0
      ? (presups||[]).map(p => {
          const cat = p.subcategoria ? p.categoria+'>'+p.subcategoria : p.categoria;
          const gastado = p.subcategoria
            ? gastosMes.filter(t=>t.categoria===p.categoria&&t.subcategoria===p.subcategoria).reduce((s,t)=>s+parseFloat(t.monto),0)
            : (porCat[p.categoria]||0);
          const pct = p.monto_limite > 0 ? ((gastado/parseFloat(p.monto_limite))*100).toFixed(0) : 0;
          return cat+': gastado S/'+gastado.toFixed(2)+' / limite S/'+parseFloat(p.monto_limite).toFixed(2)+' ('+pct+'%, alerta al '+(p.alerta_porcentaje||80)+'%)';
        }).join(' | ')
      : 'sin presupuestos configurados este mes';

    // Lista completa de transacciones
    const listaTxs = gastosMes.map(t =>
      t.fecha+'|'+(t.comercio||t.banco||'Sin nombre')+'|S/'+parseFloat(t.monto).toFixed(2)+'|'+(t.categoria||'Otro')+(t.subcategoria?'>'+t.subcategoria:'')
    ).join('; ');

    const resumenCats = Object.entries(porCat).sort((a,b)=>b[1]-a[1]).map(([k,v])=>k+':S/'+v.toFixed(2)).join(', ');
    const resumenSubs = Object.entries(porSub).sort((a,b)=>b[1]-a[1]).map(([k,v])=>k+':S/'+v.toFixed(2)).join(', ')||'ninguna aun';

    const ctx = 'Eres FinBot Peru, asistente financiero de '+primerNombre+' por WhatsApp. '+
      'Responde en espanol, de forma concisa (max 8 lineas). Usa *negrita* para montos importantes. '+
      'Datos de '+mesNombre+':\\n'+
      'Total gastos: S/'+totalGastoMes.toFixed(2)+' ('+gastosMes.length+' transacciones)\\n'+
      'Total ingresos: S/'+totalIngresoMes.toFixed(2)+'\\n'+
      'Gastos esta semana: S/'+totalGastoSemana.toFixed(2)+'\\n'+
      'Por categoria: '+resumenCats+'\\n'+
      'Por subcategoria: '+resumenSubs+'\\n'+
      'Presupuestos y limites: '+ctxPresups+'\\n'+
      'Detalle transacciones (fecha|comercio|monto|categoria>subcategoria): '+listaTxs;

    const aiRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: ctx }, { role: 'user', content: pregunta }],
      temperature: 0.3,
      max_tokens: 400
    });
    return aiRes.choices[0].message.content.trim();
  } catch(e) {
    console.error('[ASISTENTE] Error:', e.message);
    return 'No pude procesar tu consulta. Prueba con */mes* o */semana*.';
  }
}

`;

c = c.substring(0, idxFn) + newFn + c.substring(idxWebhook);
console.log('Funcion reemplazada OK');

fs.writeFileSync('C:/finbot/index.js', c.replace(/\n/g,'\r\n'), 'utf8');
const { execSync } = require('child_process');
try {
  execSync('node --check C:/finbot/index.js', {stdio:'pipe'});
  console.log('SINTAXIS OK - lineas:', c.split('\n').length);
} catch(e) { console.error('ERROR:', e.stderr.toString().substring(0,300)); process.exit(1); }