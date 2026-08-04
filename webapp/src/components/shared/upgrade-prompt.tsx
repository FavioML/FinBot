'use client';

import { Lock, Crown, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SOCIAL_LINKS, PRO_PRICE_MONTHLY_PEN, PRO_PRICE_YEARLY_PEN } from '@/lib/constants';

interface UpgradePromptProps {
  /** Contextual message explaining what the user would unlock */
  message: string;
  /** Variant: 'inline' replaces content, 'overlay' overlays on blurred content */
  variant?: 'inline' | 'overlay';
  /** Optional className */
  className?: string;
}

const WA_CONTACT_LINK = `${SOCIAL_LINKS.whatsapp}?text=${encodeURIComponent('Hola, necesito ayuda con mi cuenta Neto')}`;

export function UpgradePrompt({ message, variant = 'inline', className = '' }: UpgradePromptProps) {
  if (variant === 'overlay') {
    return (
      <div className={`absolute inset-0 z-10 flex items-center justify-center backdrop-blur-sm bg-[#0E0E0C]/60 rounded-2xl ${className}`}>
        <div className="text-center px-6 max-w-sm glass-card-glow rounded-2xl py-6">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[#1D9E75]/15">
            <Lock className="h-5 w-5 text-[#1D9E75]" />
          </div>
          <p className="text-sm text-[#C8C6BC] mb-4">{message}</p>
          <a href={WA_CONTACT_LINK} target="_blank" rel="noopener noreferrer">
            <Button className="bg-[#1D9E75] hover:bg-[#1D9E75]/90 active:scale-[0.98] text-white gap-2 transition-transform">
              <Crown className="h-4 w-4" />
              Activar Neto — S/{PRO_PRICE_MONTHLY_PEN}/mes
              <ArrowRight className="h-3 w-3" />
            </Button>
          </a>
          <p className="text-xs text-[#87948c] mt-2">S/{PRO_PRICE_YEARLY_PEN}/año (2 meses gratis)</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col items-center justify-center rounded-2xl border border-[#2A2A28] bg-[#1C1C19] p-8 text-center glass-card-glow ${className}`}>
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[#1D9E75]/15">
        <Lock className="h-6 w-6 text-[#1D9E75]" />
      </div>
      <h3 className="mb-2 text-lg font-semibold text-[#e5e2de]">Función incluida</h3>
      <p className="mb-6 text-sm text-[#87948c] max-w-xs">{message}</p>
      <a href={WA_CONTACT_LINK} target="_blank" rel="noopener noreferrer">
        <Button className="bg-[#1D9E75] hover:bg-[#1D9E75]/90 active:scale-[0.98] text-white gap-2 transition-transform">
          <Crown className="h-4 w-4" />
          Activar Neto — S/{PRO_PRICE_MONTHLY_PEN}/mes
          <ArrowRight className="h-3 w-3" />
        </Button>
      </a>
      <p className="text-xs text-[#87948c] mt-3">S/{PRO_PRICE_YEARLY_PEN}/año (2 meses gratis) · Paga con Yape</p>
    </div>
  );
}

/** Small inline badge to indicate a Pro limit */
export function ProBadge({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[#EF9F27]/15 px-2.5 py-0.5 text-xs font-medium text-[#EF9F27]">
      <Crown className="h-3 w-3" />
      {text}
    </span>
  );
}
