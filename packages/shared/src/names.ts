/** Tamanho máximo do nome de um agente (o do terminal cabe em ~28 caracteres). */
export const AGENT_NAME_MAX = 40;

const FILLER = new Set([
  'a',
  'o',
  'as',
  'os',
  'um',
  'uma',
  'de',
  'do',
  'da',
  'dos',
  'das',
  'para',
  'pra',
  'por',
  'com',
  'em',
  'no',
  'na',
  'nos',
  'nas',
  'que',
  'e',
  'ou',
  'se',
  'ao',
  'quero',
  'preciso',
  'favor',
  'por-favor',
  'faca',
  'faça',
  'fazer',
  'implemente',
  'implementar',
  'crie',
  'criar',
  'voce',
  'você',
  'pode',
  'gostaria',
  'melhoria',
  'ola',
  'olá',
  'oi',
  'the',
  'to',
  'of',
  'and',
  'please',
]);

/**
 * Nome curto e legível a partir de um título/instrução: tira markdown e palavras de enchimento,
 * fica com as primeiras palavras que significam algo e nunca corta no meio de uma palavra.
 * "Quero que implemente uma tela de login com SSO" → "tela login SSO".
 */
export function conciseName(text: string, maxLen = 28, maxWords = 4): string {
  const first = (text.split('\n').find((l) => l.trim()) ?? '')
    .replace(/[`*_#>[\]()]/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
  const words = first.split(/\s+/).filter(Boolean);
  const keep = words.filter((w) => !FILLER.has(w.toLowerCase().replace(/[.,:;!?]/g, '')));
  const pool = (keep.length ? keep : words)
    .map((w) => w.replace(/^[.,:;!?"'-]+|[.,:;!?"'-]+$/g, ''))
    .filter(Boolean);
  const out: string[] = [];
  for (const w of pool.slice(0, maxWords)) {
    if ([...out, w].join(' ').length > maxLen) break;
    out.push(w);
  }
  if (!out.length && pool[0]) return pool[0].slice(0, maxLen);
  return out.join(' ');
}

/** Garante nome único (sem diferenciar maiúsculas): "login", "login 2", "login 3"… */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((t) => t.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const cand = `${base} ${n}`;
    if (!used.has(cand.toLowerCase())) return cand;
  }
}
