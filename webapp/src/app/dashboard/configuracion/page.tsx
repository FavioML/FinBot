'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/shared/motion-wrapper';
import {
  User,
  Mail,
  Phone,
  Crown,
  Calendar,
  Link,
  Copy,
  Check,
  ExternalLink,
  Settings,
  Shield,
  MessageCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { useUser } from '@/lib/hooks/use-user';
import { createClient } from '@/lib/supabase/client';
import { UserMenu } from '@/components/dashboard/user-menu';
import { SOCIAL_LINKS } from '@/lib/constants';

/* ------------------------------------------------------------------ */
/*  Plan comparison data                                               */
/* ------------------------------------------------------------------ */
const PLAN_FEATURES = [
  { label: 'Reportes/mes', free: '1', premium: 'Ilimitados' },
  { label: 'Historial', free: '3 meses', premium: 'Ilimitado' },
  { label: 'Excel upload', free: false, premium: true },
  { label: 'Score financiero', free: false, premium: true },
  { label: 'Resumen semanal', free: false, premium: true },
] as const;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('es-PE', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function getInitial(email?: string) {
  return (email ?? 'U').charAt(0).toUpperCase();
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */
export default function ConfiguracionPage() {
  const router = useRouter();
  const { data: user, isLoading } = useUser();

  const [copied, setCopied] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const isPremium = user?.plan === 'premium';
  const referralCode = user?.id?.slice(0, 8).toUpperCase() ?? 'CODIGO';
  const referralLink = `neto.pe/r/${referralCode}`;

  /* ---- Copy referral link ---- */
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(`https://${referralLink}`);
      setCopied(true);
      toast.success('Link copiado al portapapeles');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('No se pudo copiar');
    }
  }

  /* ---- Sign out ---- */
  async function handleSignOut() {
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
  }

  /* ---------------------------------------------------------------- */
  /*  Loading skeleton                                                 */
  /* ---------------------------------------------------------------- */
  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-[200px] rounded-2xl" />
        <Skeleton className="h-[260px] rounded-2xl" />
        <Skeleton className="h-[160px] rounded-2xl" />
        <Skeleton className="h-[140px] rounded-2xl" />
        <Skeleton className="h-[120px] rounded-2xl" />
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  No user                                                          */
  /* ---------------------------------------------------------------- */
  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="rounded-full bg-[rgba(255,255,255,0.03)] p-6 mb-4">
          <User className="h-8 w-8 text-[#8A877D]" />
        </div>
        <h3 className="text-lg font-semibold text-[#F0EFE8] mb-2">
          Inicia sesion para ver tu configuracion
        </h3>
        <p className="text-sm text-[#8A877D] max-w-md mb-6">
          Conecta tu cuenta para administrar tu perfil y plan.
        </p>
        <Button
          className="bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90"
          onClick={() => router.push('/login')}
        >
          Iniciar sesion
        </Button>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */
  return (
    <FadeIn>
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[#F0EFE8]">Configuracion</h1>
        <UserMenu />
      </div>

      {/* ============================================================ */}
      {/*  Profile                                                      */}
      {/* ============================================================ */}
      <div className="glass-card glass-card-glow p-6">
        <div className="flex items-start gap-4">
          {/* Avatar */}
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[#1D9E75] text-xl font-bold text-white">
            {getInitial(user.email)}
          </div>

          <div className="flex-1 min-w-0 space-y-2">
            {/* Email */}
            {user.email && (
              <div className="flex items-center gap-2 text-sm">
                <Mail className="h-4 w-4 text-[#8A877D] shrink-0" />
                <span className="text-[#C8C6BC] truncate">{user.email}</span>
              </div>
            )}

            {/* WhatsApp */}
            <div className="flex items-center gap-2 text-sm">
              <Phone className="h-4 w-4 text-[#8A877D] shrink-0" />
              <span className="text-[#C8C6BC]">{user.whatsapp}</span>
            </div>

            {/* Member since */}
            <div className="flex items-center gap-2 text-sm">
              <Calendar className="h-4 w-4 text-[#8A877D] shrink-0" />
              <span className="text-[#8A877D]">
                Miembro desde {formatDate(user.created_at)}
              </span>
            </div>

            {/* Plan badge */}
            <div className="flex items-center gap-2 pt-1">
              {isPremium ? (
                <Badge className="bg-[#1D9E75]/20 text-[#1D9E75] border-[#1D9E75]/30 gap-1">
                  <Crown className="h-3 w-3" />
                  Premium
                </Badge>
              ) : (
                <Badge variant="secondary" className="bg-[rgba(255,255,255,0.06)] text-[#8A877D] border-[rgba(255,255,255,0.08)]">
                  Free
                </Badge>
              )}
            </div>
          </div>
        </div>

        {/* Upgrade CTA */}
        {!isPremium && (
          <>
            <Separator className="my-4 bg-[rgba(255,255,255,0.06)]" />
            <a
              href={`${SOCIAL_LINKS.whatsapp}?text=${encodeURIComponent('Quiero activar Premium')}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button className="w-full bg-[#1D9E75] text-white hover:bg-[#1D9E75]/90 gap-2">
                <Crown className="h-4 w-4" />
                Upgrade a Premium
                <ExternalLink className="h-3 w-3 ml-auto opacity-60" />
              </Button>
            </a>
          </>
        )}
      </div>

      {/* ============================================================ */}
      {/*  Plan details                                                 */}
      {/* ============================================================ */}
      <div className="glass-card glass-card-glow p-6 space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <Shield className="h-5 w-5 text-[#8A877D]" />
          <h2 className="text-lg font-semibold text-[#F0EFE8]">Tu plan</h2>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-sm text-[#C8C6BC]">Plan actual</span>
          <span className="text-sm font-medium text-[#F0EFE8]">
            {isPremium ? 'Premium' : 'Free'}
          </span>
        </div>

        {isPremium && user.plan_expiry && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-[#C8C6BC]">Vence el</span>
            <span className="text-sm font-medium text-[#EF9F27]">
              {formatDate(user.plan_expiry)}
            </span>
          </div>
        )}

        <Separator className="bg-[rgba(255,255,255,0.06)]" />

        {/* Comparison table */}
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[#8A877D]">
                <th className="text-left font-medium py-2 pr-4">Funcion</th>
                <th className="text-center font-medium py-2 px-3">Free</th>
                <th className="text-center font-medium py-2 px-3">Premium</th>
              </tr>
            </thead>
            <tbody>
              {PLAN_FEATURES.map((f) => (
                <tr key={f.label} className="border-t border-[rgba(255,255,255,0.04)]">
                  <td className="py-2.5 pr-4 text-[#C8C6BC]">{f.label}</td>
                  <td className="py-2.5 px-3 text-center">
                    {typeof f.free === 'boolean' ? (
                      <span className="text-[#8A877D]">{f.free ? '\u2705' : '\u274C'}</span>
                    ) : (
                      <span className="text-[#8A877D]">{f.free}</span>
                    )}
                  </td>
                  <td className="py-2.5 px-3 text-center">
                    {typeof f.premium === 'boolean' ? (
                      <span>{f.premium ? '\u2705' : '\u274C'}</span>
                    ) : (
                      <span className="text-[#1D9E75] font-medium">{f.premium}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ============================================================ */}
      {/*  Referidos                                                    */}
      {/* ============================================================ */}
      <div className="glass-card glass-card-glow p-6 space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <Link className="h-5 w-5 text-[#8A877D]" />
          <h2 className="text-lg font-semibold text-[#F0EFE8]">
            Programa de referidos
          </h2>
        </div>

        <p className="text-sm text-[#C8C6BC]">
          Invita a 3 amigos y obten 1 mes Premium gratis.
        </p>

        {/* Referral link */}
        <div className="flex items-center gap-2">
          <div className="flex-1 rounded-lg bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] px-3 py-2 text-sm text-[#C8C6BC] truncate">
            {referralLink}
          </div>
          <Button
            variant="outline"
            size="icon"
            className="shrink-0 border-[rgba(255,255,255,0.1)] bg-transparent hover:bg-[rgba(255,255,255,0.05)]"
            onClick={handleCopy}
          >
            {copied ? (
              <Check className="h-4 w-4 text-[#1D9E75]" />
            ) : (
              <Copy className="h-4 w-4 text-[#8A877D]" />
            )}
          </Button>
        </div>

        {/* Progress */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-[#8A877D]">Referidos activos</span>
            <span className="text-[#C8C6BC] font-medium">0 / 3 necesarios</span>
          </div>
          <div className="h-2 w-full rounded-full bg-[rgba(255,255,255,0.06)]">
            <div
              className="h-full rounded-full bg-[#1D9E75] transition-all duration-500"
              style={{ width: '0%' }}
            />
          </div>
        </div>
      </div>

      {/* ============================================================ */}
      {/*  Connected accounts                                           */}
      {/* ============================================================ */}
      <div className="glass-card glass-card-glow p-6 space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <Mail className="h-5 w-5 text-[#8A877D]" />
          <h2 className="text-lg font-semibold text-[#F0EFE8]">
            Cuentas conectadas
          </h2>
        </div>

        {/* Placeholder connected account */}
        {user.email ? (
          <div className="flex items-center justify-between rounded-lg bg-[rgba(255,255,255,0.03)] border border-[rgba(255,255,255,0.06)] px-4 py-3">
            <div className="flex items-center gap-3 min-w-0">
              <Mail className="h-4 w-4 text-[#8A877D] shrink-0" />
              <span className="text-sm text-[#C8C6BC] truncate">{user.email}</span>
            </div>
            <Badge className="bg-[#1D9E75]/20 text-[#1D9E75] border-[#1D9E75]/30 text-xs shrink-0">
              Activa
            </Badge>
          </div>
        ) : (
          <p className="text-sm text-[#8A877D]">No hay cuentas conectadas.</p>
        )}

        {/* Connect another */}
        <a
          href={`${SOCIAL_LINKS.whatsapp}?text=${encodeURIComponent('Quiero conectar otra cuenta de Gmail')}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Button
            variant="outline"
            className="w-full border-[rgba(255,255,255,0.1)] bg-transparent text-[#C8C6BC] hover:bg-[rgba(255,255,255,0.05)] gap-2"
          >
            <MessageCircle className="h-4 w-4" />
            Conectar otra cuenta
            <ExternalLink className="h-3 w-3 ml-auto opacity-60" />
          </Button>
        </a>
      </div>

      {/* ============================================================ */}
      {/*  Danger zone                                                  */}
      {/* ============================================================ */}
      <div className="glass-card p-6 space-y-4 border-[#D85A30]/20 hover:border-[#D85A30]/40 transition-colors">
        <div className="flex items-center gap-2 mb-1">
          <Settings className="h-5 w-5 text-[#D85A30]" />
          <h2 className="text-lg font-semibold text-[#F0EFE8]">Zona de peligro</h2>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row">
          <Button
            variant="outline"
            className="flex-1 border-[rgba(255,255,255,0.1)] bg-transparent text-[#C8C6BC] hover:bg-[rgba(255,255,255,0.05)]"
            disabled={signingOut}
            onClick={handleSignOut}
          >
            {signingOut ? 'Cerrando...' : 'Cerrar sesion'}
          </Button>

          <Button
            variant="outline"
            className="flex-1 border-[#D85A30]/40 bg-transparent text-[#D85A30] hover:bg-[#D85A30]/10"
            onClick={() => setShowDeleteConfirm(true)}
          >
            Eliminar cuenta
          </Button>
        </div>

        {/* Delete confirmation */}
        {showDeleteConfirm && (
          <div className="rounded-lg border border-[#D85A30]/30 bg-[#D85A30]/5 p-4 space-y-3">
            <p className="text-sm text-[#C8C6BC]">
              Para eliminar tu cuenta, contacta soporte por WhatsApp.
            </p>
            <div className="flex gap-2">
              <a
                href={`${SOCIAL_LINKS.whatsapp}?text=${encodeURIComponent('Quiero eliminar mi cuenta')}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1"
              >
                <Button
                  variant="outline"
                  className="w-full border-[#D85A30]/40 text-[#D85A30] hover:bg-[#D85A30]/10 gap-2"
                >
                  <MessageCircle className="h-4 w-4" />
                  Contactar soporte
                </Button>
              </a>
              <Button
                variant="outline"
                className="border-[rgba(255,255,255,0.1)] bg-transparent text-[#8A877D] hover:bg-[rgba(255,255,255,0.05)]"
                onClick={() => setShowDeleteConfirm(false)}
              >
                Cancelar
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
    </FadeIn>
  );
}
