'use client';

import { useEffect, useRef } from 'react';
import { motion, useMotionValue, useTransform, animate } from 'motion/react';

interface ScoreGaugeProps {
  score: number;
  size?: 'sm' | 'lg';
  trend?: { diff: number; direction: 'up' | 'down' | 'stable' };
}

function getScoreLabel(score: number): string {
  if (score >= 80) return 'Excelente';
  if (score >= 60) return 'En camino';
  if (score >= 40) return 'Puede mejorar';
  return 'Atención';
}

function getScoreColor(score: number): string {
  if (score >= 80) return '#1D9E75';
  if (score >= 60) return '#3B9EDB';
  if (score >= 40) return '#E8A838';
  return '#E85D3A';
}

// Maps score 0-100 to an angle on a 180° semicircle (left=0, right=100)
// Start angle: 180° (left), End angle: 0° (right), sweep: 180°
function scoreToPath(score: number, cx: number, cy: number, r: number) {
  const clampedScore = Math.max(0, Math.min(100, score));
  // 180° arc: starts at left (π), sweeps to right (0)
  // angle goes from Math.PI to 0 as score goes from 0 to 100
  const angle = Math.PI - (clampedScore / 100) * Math.PI;
  const x = cx + r * Math.cos(angle);
  const y = cy - r * Math.sin(angle);
  return { x, y };
}

function buildArcPath(cx: number, cy: number, r: number, score: number): string {
  const start = { x: cx - r, y: cy }; // leftmost point (score 0)
  const end = scoreToPath(score, cx, cy, r);
  const clampedScore = Math.max(0, Math.min(100, score));
  const largeArc = clampedScore > 50 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

export function ScoreGauge({ score, size = 'sm', trend }: ScoreGaugeProps) {
  // Use fixed viewBox coordinates but let the SVG scale responsively
  const vbWidth = size === 'lg' ? 300 : 200;
  const vbHeight = size === 'lg' ? 160 : 110;
  const cx = vbWidth / 2;
  const cy = vbHeight - (size === 'lg' ? 20 : 14);
  const r = size === 'lg' ? 110 : 73;
  const strokeWidth = size === 'lg' ? 14 : 10;

  const color = getScoreColor(score);
  const label = getScoreLabel(score);

  const motionScore = useMotionValue(0);
  const displayScore = useTransform(motionScore, (v) => Math.round(v));

  // Animated arc path
  const arcRef = useRef<SVGPathElement>(null);

  useEffect(() => {
    const controls = animate(motionScore, score, {
      duration: 1.2,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (latest) => {
        if (arcRef.current) {
          arcRef.current.setAttribute('d', buildArcPath(cx, cy, r, latest));
        }
      },
    });
    return controls.stop;
  }, [score, cx, cy, r, motionScore]);

  const trendIcon =
    trend?.direction === 'up' ? '↑' :
    trend?.direction === 'down' ? '↓' : '→';

  const trendColor =
    trend?.direction === 'up' ? '#1D9E75' :
    trend?.direction === 'down' ? '#E85D3A' : '#8A877D';

  const fontSize = size === 'lg' ? 42 : 28;
  const labelFontSize = size === 'lg' ? 13 : 10;

  const maxWidth = size === 'lg' ? '280px' : '180px';

  return (
    <div className="flex flex-col items-center" style={{ width: '100%', maxWidth }}>
      <svg
        width="100%"
        viewBox={`0 0 ${vbWidth} ${vbHeight}`}
        preserveAspectRatio="xMidYMid meet"
        overflow="visible"
        style={{ display: 'block', aspectRatio: `${vbWidth} / ${vbHeight}` }}
      >
        {/* Background track */}
        <path
          d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
        {/* Animated score arc */}
        <path
          ref={arcRef}
          d={buildArcPath(cx, cy, r, 0)}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 8px ${color}66)` }}
        />
        {/* Score number */}
        <foreignObject
          x={cx - 60}
          y={cy - fontSize - 22}
          width={120}
          height={fontSize + 10}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'center',
              gap: 2,
            }}
          >
            <motion.span
              style={{
                fontSize,
                fontWeight: 700,
                color,
                lineHeight: 1,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {displayScore}
            </motion.span>
            <span style={{ fontSize: fontSize * 0.4, color: 'rgba(248,247,240,0.4)', fontWeight: 600 }}>
              /100
            </span>
          </div>
        </foreignObject>
        {/* Label */}
        <text
          x={cx}
          y={cy - 4}
          textAnchor="middle"
          fontSize={labelFontSize}
          fontWeight={500}
          fill="rgba(248,247,240,0.5)"
          letterSpacing="0.05em"
        >
          {label.toUpperCase()}
        </text>
        {/* Trend */}
        {trend && (
          <text
            x={cx}
            y={cy + (size === 'lg' ? 18 : 13)}
            textAnchor="middle"
            fontSize={labelFontSize}
            fontWeight={600}
            fill={trendColor}
          >
            {trendIcon} {Math.abs(trend.diff)} pts
          </text>
        )}
      </svg>
    </div>
  );
}
