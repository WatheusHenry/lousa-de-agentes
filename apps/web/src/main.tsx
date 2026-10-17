import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/base.css';
import './styles/tokens.css';
import './styles/app.css';
import { App } from './App.tsx';
import { applyTheme } from './theme.ts';

applyTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
