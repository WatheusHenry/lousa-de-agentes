import type { Issue } from '@agent-canvas/shared';

export const firstLine = (s: string | undefined): string => {
  const l =
    (s || '')
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean)[0] || '(nota vazia)';
  return l.length > 90 ? l.slice(0, 88) + '…' : l;
};

export const initials = (who: string): string =>
  who
    .replace(/[^a-zA-Z.]/g, '')
    .split('.')
    .map((x) => x[0] || '')
    .join('')
    .slice(0, 2)
    .toUpperCase() || 'V';

export const isBug = (i: Issue) => i.labels.some((l) => /^(bug|type::bug)$/i.test(l));
export const isP1 = (l: string) => /^(p1|priority::1)$/i.test(l);
export const isRedLabel = (l: string) => /^(bug|type::bug)$/i.test(l) || isP1(l);

/** Nome curto do projeto da issue: "grupo/payments-api" → "payments-api". */
export const repoName = (i: Issue) => i.projectPath.split('/').pop() || i.projectPath;

/** Itens de checklist em Markdown ("- [ ] ..." e "- [x] ...") da descrição. */
export function checklist(description: string): { text: string; done: boolean }[] {
  const out: { text: string; done: boolean }[] = [];
  for (const m of description.matchAll(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/gm))
    out.push({ done: m[1] !== ' ', text: m[2]!.trim() });
  return out;
}

/** Descrição sem os itens de checklist, que aparecem em "Critérios de aceite". */
export const descriptionWithoutChecklist = (description: string) =>
  description
    .replace(/^\s*[-*]\s+\[[ xX]\]\s+.+$/gm, '')
    .replace(/^#+\s*crit[ée]rios de aceite\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
export function timeAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.round((t - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(s, 'second');
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}

export const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 5);
};
