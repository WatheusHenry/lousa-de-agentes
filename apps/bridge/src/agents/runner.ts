/**
 * Motor que roda um agente. A implementação atual usa o processo `claude` (cli-runner.ts);
 * outra, com o @anthropic-ai/claude-agent-sdk, pode entrar atrás desta mesma interface.
 * O runner entrega as linhas do stream-json como vieram; quem interpreta é o supervisor.
 */
export interface RunnerStartOptions {
  cwd: string;
  /** Sessão nova com este id, ou retomada dele (`resume`). */
  sessionId: string;
  resume: boolean;
  mcpConfigPath: string;
  permissionPromptTool: string;
  appendSystemPrompt: string;
  allowedTools: string[];
  disallowedTools: string[];
  model?: string;
}

export interface RunnerHandlers {
  onLine(line: string): void;
  onExit(info: { code: number | null; signal: NodeJS.Signals | null; stderr: string }): void;
}

export interface AgentProcess {
  /** Mensagem do usuário, no formato stream-json de entrada. */
  send(text: string): void;
  /** Interrompe o turno atual (control_request do tipo interrupt). */
  interrupt(): void;
  /** Fecha a entrada: o processo termina depois do turno atual. */
  endInput(): void;
  /** Encerra o processo (SIGINT, depois SIGTERM). */
  kill(): void;
}

export interface AgentRunner {
  start(opts: RunnerStartOptions, handlers: RunnerHandlers): AgentProcess;
}
