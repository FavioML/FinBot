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

function buildArcPath(cx: number, cy: number, r: number, score: number): string {
  const clamped = Math.max(0, Math.min(100, score));
  const startX = cx - r;
  const startY = cy;
  const angle = Math.PI - (clamped / 100) * Math.PI;
  const endX = cx + r * Math.cos(angle);
  const endY = cy - r * Math.sin(angle);
  const largeArc = clamped > 50 ? 1 : 0;
  return `M ${startX} ${startY} A ${r} ${r} 0 ${largeArc} 1 ${endX} ${endY}`;
}

export function ScoreGauge({ score, size = 'sm', trend }: ScoreGaugeProps) {
  const isLg = size === 'lg';

  // Layout constants — all in viewBox units
  const r = isLg ? 90 : 70;
  const strokeW = isLg ? 14 : 10;
  const pad = strokeW / 2 + 2; // padding around arc
  const vbW = (r + pad) * 2;
  const arcH = r + pad; // semicircle height (top half)
  const textH = isLg ? 20 : 16; // space below baseline for label + trend
  const vbH = arcH + textH;
  const cx = vbW / 2;
  const cy = arcH; // baseline of semicircle

  const color = getScoreColor(score);
  const label = getScoreLabel(score);

  const motionScore = useMotionValue(0);
  const displayScore = useTransform(motionScore, (v) => Math.round(v));

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

  const fontSize = isLg ? 36 : 24;
  const labelFontSize = isLg ? 12 : 9;
  const pxWidth = isLg ? 260 : 170;

  return (
    <div className="flex flex-col items-center" style={{ width: pxWidth }}>
      <svg
        width={pxWidth}
        height={Math.round(pxWidth * vbH / vbW)}
        viewBox={`0 0 ${vbW} ${vbH}`}
      >
        {/* Background track */}
        <path
          d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth={strokeW}
          strokeLinecap="butt"
        />
        {/* Animated score arc */}
        <path
          ref={arcRef}
          d={buildArcPath(cx, cy, r, 0)}
          fill="none"
          stroke={color}
          strokeWidth={strokeW}
          strokeLinecap="butt"
          style={{ filter: `drop-shadow(0 0 4px ${color}44)` }}
        />
        {/* Score number */}
        <foreignObject
          x={cx - 50}
          y={cy - fontSize - 16}
          width={100}
          height={fontSize + 8}
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
          y={cy - 2}
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
            y={cy + (isLg ? 16 : 12)}
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
