'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Crown, Copy, Check, Upload, Loader2, Clock, ShieldCheck, Mail, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FadeIn } from '@/components/shared/motion-wrapper';
import { HeaderActions } from '@/components/dashboard/topbar';

const YAPE_NUMERO = '970398192';
const YAPE_NOMBRE = 'Favio Mendoza';
const PRECIOS = { mensual: 10, anual: 99 } as const;

type Plan = 'mensual' | 'anual';
type Banco = { id: string; label: string };

interface ProStatus {
  plan: string;
  isPremium: boolean;
  pagoPendiente: boolean;
  premiumVence: string | null;
  ultimoPago: { estado: string; tipoPlan: string } | null;
}

export default function ProPage() {
  const { data: status, isLoading, refetch } = useQuery<ProStatus>({
    queryKey: ['pro-status'],
    queryFn: async () => {
      const r = await fetch('/api/pro/status', { cache: 'no-store' });
      if (!r.ok) throw new Error('status');
      return r.json();
    },
    refetchInterval: (q) => (q.state.data?.pagoPendiente ? 5000 : false),
  });

  const pendiente = !!status?.pagoPendiente || status?.ultimoPago?.estado === 'pendiente';
  const rechazado = status?.ultimoPago?.estado === 'rechazado' && !pendiente && !status?.isPremium;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-6 w-6 animate-spin text-[#1D9E75]" />
      </div>
    );
  }

  return (
    <FadeIn>
      <div className="space-y-6 max-w-2xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[#F0EFE8] flex items-center gap-2">
              <Crown className="h-6 w-6" style={{ color: '#68dbae' }} /> Neto Pro
            </h1>
            <p className="text-sm text-[#8A877D] mt-1">Todo el potencial de Neto, sin fricción</p>
          </div>
          <HeaderActions />
        </div>

        {status?.isPremium ? (
          <PremiumState premiumVence={status.premiumVence} />
        ) : pendiente ? (
          <PendingState onRefresh={() => refetch()} />
        ) : (
          <UpgradeFlow rejected={rechazado} onDone={() => refetch()} />
        )}
      </div>
    </FadeIn>
  );
}

