import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { defaultSimpClient } from '@imp/client';
import './themeTokens.css';
import { App } from './App';
import { AppleMusicDriver } from './drivers/AppleMusicDriver';

if (
  typeof window !== 'undefined' &&
  typeof document !== 'undefined' &&
  new URLSearchParams(window.location.search).get('sanitized') === '1'
) {
  document.documentElement.dataset.sanitized = '1';
}

const isDedicatedAppleWorker =
  typeof window !== 'undefined' &&
  (new URLSearchParams(window.location.search).get('worker') === 'apple' ||
    window.location.pathname.startsWith('/apple-worker'));

if (isDedicatedAppleWorker && typeof document !== 'undefined') {
  document.title = 'Imp Headless Audio Worker';
}

const HeadlessAppleWorker: React.FC = () => {
  useEffect(() => {
    document.title = 'Imp Headless Audio Worker';
    defaultSimpClient.connect();
  }, []);
  return <AppleMusicDriver />;
};

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <React.StrictMode>
      {isDedicatedAppleWorker ? <HeadlessAppleWorker /> : <App />}
    </React.StrictMode>
  );
}

