import tailwindcss from '@tailwindcss/postcss';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const edgeoneRoot = fileURLToPath(new URL('.', import.meta.url));
const publicRoot = fileURLToPath(new URL('../public', import.meta.url));

// EdgeOne Pages receives a browser-only React bundle. Keeping this entry
// independent from Vinext/Next prevents the OpenNext server hook from being
// selected for a static deployment.
export default defineConfig({
  root: edgeoneRoot,
  base: '/',
  define: {
    'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(
      process.env.NEXT_PUBLIC_API_URL ?? process.env.VITE_API_URL ?? '',
    ),
  },
  plugins: [react()],
  publicDir: publicRoot,
  css: {
    postcss: {
      plugins: [tailwindcss()],
    },
  },
  build: {
    outDir: 'build',
    emptyOutDir: true,
  },
});
