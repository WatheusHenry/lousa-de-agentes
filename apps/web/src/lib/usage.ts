/** Faixa de cor do uso do plano: normal, perto do limite, no limite. */
export const usageLevel = (percent: number): 'ok' | 'warn' | 'bad' =>
  percent >= 90 ? 'bad' : percent >= 75 ? 'warn' : 'ok';

/** "zera em 2 h 10 min" / "zera em 5 min" / "zera sáb. 06:00", a partir do `resets_at`. */
export function resetsIn(iso: string | null, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const min = Math.max(0, Math.round((t - now) / 60_000));
  if (min < 1) return 'zera agora';
  if (min < 60) return `zera em ${min} min`;
  if (min < 24 * 60) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `zera em ${h} h${m ? ` ${m} min` : ''}`;
  }
  const d = new Date(t);
  const day = d.toLocaleDateString('pt-BR', { weekday: 'short' });
  return `zera ${day} ${d.toTimeString().slice(0, 5)}`;
}
