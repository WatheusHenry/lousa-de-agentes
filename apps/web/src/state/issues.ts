import { api, ApiError } from '../api/http.ts';
import { useStore } from './store.ts';

/** Busca as issues abertas de todos os projetos escolhidos (o bridge atualiza o cache local). */
export async function refreshIssues() {
  const st = useStore.getState();
  st.setIssuesLoading(true);
  try {
    const { issues, errors } = await api.issues();
    useStore
      .getState()
      .setIssues(issues, errors.length ? errors.map((e) => `${e.project}: ${e.error}`).join(' · ') : null);
  } catch (err) {
    useStore.setState({
      issuesLoading: false,
      issuesError: err instanceof ApiError ? err.message : 'Falha ao buscar issues.',
    });
  }
}