function PremiumState({ premiumVence }: { premiumVence: string | null }) {
  const [connecting, setConnecting] = useState(false);

  async function connectGmail() {
    setConnecting(true);
    try {
      const r = await fetch('/api/pro/gmail-auth-url', { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || 'No se pudo generar el enlace');
      window.location.href = j.url;
    } catch (e) {
      toast.error((e as Error).message);
      setConnecting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="glass-card glass-card-glow p-6 text-center space-y-3">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-[#1D9E75]/15 border border-[#1D9E75]/30">
          <ShieldCheck className="w-7 h-7 text-[#1D9E75]" />
        </div>
        <h2 className="text-xl font-bold text-[#F0EFE8]">Ya eres Neto Pro ⭐</h2>
        {premiumVence && (
          <p className="text-sm text-[#8A877D]">
            Tu plan está activo hasta el{' '}
            {new Date(premiumVence + 'T12:00:00').toLocaleDateString('es-PE', { day: 'numeric', month: 'long', year: 'numeric' })}
          </p>
        )}
      </div>

      <div className="glass-card p-5 space-y-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 inline-flex items-center justify-center w-9 h-9 rounded-lg bg-[#1D9E75]/10">
            <Mail className="w-5 h-5 text-[#1D9E75]" />
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-[#F0EFE8]">Siguiente paso: conecta tu Gmail</h3>
            <p className="text-xs text-[#8A877D] mt-0.5">
              Neto lee automáticamente tus notificaciones bancarias por correo. Solo lectura de esos avisos, sin
              contraseñas bancarias.
            </p>
          </div>
        </div>
        <Button
          onClick={connectGmail}
          disabled={connecting}
          className="w-full bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90"
        >
          {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Conectar mi Gmail'}
        </Button>
      </div>
    </div>
  );
}

function PendingState({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div className="glass-card glass-card-glow p-6 text-center space-y-3">
      <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-[#EF9F27]/15 border border-[#EF9F27]/30">
        <Clock className="w-7 h-7 text-[#EF9F27]" />
      </div>
      <h2 className="text-xl font-bold text-[#F0EFE8]">Estamos verificando tu pago</h2>
      <p className="text-sm text-[#8A877D]">
        Recibimos tu comprobante. Apenas lo validemos, activamos tu Pro y te avisamos aquí y por WhatsApp. Suele tomar
        pocos minutos.
      </p>
      <button onClick={onRefresh} className="text-xs text-[#1D9E75] hover:underline">
        Actualizar estado
      </button>
    </div>
  );
}

function UpgradeFlow({ rejected, onDone }: { rejected: boolean; onDone: () => void }) {
  const [plan, setPlan] = useState<Plan>('mensual');
  const [copied, setCopied] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [bancosOpen, setBancosOpen] = useState(false);
  const [todos, setTodos] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: bancos = [] } = useQuery<Banco[]>({
    queryKey: ['pro-bancos'],
    queryFn: async () => {
      const r = await fetch('/api/pro/bancos', { cache: 'no-store' });
      const j = await r.json();
      return j.bancos || [];
    },
  });

  useEffect(() => {
    return () => { if (preview) URL.revokeObjectURL(preview); };
  }, [preview]);

  const monto = PRECIOS[plan];

  function copyNumero() {
    navigator.clipboard.writeText(YAPE_NUMERO);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function onPickFile(f: File | null) {
    if (preview) URL.revokeObjectURL(preview);
    setFile(f);
    setPreview(f ? URL.createObjectURL(f) : null);
  }

  function toggleBanco(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const bancosLabel = useMemo(() => {
    if (todos) return 'Todos mis bancos';
    if (selected.size === 0) return 'Ningún banco seleccionado';
    return `${selected.size} banco${selected.size > 1 ? 's' : ''}`;
  }, [todos, selected]);

  async function submit() {
    if (!file) {
      toast.error('Sube la captura de tu Yape');
      return;
    }
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('comprobante', file);
      fd.append('tipo_plan', plan);
      fd.append('bancos', todos ? 'todos' : Array.from(selected).join(','));
      const r = await fetch('/api/pro/solicitud', { method: 'POST', body: fd });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || 'No se pudo enviar');
      toast.success('¡Comprobante enviado! Estamos verificando tu pago.');
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-5">
      {rejected && (
        <div className="glass-card p-4 border border-[#D85A30]/30 bg-[#D85A30]/5">
          <p className="text-sm text-[#D85A30]">
            No pudimos validar tu comprobante anterior. Revisa que el Yape sea de S/{monto} a {YAPE_NOMBRE} y vuelve a
            enviarlo.
          </p>
        </div>
      )}

      {/* Paso 1: plan */}
      <div className="glass-card p-5 space-y-3">
        <p className="text-xs uppercase tracking-wider text-[#8A877D]">1. Elige tu plan</p>
        <div className="grid grid-cols-2 gap-3">
          {(['mensual', 'anual'] as Plan[]).map((p) => (
            <button
              key={p}
              onClick={() => setPlan(p)}
              className={`rounded-xl border p-4 text-left transition-all ${
                plan === p
                  ? 'border-[#1D9E75] bg-[#1D9E75]/10 ring-1 ring-[#1D9E75]/40'
                  : 'border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] hover:bg-[rgba(255,255,255,0.05)]'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-[#F0EFE8] capitalize">{p}</span>
                {p === 'anual' && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[#EF9F27]/15 text-[#EF9F27] font-medium">
                    2 meses gratis
                  </span>
                )}
              </div>
              <p className="mt-1 text-lg font-bold text-[#1D9E75]">
                S/{PRECIOS[p]}
                <span className="text-xs font-normal text-[#8A877D]">/{p === 'anual' ? 'año' : 'mes'}</span>
              </p>
            </button>
          ))}
        </div>
      </div>

      {/* Paso 2: Yape */}
      <div className="glass-card p-5 space-y-4">
        <p className="text-xs uppercase tracking-wider text-[#8A877D]">2. Yapea S/{monto}</p>
        <div className="flex flex-col sm:flex-row gap-4 items-center">
          <div className="shrink-0 rounded-xl overflow-hidden border border-[rgba(255,255,255,0.08)] bg-white p-2">
            <Image src="/yape-favio-qr.jpeg" alt="QR Yape de Favio Mendoza" width={150} height={150} className="rounded-md" />
          </div>
          <div className="flex-1 w-full space-y-2">
            <p className="text-sm text-[#8A877D]">Yapea a nombre de <span className="text-[#F0EFE8] font-medium">{YAPE_NOMBRE}</span></p>
            <button
              onClick={copyNumero}
              className="w-full flex items-center justify-between rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-4 py-3 hover:bg-[rgba(255,255,255,0.07)] transition-colors"
            >
              <span className="text-lg font-bold text-[#F0EFE8] tabular-nums tracking-wide">{YAPE_NUMERO}</span>
              {copied ? <Check className="h-4 w-4 text-[#1D9E75]" /> : <Copy className="h-4 w-4 text-[#8A877D]" />}
            </button>
            <p className="text-xs text-[#8A877D]">Monto exacto: <span className="text-[#1D9E75] font-semibold">S/{monto}.00</span></p>
          </div>
        </div>
      </div>

      {/* Paso 3: bancos (opcional) */}
      <div className="glass-card p-5 space-y-3">
        <button
          onClick={() => setBancosOpen((v) => !v)}
          className="w-full flex items-center justify-between"
        >
          <div className="text-left">
            <p className="text-xs uppercase tracking-wider text-[#8A877D]">3. Bancos a leer (opcional)</p>
            <p className="text-sm text-[#C8C6BC] mt-0.5">{bancosLabel}</p>
          </div>
          <ChevronDown className={`h-4 w-4 text-[#8A877D] transition-transform ${bancosOpen ? 'rotate-180' : ''}`} />
        </button>
        {bancosOpen && (
          <div className="space-y-2 pt-2 border-t border-[rgba(255,255,255,0.06)]">
            <p className="text-xs text-[#8A877D]">
              Se aplica cuando conectes tu Gmail (después de activar Pro). Neto leerá solo los bancos que elijas.
            </p>
            <label className="flex items-center gap-2 py-1.5 cursor-pointer">
              <input type="checkbox" checked={todos} onChange={(e) => setTodos(e.target.checked)} className="accent-[#1D9E75]" />
              <span className="text-sm text-[#F0EFE8]">Todos mis bancos</span>
            </label>
            {!todos && (
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                {bancos.map((b) => (
                  <label key={b.id} className="flex items-center gap-2 py-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selected.has(b.id)}
                      onChange={() => toggleBanco(b.id)}
                      className="accent-[#1D9E75]"
                    />
                    <span className="text-sm text-[#C8C6BC]">{b.label}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Paso 4: captura */}
      <div className="glass-card p-5 space-y-3">
        <p className="text-xs uppercase tracking-wider text-[#8A877D]">4. Sube tu comprobante</p>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => onPickFile(e.target.files?.[0] || null)}
        />
        {preview ? (
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={preview} alt="Comprobante" className="h-20 w-20 object-cover rounded-lg border border-[rgba(255,255,255,0.08)]" />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-[#F0EFE8] truncate">{file?.name}</p>
              <button onClick={() => inputRef.current?.click()} className="text-xs text-[#1D9E75] hover:underline">
                Cambiar
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => inputRef.current?.click()}
            className="w-full flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[rgba(255,255,255,0.15)] py-8 hover:bg-[rgba(255,255,255,0.03)] transition-colors"
          >
            <Upload className="h-6 w-6 text-[#8A877D]" />
            <span className="text-sm text-[#8A877D]">Toca para subir la captura del Yape</span>
          </button>
        )}
      </div>

      <Button
        onClick={submit}
        disabled={submitting || !file}
        className="w-full bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90 h-12 text-base"
      >
        {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : `Enviar comprobante — S/${monto}`}
      </Button>
      <p className="text-center text-xs text-[#8A877D]">
        Un humano revisa tu pago antes de activar Pro. Cancelas cuando quieras.
      </p>
    </div>
  );
}
