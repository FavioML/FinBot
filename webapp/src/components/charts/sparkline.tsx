'use client';

interface SparklineProps {
  data: number[];
  color: string;
  height?: number;
  width?: number;
}

export function Sparkline({ data, color, height = 28, width = 64 }: SparklineProps) {
  if (data.length < 2) return null;

  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const padding = 2;

  const points = data.map((v, i) => {
    const x = padding + (i / (data.length - 1)) * (width - padding * 2);
    const y = padding + (1 - (v - min) / range) * (height - padding * 2);
    return `${x},${y}`;
  });

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p}`).join(' ');

  // Fill area under the line
  const fillD = `${pathD} L ${width - padding},${height} L ${padding},${height} Z`;

  return (
    <svg width={width} height={height} className="opacity-60">
      <defs>
        <linearGradient id={`spark-fill-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.2" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fillD} fill={`url(#spark-fill-${color.replace('#', '')})`} />
      <path d={pathD} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      {/* Last point dot */}
      <circle
        cx={parseFloat(points[points.length - 1].split(',')[0])}
        cy={parseFloat(points[points.length - 1].split(',')[1])}
        r="2"
        fill={color}
      />
    </svg>
  );
}
