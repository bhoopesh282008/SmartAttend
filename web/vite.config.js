import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `npm run dev:https` serves the app over HTTPS with a self-signed certificate. A phone
// only allows the camera and GPS on https (or localhost), so use it to try the real flow
// from a phone on the same Wi-Fi. The browser will warn once about the certificate.
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'https' ? [basicSsl()] : [])],
  server: {
    port: 5180,
    strictPort: true,
    host: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3001', xfwd: true },
    },
  },
  // The face library (about 1.3 MB) is its own chunk, loaded only when someone enrols or takes a face check.
  build: { sourcemap: false, chunkSizeWarningLimit: 1500 },
}));
