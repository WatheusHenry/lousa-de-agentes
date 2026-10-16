/** ESC das cores ANSI, montado em texto para não ter caractere de controle na regex literal. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');

/** Tira cores ANSI, marcadores de seção do GitLab e retornos de carro do trace de um job. */
export function cleanTrace(raw: string): string {
  return raw
    .replace(ANSI, '')
    .replace(/section_(start|end):\d+:[\w.-]+\r?/g, '')
    .replace(/\r(?!\n)/g, '\n')
    .replace(/\r\n/g, '\n');
}

const ERROR_RE = /(^|\s)(error|failed|failure|fatal|exception|assert|✕|✗|FAIL\b)/i;

/**
 * Trecho que importa de um log de job (seção 7 do plano): em volta do primeiro erro e as
 * últimas 200 linhas, sem repetir linhas.
 */
export function excerptLog(raw: string, tail = 200, around = 30): string {
  const lines = cleanTrace(raw).split('\n');
  if (lines.length <= tail + around * 2) return lines.join('\n');
  const keep = new Set<number>();
  const first = lines.findIndex((l) => ERROR_RE.test(l) && !/0 failed|no errors/i.test(l));
  if (first >= 0 && first < lines.length - tail)
    for (let i = Math.max(0, first - around); i <= Math.min(lines.length - 1, first + around); i++)
      keep.add(i);
  for (let i = lines.length - tail; i < lines.length; i++) keep.add(i);
  const out: string[] = [];
  let prev = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (prev >= 0 && i !== prev + 1) out.push(`… (${i - prev - 1} linhas omitidas)`);
    else if (prev < 0 && i > 0) out.push(`… (${i} linhas omitidas)`);
    out.push(lines[i]!);
    prev = i;
  }
  return out.join('\n');
}
