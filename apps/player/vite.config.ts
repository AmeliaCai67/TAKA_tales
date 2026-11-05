import { defineConfig } from 'vite';
import { compressedAssets } from '../../scripts/vite-build';

export default defineConfig({
    base: './',
    server: process.env.TAKA_CH05_PREVIEW === '1' ? {host:'127.0.0.1',port:8942,strictPort:true,proxy:{'/api/naming':'http://127.0.0.1:8943','/api/tts':'http://127.0.0.1:8943','/api':'http://127.0.0.1:8000'}} : undefined,
    plugins: [compressedAssets()],
    build: {
        target: 'es2020',
        cssCodeSplit: true,
        rollupOptions: {
            output: { manualChunks: id => id.includes('/node_modules/i18next/') ? 'i18n-vendor' : undefined },
        },
    },
});
