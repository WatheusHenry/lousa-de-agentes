import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export class BrowseError extends Error {}

export interface DirEntry {
  name: string;
  path: string;
  /** Tem `.git`: é um clone. */
  isRepo: boolean;
}

export interface DirListing {
  path: string;
  parent: string | null;
  home: string;
  entries: DirEntry[];
  /** A própria pasta é um clone. */
  isRepo: boolean;
}

const MAX_ENTRIES = 500;
export const expandHome = (p: string) => resolve(p.replace(/^~(?=$|\/)/, homedir()));

/**
 * Subpastas de uma pasta, para o seletor de pastas do front-end (o navegador não revela
 * caminhos reais). Só nomes de pastas; nenhum conteúdo de arquivo sai daqui.
 */
export function listDirs(raw: string | undefined, showHidden = false): DirListing {
  const path = expandHome(raw?.trim() || '~');
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new BrowseError(`A pasta ${path} não existe.`);
  }
  if (!st.isDirectory()) throw new BrowseError(`${path} não é uma pasta.`);
  let names: import('node:fs').Dirent[];
  try {
    names = readdirSync(path, { withFileTypes: true });
  } catch {
    throw new BrowseError(`Sem permissão para ler ${path}.`);
  }
  const entries: DirEntry[] = [];
  for (const d of names) {
    if (!showHidden && d.name.startsWith('.')) continue;
    const full = join(path, d.name);
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) {
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!isDir) continue;
    entries.push({ name: d.name, path: full, isRepo: existsSync(join(full, '.git')) });
    if (entries.length >= MAX_ENTRIES) break;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }));
  const parent = dirname(path);
  return {
    path,
    parent: parent === path ? null : parent,
    home: homedir(),
    entries,
    isRepo: existsSync(join(path, '.git')),
  };
}

const onPath = (bin: string) =>
  (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, bin)));

/** Qual seletor de pastas nativo dá para abrir nesta máquina (o bridge roda no desktop do usuário). */
export function nativePicker(): 'zenity' | 'kdialog' | 'osascript' | null {
  if (platform() === 'darwin') return 'osascript';
  if (platform() !== 'linux' || !(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) return null;
  if (onPath('zenity')) return 'zenity';
  if (onPath('kdialog')) return 'kdialog';
  return null;
}

/** Abre o seletor de pastas do sistema; devolve o caminho escolhido ou null se cancelar. */
export async function pickNative(title: string, start?: string): Promise<string | null> {
  const kind = nativePicker();
  if (!kind) throw new BrowseError('Não há seletor de pastas do sistema disponível.');
  const from = start && existsSync(expandHome(start)) ? expandHome(start) : homedir();
  const [cmd, args]: [string, string[]] =
    kind === 'zenity'
      ? ['zenity', ['--file-selection', '--directory', `--title=${title}`, `--filename=${from}/`]]
      : kind === 'kdialog'
        ? ['kdialog', ['--getexistingdirectory', from, '--title', title]]
        : [
            'osascript',
            [
              '-e',
              `POSIX path of (choose folder with prompt ${JSON.stringify(title)} default location POSIX file ${JSON.stringify(from)})`,
            ],
          ];
  try {
    const { stdout } = await exec(cmd, args, { timeout: 10 * 60_000 });
    const path = stdout.trim().replace(/\/$/, '');
    return path || null;
  } catch (err) {
    // cancelar fecha o diálogo com código 1 (zenity, kdialog) ou erro -128 (osascript)
    const e = err as { code?: number; stderr?: string };
    if (e.code === 1 || /-128/.test(e.stderr ?? '')) return null;
    throw new BrowseError('O seletor de pastas do sistema falhou.');
  }
}
