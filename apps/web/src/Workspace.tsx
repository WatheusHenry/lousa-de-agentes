import { useStore } from './state/store.ts';

/** Área de trabalho. Na Fase 0, só confirma a conexão; o canvas chega na Fase 1. */
export function Workspace() {
  const settings = useStore((s) => s.settings)!;
  const connection = useStore((s) => s.connection);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  return (
    <div className="setup">
      <div className="setup-card">
        <h2>Pronto</h2>
        <p className="lead">
          {settings.mode === 'demo' ? 'Dados de exemplo' : `Conectado como @${settings.user?.username}`} ·{' '}
          {settings.projects.length} projeto(s) · WebSocket {connection === 'open' ? 'conectado' : connection}
        </p>
        <div className="row-end">
          <button className="btn" onClick={() => setSettingsOpen(true)}>
            Configurações
          </button>
        </div>
      </div>
    </div>
  );
}
