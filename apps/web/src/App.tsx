import { useEffect, useState } from 'react';
import { api, ApiError, sessionToken } from './api/http.ts';
import { SettingsScreen } from './settings/SettingsScreen.tsx';
import { useStore } from './state/store.ts';
import { Workspace } from './Workspace.tsx';
import { BridgeSocket } from './ws/client.ts';
import { notifyFor } from './notify.ts';

export function App() {
  const settings = useStore((s) => s.settings);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => {
    const token = sessionToken();
    if (!token) {
      setFatal('O bridge não está rodando. Rode pnpm dev na raiz do projeto e recarregue a página.');
      return;
    }
    const st = useStore.getState();
    // depois de uma queda (bridge reiniciou), o estado volta inteiro: o que mudou no meio se perdeu
    let opened = false;
    const onMessage = (m: Parameters<typeof st.applyServer>[0]) => {
      notifyFor(m, useStore.getState());
      useStore.getState().applyServer(m);
    };
    const socket = new BridgeSocket(token, onMessage, (c) => {
      useStore.getState().setConnection(c);
      if (c !== 'open') return;
      if (opened)
        void api
          .state()
          .then((snap) => useStore.getState().loadSnapshot(snap))
          .catch(() => {});
      opened = true;
    });
    st.setSender(socket);
    api
      .state()
      .then((snap) => {
        useStore.getState().loadSnapshot(snap);
        socket.connect();
      })
      .catch((err) => setFatal(err instanceof ApiError ? err.message : 'Falha ao carregar o estado.'));
    return () => {
      socket.close();
      useStore.getState().setSender(null);
    };
  }, []);

  if (fatal)
    return (
      <div className="setup">
        <div className="setup-card">
          <h2>Sem conexão com o bridge</h2>
          <p className="lead">{fatal}</p>
          <div className="row-end">
            <button className="btn primary" onClick={() => location.reload()}>
              Recarregar
            </button>
          </div>
        </div>
      </div>
    );
  if (!settings) return null;

  const needsSetup = !settings.configured || settings.projects.length === 0;
  const st = useStore.getState();
  return (
    <>
      {!needsSetup && <Workspace />}
      {(needsSetup || settingsOpen) && (
        <SettingsScreen
          settings={settings}
          modal={!needsSetup}
          onSaved={st.setSettings}
          {...(needsSetup ? {} : { onClose: () => st.setSettingsOpen(false) })}
        />
      )}
    </>
  );
}
