/**
 * Grava saídas reais do `claude -p --output-format stream-json` em src/agents/__fixtures__.
 * Rode de novo quando a versão do Claude Code mudar:
 *
 *   pnpm --filter @agent-canvas/bridge exec tsx scripts/record-fixtures.ts [--model haiku]
 *
 * Usa um repositório git temporário e um servidor MCP local com a ferramenta `approve`
 * (a mesma ideia do --permission-prompt-tool do canvas): permite tudo, menos `rm`.
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { cleanClaudeEnv } from '../src/agents/env.ts';

const model = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1]! : 'haiku';
const out = new URL('../src/agents/__fixtures__/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });

// ---------- servidor MCP de teste ----------
const approvals: unknown[] = [];
function makeMcp() {
  const server = new McpServer({ name: 'canvas', version: '0.0.0' });
  server.registerTool(
    'approve',
    {
      description: 'Decide pedidos de permissão',
      inputSchema: {
        tool_name: z.string(),
        input: z.record(z.string(), z.unknown()),
        tool_use_id: z.string().optional(),
      },
    },
    async (args) => {
      approvals.push(args);
      const cmd = String((args.input as { command?: string }).command ?? '');
      const decision = /\brm\b/.test(cmd)
        ? { behavior: 'deny', message: 'Negado pelo usuário no canvas.' }
        : { behavior: 'allow', updatedInput: args.input };
      return { content: [{ type: 'text', text: JSON.stringify(decision) }] };
    },
  );
  return server;
}
const http = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = makeMcp();
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
});
await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
const port = (http.address() as AddressInfo).port;

// ---------- repositório de teste ----------
const repo = mkdtempSync(join(tmpdir(), 'ac-fixture-repo-'));
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'fixture@example.com');
git('config', 'user.name', 'Fixture');
writeFileSync(join(repo, 'hello.txt'), 'olá do repositório de teste\n');
writeFileSync(join(repo, 'notes.txt'), 'não apague\n');
writeFileSync(
  join(repo, 'package.json'),
  JSON.stringify({ name: 'fx', scripts: { test: 'node -e "console.log(\'1 passed\')"' } }),
);
git('add', '.');
git('commit', '-qm', 'inicial');

const mcpConfig = JSON.stringify({
  mcpServers: { canvas: { type: 'http', url: `http://127.0.0.1:${port}/mcp` } },
});

interface Run {
  name: string;
  /** Sessão nova com este id, ou retomada com --resume. */
  session: { id: string; resume?: boolean };
  args?: string[];
  /** Mensagens enviadas pelo stdin; função recebe as linhas já lidas e decide quando mandar. */
  script: (send: (o: unknown) => void, lines: Record<string, unknown>[], end: () => void) => void;
}

function userMsg(text: string) {
  return { type: 'user', message: { role: 'user', content: text } };
}

async function record(run: Run): Promise<Record<string, unknown>[]> {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    model,
    '--mcp-config',
    mcpConfig,
    '--strict-mcp-config',
    '--permission-prompt-tool',
    'mcp__canvas__approve',
    '--permission-mode',
    'default',
    ...(run.session.resume ? ['--resume', run.session.id] : ['--session-id', run.session.id]),
    ...(run.args ?? []),
  ];
  const child = spawn('claude', args, {
    cwd: repo,
    env: cleanClaudeEnv(process.env),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  let buf = '';
  let ended = false;
  const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + '\n');
  const end = () => {
    if (!ended) {
      ended = true;
      child.stdin.end();
    }
  };
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      raw.push(line);
      try {
        lines.push(JSON.parse(line));
      } catch {
        lines.push({ __unparsed: line });
      }
      run.script(send, lines, end);
    }
  });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  run.script(send, lines, end);
  const timer = setTimeout(() => child.kill('SIGINT'), 180_000);
  const code = await new Promise<number | null>((r) => child.on('close', r));
  clearTimeout(timer);
  writeFileSync(join(out, `${run.name}.jsonl`), scrub(raw.join('\n') + '\n'));
  console.log(
    `${run.name}: ${raw.length} linhas, saída ${code}${stderr ? `, stderr: ${stderr.slice(0, 300)}` : ''}`,
  );
  return lines;
}

/** Tira da fixture o que é desta máquina: caminhos, socket e ids de sessão. */
const sessionNames = new Map<string, string>();
function scrub(text: string): string {
  let t = text.split(repo).join('/tmp/fixture-repo');
  t = t.replace(/"messaging_socket_path":"[^"]*"/g, '"messaging_socket_path":null');
  for (const [id, name] of sessionNames) t = t.split(id).join(name);
  return t;
}
function newSession(label: string) {
  const id = crypto.randomUUID();
  const fixed = `00000000-0000-4000-8000-${String(sessionNames.size + 1).padStart(12, '0')}`;
  sessionNames.set(id, fixed);
  void label;
  return id;
}

const results = (lines: Record<string, unknown>[]) => lines.filter((l) => l.type === 'result').length;

// 1. turno com ferramentas: ler arquivo, rodar teste (permitido pelo MCP), apagar (negado), e uma segunda mensagem
await record({
  name: 'tools-permission',
  session: { id: newSession('tools') },
  script: (send, lines, end) => {
    if (lines.length === 0)
      send(
        userMsg(
          'Faça exatamente isto, em ordem, sem perguntar: 1) leia hello.txt; 2) rode `npm test` com Bash; ' +
            '3) rode `rm notes.txt` com Bash; 4) responda numa linha o que aconteceu.',
        ),
      );
    if (results(lines) === 1 && !lines.some((l) => l.__sent2)) {
      lines.push({ __sent2: true });
      send(
        userMsg(
          'Agora crie bye.txt com o texto "tchau" e faça um commit com a mensagem "bye". Responda numa linha.',
        ),
      );
    }
    if (results(lines) === 2) end();
  },
});

// 2. interrupção no meio do turno
let interrupted = false;
const interruptSession = newSession('interrupt');
await record({
  name: 'interrupt',
  session: { id: interruptSession },
  script: (send, lines, end) => {
    if (lines.length === 0) send(userMsg('Rode `sleep 20 && echo fim` com Bash e depois diga "pronto".'));
    const toolStarted = lines.some(
      (l) =>
        l.type === 'assistant' &&
        JSON.stringify((l.message as { content?: unknown })?.content ?? '').includes('"tool_use"'),
    );
    if (toolStarted && !interrupted) {
      interrupted = true;
      setTimeout(
        () => send({ type: 'control_request', request_id: 'int-1', request: { subtype: 'interrupt' } }),
        1500,
      );
    }
    if (results(lines) >= 1) end();
  },
});

// 3. retomar a sessão interrompida com --resume
await record({
  name: 'resume',
  session: { id: interruptSession, resume: true },
  script: (send, lines, end) => {
    if (lines.length === 0) send(userMsg('Continue de onde parou. Responda numa linha.'));
    if (results(lines) >= 1) end();
  },
});

writeFileSync(join(out, 'approve-calls.json'), scrub(JSON.stringify(approvals, null, 2) + '\n'));
console.log('chamadas ao approve:', approvals.length, '· repositório de teste em', repo);
http.close();
