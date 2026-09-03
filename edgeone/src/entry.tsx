import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Home from '../../app/page';
import './styles.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('期鉴应用缺少 root 容器');
}

createRoot(root).render(
  <StrictMode>
    <Home />
  </StrictMode>,
);
