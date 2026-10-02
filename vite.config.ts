import { defineConfig, type UserConfig } from 'vite';
import { qwikVite } from '@builder.io/qwik/optimizer';
import { qwikCity } from '@builder.io/qwik-city/vite';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig((): UserConfig => ({
  plugins: [qwikCity(), qwikVite(), tsconfigPaths({ root: '.' })],
  server: { host: '0.0.0.0', port: 62029, headers: { 'Cache-Control': 'public, max-age=0' } },
  preview: { host: '0.0.0.0', port: 62029, headers: { 'Cache-Control': 'public, max-age=600' } }
}));
