'use client';

import { useEffect } from 'react';
import { motion, useMotionValue, useTransform, animate } from 'motion/react';

interface ScoreGaugeProps {
  score: number;
  size?: 'sm' | 'lg';
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

export function ScoreGauge({ score, size = 'sm' }: ScoreGaugeProps) {
  const isLg = size === 'lg';

  const r = isLg ? 80 : 60;
  const strokeW = isLg ? 12 : 8;
  const pad = strokeW / 2 + 4;
  const vbW = (r + pad) * 2;
  const vbH = r + pad + (isLg ? 28 : 20); // semicircle + text below
  const cx = vbW / 2;
  const cy = r + pad;

  // Half-circle circumference
  const halfCirc = Math.PI * r;
  const clamped = Math.max(0, Math.min(100, score));

  const color = getScoreColor(score);
  const label = getScoreLabel(score);

  const motionScore = useMotionValue(0);
  const displayScore = useTransform(motionScore, (v) => Math.round(v));
  const motionOffset = useTransform(motionScore, (v) => {
    const pct = Math.max(0, Math.min(100, v));
    return halfCirc * (1 - pct / 100);
  });

  useEffect(() => {
    const controls = animate(motionScore, clamped, {
      duration: 1.2,
      ease: [0.16, 1, 0.3, 1],
    });
    return controls.stop;
  }, [clamped, motionScore]);

  const fontSize = isLg ? 32 : 22;
  const labelFontSize = isLg ? 11 : 8;
  const pxWidth = isLg ? 240 : 160;

  return (
    <div className="flex flex-col items-center" style={{ width: pxWidth }}>
      <svg
        width={pxWidth}
        height={Math.round(pxWidth * vbH / vbW)}
        viewBox={`0 0 ${vbW} ${vbH}`}
      >
        {/* Background track — semicircle from left to right */}
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth={strokeW}
          strokeDasharray={`${halfCirc} ${halfCirc * 2}`}
          strokeDashoffset={0}
          transform={`rotate(180 ${cx} ${cy})`}
          strokeLinecap="round"
        />
        {/* Animated score arc */}
        <motion.circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={strokeW}
          strokeDasharray={`${halfCirc} ${halfCirc * 2}`}
          style={{
            strokeDashoffset: motionOffset,
            filter: `drop-shadow(0 0 6px ${color}44)`,
          }}
          transform={`rotate(180 ${cx} ${cy})`}
          strokeLinecap="round"
        />
        {/* Score number */}
        <foreignObject
          x={cx - 50}
          y={cy - fontSize - 10}
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
      </svg>
    </div>
  );
}
