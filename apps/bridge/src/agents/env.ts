/**
 * Variáveis que uma sessão do Claude Code põe no ambiente dos processos filhos. Se o bridge
 * roda dentro de um terminal do Claude Code, o `claude` dos agentes herdaria a identidade
 * dessa sessão (o mesmo session_id, por exemplo). Removemos só essas; login, provedor
 * (Bedrock, Vertex…) e o resto da configuração do usuário continuam.
 */
const SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES',
  'CLAUDE_CODE_TEE_SDK_STDOUT',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_PID',
];

/** Variáveis do bridge que os agentes não devem ver (o token do GitLab, por exemplo). */
const BRIDGE_VARS = /^AGENT_CANVAS_/;

export function cleanClaudeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (SESSION_VARS.includes(k) || BRIDGE_VARS.test(k)) continue;
    out[k] = v;
  }
  return out;
}
