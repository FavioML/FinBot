import Link from 'next/link';
import { TrendingUp, Receipt, MessageSquare, Users, LayoutGrid, Activity } from 'lucide-react';

export const dynamic = 'force-dynamic';

const sections = [
  {
    href: '/admin/operacion',
    title: 'Operación',
    desc: 'Usuarios, NLP errors, tickets de soporte, KPIs y embudo',
    icon: LayoutGrid,
    status: 'live' as const,
  },
  {
    href: '/admin/economics',
    title: 'Unit Economics',
    desc: 'MRR, ARR, breakeven, márgenes, CAC, LTV',
    icon: TrendingUp,
    status: 'live' as const,
  },
  {
    href: '/admin/producto',
    title: 'Producto & Retención',
    desc: 'Retención por cohorte, engagement, adopción de features',
    icon: Activity,
    status: 'live' as const,
  },
  {
    href: '/admin/costs',
    title: 'Costos & Recordatorios',
    desc: 'Railway, dominio, chip Entel — vencen hoy',
    icon: Receipt,
    status: 'live' as const,
  },
  {
    href: '/admin/surveys',
    title: 'Encuestas & Feedback',
    desc: 'Recordatorios, NPS in-app, feedback abierto',
    icon: MessageSquare,
    status: 'live' as const,
  },
  {
    href: '/admin/users',
    title: 'Usuarios',
    desc: 'Free vs Pro, conversion rate, churn',
    icon: Users,
    status: 'soon' as const,
  },
];

export default function AdminHomePage() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {sections.map((section) => {
        const Icon = section.icon;
        const isLive = section.status === 'live';
        return (
          <Link
            key={section.href}
            href={section.href}
            className="group glass-card relative overflow-hidden rounded-xl p-5 transition-all hover:border-[rgba(29,158,117,0.35)]"
          >
            <div className="flex items-start gap-4">
              <div className="rounded-lg bg-[rgba(29,158,117,0.12)] p-2.5 text-[#1D9E75]">
                <Icon className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold text-[#F0EFE8]">
                  {section.title}
                </h2>
                <p className="mt-1 text-sm text-[#8A877D]">{section.desc}</p>
              </div>
              <span
                className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${
                  isLive
                    ? 'border-[rgba(29,158,117,0.35)] bg-[rgba(29,158,117,0.10)] text-[#1D9E75]'
                    : 'border-[rgba(255,255,255,0.08)] text-[#8A877D]'
                }`}
              >
                {isLive ? 'Activo' : 'Próximo'}
              </span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
