import { useEffect, useState } from 'react';
import type { AgentSettings, AgentSettingsInput } from '@agent-canvas/shared';
import { api, ApiError } from '../api/http.ts';
import { Select } from '../components/Select.tsx';
import { disableNotify, enableNotify, notifySupported, notifyWanted } from '../notify.ts';
import { useStore } from '../state/store.ts';
import { onThemeChange, setThemePref, themePref, type ThemePref } from '../theme.ts';

const MODELS = ['opus', 'sonnet', 'haiku'];
const THEMES: [ThemePref, string][] = [
  ['system', 'Do sistema'],
  ['light', 'Claro'],
  ['dark', 'Escuro'],
];
/** Campos numéricos: chave, rótulo, unidade e o fator entre o valor guardado e o mostrado. */
const FIELDS: { key: Exclude<keyof AgentSettings, 'model'>; label: string; unit: string; k: number }[] = [
  { key: 'maxRunning', label: 'Agentes ao mesmo tempo', unit: 'agentes', k: 1 },
  { key: 'maxAgentMinutes', label: 'Tempo máximo de um agente', unit: 'min', k: 1 },
  { key: 'treeTokenBudget', label: 'Orçamento de uma árvore de agentes', unit: 'mil tokens', k: 1000 },
  { key: 'contextBudget', label: 'Contexto recomendado por agente', unit: 'mil tokens', k: 1000 },
];

const toForm = (a: AgentSettings) =>
  Object.fromEntries(FIELDS.map((f) => [f.key, String(Math.round(a[f.key] / f.k))])) as Record<
    string,
    string
  >;

/** Modelo e limites dos agentes (antes só por variável de ambiente), mais os avisos do sistema. */
export function AgentSettingsForm() {
  const settings = useStore((s) => s.settings)!;
  const cur = settings.agents;
  const def = settings.agentDefaults;
  const [form, setForm] = useState(() => toForm(cur));
  const [model, setModel] = useState(cur.model ?? '');
  const [saving, setSaving] = useState(false);
  const [notify, setNotify] = useState(
    () => notifyWanted() && notifySupported() && Notification.permission === 'granted',
  );
  const [notifyMsg, setNotifyMsg] = useState<string | null>(null);
  const [theme, setTheme] = useState(themePref);
  useEffect(() => onThemeChange(setTheme), []);

  const patch: AgentSettingsInput = {};
  for (const f of FIELDS) {
    const v = Math.round(Number(form[f.key]) * f.k);
    if (form[f.key] !== '' && Number.isFinite(v) && v !== cur[f.key]) patch[f.key] = v;
  }
  if ((model || null) !== cur.model) patch.model = model || null;
  const dirty = Object.keys(patch).length > 0;

  async function save(p: AgentSettingsInput) {
    setSaving(true);
    try {
      const view = await api.setAgentSettings(p);
      useStore.getState().setSettings(view);
      setForm(toForm(view.agents));
      setModel(view.agents.model ?? '');
      useStore.getState().showToast('Configurações dos agentes salvas. Valem para os próximos turnos.', {
        label: 'Ok',
        run: () => {},
      });
    } catch (e) {
      useStore
        .getState()
        .showToast(e instanceof ApiError ? e.message : 'Falha ao salvar.', { label: 'Ok', run: () => {} });
    } finally {
      setSaving(false);
    }
  }

  async function toggleNotify(on: boolean) {
    setNotifyMsg(null);
    if (!on) {
      disableNotify();
      setNotify(false);
      return;
    }
    const p = await enableNotify();
    setNotify(p === 'granted');
    if (p === 'denied')
      setNotifyMsg('O navegador bloqueou as notificações deste site. Libere nas permissões do site.');
    if (p === 'unsupported') setNotifyMsg('Este navegador não tem notificações.');
  }

  const custom = cur.model && !MODELS.includes(cur.model) ? [cur.model] : [];
  return (
    <>
      <div className="grp">
        <h4>Aparência</h4>
        <div className="chips" role="group" aria-label="Tema">
          {THEMES.map(([v, label]) => (
            <button key={v} className="chip" aria-pressed={theme === v} onClick={() => setThemePref(v)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="grp">
        <h4>Avisos</h4>
        <div className="rules">
          <label className="rule">
            <span className="rule-tx">
              <span className="rule-when">Notificações do sistema</span>
              <span className="lab">
                Com o canvas em segundo plano: pedido de permissão, pergunta, agente concluído ou com erro, MR
                pronto e pipeline com falha.
              </span>
            </span>
            <span className="switch">
              <input
                type="checkbox"
                checked={notify}
                onChange={(e) => void toggleNotify(e.target.checked)}
                aria-label="Notificações do sistema"
              />
              <i />
            </span>
          </label>
        </div>
        {notifyMsg && (
          <p className="lab" style={{ margin: 0, color: 'var(--bad)' }}>
            {notifyMsg}
          </p>
        )}
      </div>
      <div className="grp agent-cfg">
        <h4>Agentes</h4>
        <div className="cfg-row">
          <span>Modelo</span>
          <Select
            label="Modelo"
            value={model}
            onChange={setModel}
            options={[
              { value: '', label: `Padrão${def.model ? ` (${def.model})` : ''}` },
              ...[...MODELS, ...custom].map((m) => ({ value: m, label: m })),
            ]}
          />
        </div>
        {FIELDS.map((f) => (
          <label className="cfg-row" key={f.key}>
            <span>{f.label}</span>
            <span className="cfg-in">
              <input
                className="field"
                type="number"
                min={1}
                inputMode="numeric"
                value={form[f.key]}
                placeholder={String(Math.round(def[f.key] / f.k))}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
              />
              <small>{f.unit}</small>
            </span>
          </label>
        ))}
        <p className="lab" style={{ margin: 0 }}>
          Vale a partir do próximo turno de cada agente. Os padrões vêm das variáveis de ambiente
          (AGENT_CANVAS_*).
        </p>
        <div className="act-btns">
          <button className="btn sm primary" disabled={!dirty || saving} onClick={() => void save(patch)}>
            {saving ? 'Salvando…' : 'Salvar'}
          </button>
          <button
            className="btn sm plain"
            disabled={saving}
            onClick={() =>
              void save({
                model: null,
                maxRunning: null,
                maxAgentMinutes: null,
                treeTokenBudget: null,
                contextBudget: null,
              })
            }
          >
            Voltar ao padrão
          </button>
        </div>
      </div>
    </>
  );
}
