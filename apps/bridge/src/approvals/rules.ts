import { isAbsolute, relative, resolve } from 'node:path';
import { summarizeTool } from '../agents/stream-parser.ts';

/**
 * Regras de permissão no formato do Claude Code:
 *   `Write`                 a ferramenta inteira
 *   `Bash(npm test:*)`      comandos que começam com "npm test" (sintaxe antiga)
 *   `Bash(npm test *)`      idem (sintaxe nova)
 *   `Bash(npm test)`        só exatamente esse comando
 * Para ferramentas de arquivo, o conteúdo entre parênteses casa com o caminho resumido
 * (relativo ao worktree), com `*` no fim como prefixo.
 */
export function matchesRule(pattern: string, toolName: string, input: unknown): boolean {
  const m = /^([^()]+?)(?:\((.*)\))?$/.exec(pattern.trim());
  if (!m) return false;
  const [, tool, arg] = m;
  if (tool !== toolName) return false;
  if (arg === undefined || arg === '*' || arg === '') return true;
  const subject = summarizeTool(toolName, input);
  // no Bash, um comando composto (&&, ;, |) só casa se cada parte casar
  const parts = toolName === 'Bash' ? splitCommand(fullCommand(input)) : [subject];
  return parts.length > 0 && parts.every((p) => matchArg(arg, p));
}

function matchArg(arg: string, subject: string): boolean {
  if (arg.endsWith(':*')) return startsWithWord(subject, arg.slice(0, -2));
  if (arg.endsWith(' *')) return startsWithWord(subject, arg.slice(0, -2));
  if (arg.endsWith('*')) return subject.startsWith(arg.slice(0, -1));
  return subject === arg;
}

const startsWithWord = (s: string, prefix: string) => s === prefix || s.startsWith(prefix + ' ');

const fullCommand = (input: unknown) => String((input as { command?: unknown })?.command ?? '');

function splitCommand(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||;|\||\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Regra que "Sempre permitir" grava para um pedido: os dois primeiros termos no Bash, a ferramenta nas outras. */
export function suggestRule(toolName: string, input: unknown): string {
  if (toolName === 'Bash') {
    const first = splitCommand(fullCommand(input))[0] ?? '';
    const words = first.split(/\s+/).filter(Boolean);
    const take = words.length > 1 && !words[1]!.startsWith('-') ? 2 : 1;
    return `Bash(${words.slice(0, take).join(' ')}:*)`;
  }
  return toolName;
}

/** Comandos de rede liberados sem regra (o resto pede uma regra explícita). */
const NETWORK = /\b(curl|wget|nc|ncat|telnet|ssh|scp|rsync|ftp)\b/;

/**
 * Negações padrão (seção 12 do plano), aplicadas antes de qualquer regra:
 * push forçado, `rm -r` fora do worktree e comandos de rede sem regra.
 * Devolve o motivo da negação, ou null.
 */
export function defaultDeny(
  toolName: string,
  input: unknown,
  worktree: string | null,
  hasExplicitRule: boolean,
): string | null {
  if (toolName !== 'Bash') {
    const p = (input as { file_path?: unknown })?.file_path;
    if (worktree && typeof p === 'string' && isAbsolute(p) && outside(worktree, p))
      return 'O agente só pode alterar arquivos dentro do próprio worktree.';
    return null;
  }
  const cmd = fullCommand(input);
  for (const part of splitCommand(cmd)) {
    if (/^git\s+push\b/.test(part) && /(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S)/.test(part))
      return 'Push forçado é sempre negado.';
    const rm = /^(?:sudo\s+)?rm\s+(.*)$/.exec(part);
    if (rm && /(^|\s)-[a-zA-Z]*[rR]/.test(rm[1]!)) {
      const targets = rm[1]!.split(/\s+/).filter((t) => t && !t.startsWith('-'));
      const bad = targets.some(
        (t) =>
          t === '/' ||
          t.startsWith('~') ||
          t.includes('$') ||
          (worktree ? outside(worktree, resolve(worktree, t)) : true),
      );
      if (bad) return '`rm -r` fora do worktree é sempre negado.';
    }
    if (NETWORK.test(part) && !hasExplicitRule)
      return 'Comandos de rede precisam de uma regra "Sempre permitir".';
  }
  return null;
}

function outside(root: string, p: string): boolean {
  const rel = relative(resolve(root), resolve(p));
  return rel.startsWith('..') || isAbsolute(rel);
}

/** Regras que vão para `--disallowedTools` ao iniciar o `claude`. */
export const DISALLOWED_TOOLS = [
  'Bash(git push --force:*)',
  'Bash(git push -f:*)',
  'Bash(git push --force-with-lease:*)',
];
