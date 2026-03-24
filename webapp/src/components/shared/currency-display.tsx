import { formatCurrency } from '@/lib/utils';

interface CurrencyDisplayProps {
  amount: number;
  currency?: string;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

export function CurrencyDisplay({ amount, currency = 'PEN', className, size = 'md' }: CurrencyDisplayProps) {
  const sizeClasses = {
    sm: 'text-sm',
    md: 'text-xl font-semibold',
    lg: 'text-3xl font-bold tracking-tight',
  };

  return (
    <span className={`${sizeClasses[size]} ${className}`}>
      {formatCurrency(amount, currency)}
    </span>
  );
}
