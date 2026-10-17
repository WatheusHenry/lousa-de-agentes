import { spawn } from 'node:child_process';
import { cleanClaudeEnv } from './env.ts';
import type { AgentProcess, AgentRunner, RunnerHandlers, RunnerStartOptions } from './runner.ts';

/** Quanto o `claude` espera por uma ferramenta MCP: a aprovação humana pode demorar. */
const MCP_TOOL_TIMEOUT_MS = String(24 * 60 * 60 * 1000);

/** Monta os argumentos do `claude` (separado para testar sem rodar o processo). */
export function claudeArgs(o: RunnerStartOptions): string[] {
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    // texto em pedaços enquanto o modelo escreve (o canvas mostra ao vivo, sem gravar)
    '--include-partial-messages',
    o.resume ? '--resume' : '--session-id',
    o.sessionId,
    '--mcp-config',
    o.mcpConfigPath,
    '--strict-mcp-config',
    '--permission-prompt-tool',
    o.permissionPromptTool,
    '--permission-mode',
    'default',
    '--append-system-prompt',
    o.appendSystemPrompt,
    ...(o.allowedTools.length ? ['--allowedTools', o.allowedTools.join(',')] : []),
    ...(o.disallowedTools.length ? ['--disallowedTools', o.disallowedTools.join(',')] : []),
    ...(o.addDirs?.length ? ['--add-dir', ...o.addDirs] : []),
    ...(o.model ? ['--model', o.model] : []),
  ];
}

/** Roda o agente com o `claude` instalado e logado do usuário, em modo headless. */
export class CliRunner implements AgentRunner {
  constructor(private readonly bin = process.env.AGENT_CANVAS_CLAUDE_BIN || 'claude') {}

  start(opts: RunnerStartOptions, h: RunnerHandlers): AgentProcess {
    const child = spawn(this.bin, claudeArgs(opts), {
      cwd: opts.cwd,
      env: {
        ...cleanClaudeEnv(process.env),
        MCP_TOOL_TIMEOUT: MCP_TOOL_TIMEOUT_MS,
        // versões novas do claude também abortam uma ferramenta parada há 5 min sem progresso,
        // o que derrubava pedidos de permissão esperando o usuário
        CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: MCP_TOOL_TIMEOUT_MS,
        // as ferramentas do canvas carregam já no início: sem ToolSearch a cada sessão
        ENABLE_TOOL_SEARCH: 'false',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    let stderr = '';
    let inputOpen = true;
    let reqSeq = 0;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) h.onLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      stderr = (stderr + d).slice(-4000);
    });
    child.stdin.on('error', () => {
      inputOpen = false;
    });
    let exited = false;
    child.on('error', (err) => {
      if (exited) return;
      exited = true;
      const msg =
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? `Não encontrei o comando "${this.bin}". Instale o Claude Code e faça login.`
          : err.message;
      h.onExit({ code: null, signal: null, stderr: msg });
    });
    child.on('close', (code, signal) => {
      if (exited) return;
      exited = true;
      if (buf.trim()) h.onLine(buf.trim());
      h.onExit({ code, signal, stderr });
    });
    const write = (o: unknown) => {
      if (inputOpen && child.stdin.writable) child.stdin.write(JSON.stringify(o) + '\n');
    };
    return {
      send: (text) => write({ type: 'user', message: { role: 'user', content: text } }),
      interrupt: () =>
        write({ type: 'control_request', request_id: `int-${++reqSeq}`, request: { subtype: 'interrupt' } }),
      endInput: () => {
        if (inputOpen) {
          inputOpen = false;
          child.stdin.end();
        }
      },
      kill: () => {
        if (exited) return;
        child.kill('SIGINT');
        setTimeout(() => !exited && child.kill('SIGTERM'), 3000).unref();
      },
    };
  }
}
