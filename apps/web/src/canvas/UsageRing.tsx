import type { ClaudeUsage, ClaudeUsageWindow } from '@agent-canvas/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/http.ts';
import { resetsIn, usageLevel } from '../lib/usage.ts';

/** O bridge guarda o número por um minuto; consultar mais que isso não muda nada. */
const POLL_MS = 60_000;

/** Círculo que enche conforme a sessão de 5 h do plano do Claude é usada. */
function Ring({ percent, size = 18 }: { percent: number | null; size?: number }) {
  const r = (size - 4) / 2;
  const len = 2 * Math.PI * r;
  const p = percent ?? 0;
  return (
    <svg
      className={`usage-ring ${percent === null ? 'none' : usageLevel(p)}`}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
    >
      <circle className="track" cx={size / 2} cy={size / 2} r={r} />
      <circle
        className="fill"
        cx={size / 2}
        cy={size / 2}
        r={r}
        strokeDasharray={len}
        strokeDashoffset={len * (1 - p / 100)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

function Row({ label, w, now }: { label: string; w: ClaudeUsageWindow | null; now: number }) {
  return (
    <div className="usage-row">
      <div className="usage-head">
        <span>{label}</span>
        <b>{w ? `${Math.round(w.percent)}%` : '—'}</b>
      </div>
      <div className={`usage-bar ${w ? usageLevel(w.percent) : 'none'}`}>
        <i style={{ width: `${w?.percent ?? 0}%` }} />
      </div>
      {w?.resetsAt && <small>{resetsIn(w.resetsAt, now)}</small>}
    </div>
  );
}

/** Uso do plano do Claude na toolbar: anel da sessão de 5 h; clique mostra também a semana. */
export function UsageRing() {
  const [usage, setUsage] = useState<ClaudeUsage | null>(null);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.hidden) return;
      api
        .claudeUsage()
        .then((u) => alive && (setUsage(u), setNow(Date.now())))
        .catch(() => {});
    };
    load();
    const t = setInterval(load, POLL_MS);
    document.addEventListener('visibilitychange', load);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', load);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  // login por chave de API (ou nenhum): não há limite de sessão para mostrar
  if (!usage || (!usage.plan && !usage.fiveHour && !usage.sevenDay)) return null;

  const five = usage.fiveHour;
  const title = five
    ? `Sessão de 5 h: ${Math.round(five.percent)}% usado${five.resetsAt ? `, ${resetsIn(five.resetsAt, now)}` : ''}`
    : 'Uso do Claude';
  return (
    <div className="usage" ref={box}>
      <button
        className="btn plain sm"
        title={title}
        aria-label={title}
        aria-expanded={open}
        onClick={() => {
          setNow(Date.now());
          setOpen(!open);
        }}
      >
        <Ring percent={five?.percent ?? null} />
        <span className="lb">{five ? `${Math.round(five.percent)}%` : 'Uso'}</span>
      </button>
      {open && (
        <div className="usage-pop" role="dialog" aria-label="Uso do Claude">
          <div className="usage-title">
            Uso do Claude{usage.plan && <span className="badge">{usage.plan}</span>}
          </div>
          <Row label="Sessão de 5 horas" w={five} now={now} />
          <Row label="Semana" w={usage.sevenDay} now={now} />
          {usage.error && <p className="usage-err">{usage.error}</p>}
        </div>
      )}
    </div>
  );
}
