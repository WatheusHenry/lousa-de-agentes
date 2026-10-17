import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Modo confiança de um repositório: libera sem perguntar o trabalho comum de um agente dentro
 * do próprio worktree. Roda depois das negações padrão (push forçado, `rm -r` fora, rede,
 * arquivos fora do worktree), que continuam valendo. Instalar pacotes, `sudo`, substituição de
 * comando e qualquer coisa fora da lista seguem para o usuário.
 */

/** Ferramentas de arquivo: o caminho já foi conferido pelas negações padrão. */
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Início de comando liberado (comparado por palavra). */
const SAFE_PREFIXES = [
  // leitura
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'rg',
  'pwd',
  'echo',
  'printf',
  'sort',
  'uniq',
  'diff',
  'tree',
  'which',
  'file',
  'stat',
  'du',
  'true',
  'test',
  'sed -n',
  'basename',
  'dirname',
  'cut',
  'tr',
  // git local (sem push, que passa pelo open_merge_request)
  'git status',
  'git diff',
  'git log',
  'git show',
  'git add',
  'git commit',
  'git rev-parse',
  'git ls-files',
  'git grep',
  'git blame',
  'git branch --show-current',
  'git stash',
  // testes, lint e build
  'npm test',
  'npm run',
  'npm t',
  'pnpm test',
  'pnpm run',
  'pnpm lint',
  'pnpm typecheck',
  'pnpm build',
  'pnpm format',
  'yarn test',
  'yarn run',
  'yarn lint',
  'yarn build',
  'bun test',
  'npx vitest',
  'npx jest',
  'npx tsc',
  'npx eslint',
  'npx prettier',
  'node --test',
  'pytest',
  'python -m pytest',
  'python3 -m pytest',
  'go test',
  'go vet',
  'go build',
  'cargo test',
  'cargo build',
  'cargo check',
  'cargo clippy',
  'cargo fmt',
  'make test',
  'make lint',
  'make check',
  'make build',
  'mvn test',
  './gradlew test',
  'gradle test',
  'deno test',
  // arquivos (os caminhos são conferidos abaixo)
  'mkdir',
  'touch',
  'cp',
  'mv',
];
/** Comandos cujos argumentos são caminhos que precisam ficar no worktree. */
const PATH_ARGS = new Set(['mkdir', 'touch', 'cp', 'mv']);

/** Corpo dos heredocs (`cat > a <<'EOF' … EOF`) é conteúdo, não comando. */
function stripHeredocs(cmd: string): string {
  return cmd.replace(
    /<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g,
    (_m, _q, _t, rest) => rest,
  );
}

const startsWithWord = (s: string, prefix: string) => s === prefix || s.startsWith(prefix + ' ');

function inside(worktree: string, p: string): boolean {
  if (p === '/dev/null') return true;
  // `..` fica de fora: depois de um `cd`, o caminho relativo não é mais relativo ao worktree
  if (p.startsWith('~') || p.includes('$') || p.split('/').includes('..')) return false;
  const rel = relative(resolve(worktree), resolve(worktree, p));
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/** Uma parte de comando (sem `&&`, `;`, `|`) liberada pelo modo confiança. */
function safePart(part: string, worktree: string): boolean {
  // destinos de redirecionamento: só dentro do worktree (2>&1 e afins passam)
  for (const m of part.matchAll(/(?:^|[^<&\d])\d?>>?\s*([^\s&|;]+)/g))
    if (!inside(worktree, m[1]!)) return false;
  const bare = part
    .replace(/\d?>>?\s*[^\s&|;]+/g, '')
    .replace(/\d?>&\d/g, '')
    .trim();
  if (!bare) return true;
  const prefix = SAFE_PREFIXES.find((p) => startsWithWord(bare, p));
  if (!prefix) return false;
  if (PATH_ARGS.has(prefix)) {
    const args = bare
      .split(/\s+/)
      .slice(1)
      .filter((a) => !a.startsWith('-'));
    return args.length > 0 && args.every((a) => inside(worktree, a.replace(/^['"]|['"]$/g, '')));
  }
  return true;
}

/** O modo confiança libera este pedido? (As negações padrão já foram aplicadas antes.) */
export function trustedAllows(toolName: string, input: unknown, worktree: string | null): boolean {
  if (!worktree) return false;
  if (FILE_TOOLS.has(toolName)) return true;
  if (toolName !== 'Bash') return false;
  const raw = String((input as { command?: unknown })?.command ?? '');
  if (/\$\(|`|\beval\b|\bsudo\b|\bsource\b/.test(raw)) return false;
  const parts = stripHeredocs(raw)
    .split(/&&|\|\||;|\||\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  // `cd` para dentro do worktree é comum antes dos testes
  return (
    parts.length > 0 &&
    parts.every((p) =>
      startsWithWord(p, 'cd') ? inside(worktree, p.slice(2).trim() || '.') : safePart(p, worktree),
    )
  );
}
