import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { LoadingProvider } from './contexts/LoadingContext';
import { enrollAdminTokenFromHash } from './lib/apiClient';
import './index.css';

enrollAdminTokenFromHash();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LoadingProvider>
      <App />
    </LoadingProvider>
  </StrictMode>,
);
