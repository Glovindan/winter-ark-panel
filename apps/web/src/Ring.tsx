import type { ReactNode } from 'react';
import { RING_KINDS, type RingStat, type Rings } from '@ark/shared';

const VIEW = 112;
const STROKE = 7;
const GAP = 2;
const OUTER_R = VIEW / 2 - STROKE / 2 - 1;

/** Снаружи внутрь: питание, тренировка, сон. */
function Track({ r, stat }: { r: number; stat: RingStat }) {
  const c = 2 * Math.PI * r;
  const done = stat.total ? (stat.done / stat.total) * c : 0;
  const skipped = stat.total ? (stat.skipped / stat.total) * c : 0;
  const common = { cx: VIEW / 2, cy: VIEW / 2, r, fill: 'none', strokeWidth: STROKE } as const;
  return (
    <>
      <circle {...common} className="ring-track" />
      {skipped > 0 && (
        <circle {...common} className="ring-skipped" strokeDasharray={`${skipped} ${c - skipped}`} strokeDashoffset={-done} />
      )}
      {done > 0 && <circle {...common} className="ring-done" strokeDasharray={`${done} ${c - done}`} />}
    </>
  );
}

export function Ring({ rings, size, children }: { rings: Rings; size: number; children: ReactNode }) {
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${VIEW} ${VIEW}`} width={size} height={size} role="img"
        aria-label="Выполнено и пропущено по питанию, тренировкам и сну">
        <g transform={`rotate(-90 ${VIEW / 2} ${VIEW / 2})`}>
          {RING_KINDS.map((k, i) => (
            <Track key={k} r={OUTER_R - i * (STROKE + GAP)} stat={rings[k]} />
          ))}
        </g>
      </svg>
      <div className="ring-center">{children}</div>
    </div>
  );
}
