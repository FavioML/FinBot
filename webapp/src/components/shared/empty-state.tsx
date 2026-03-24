import { MessageCircle } from 'lucide-react';
import { SOCIAL_LINKS } from '@/lib/constants';

interface EmptyStateProps {
  title: string;
  description: string;
  showWhatsApp?: boolean;
}

export function EmptyState({ title, description, showWhatsApp = true }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="rounded-full bg-[rgba(255,255,255,0.03)] p-6 mb-4">
        <MessageCircle className="h-8 w-8 text-[#8A877D]" />
      </div>
      <h3 className="text-lg font-semibold text-[#F0EFE8] mb-2">{title}</h3>
      <p className="text-sm text-[#8A877D] max-w-md mb-6">{description}</p>
      {showWhatsApp && (
        <a
          href={SOCIAL_LINKS.whatsapp}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-lg bg-[#1D9E75] px-4 py-2 text-sm font-medium text-white hover:bg-[#1D9E75]/90 transition-colors"
        >
          <MessageCircle className="h-4 w-4" />
          Registra gastos por WhatsApp
        </a>
      )}
    </div>
  );
}
