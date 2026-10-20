import { defineConfig } from 'vite';
import { compressedAssets } from '../../scripts/vite-build';

export default defineConfig({
    base: './',
    plugins: [compressedAssets()],
    build: {
        target: 'es2020',
        cssCodeSplit: true,
        rollupOptions: {
            output: { manualChunks: id => id.includes('/node_modules/i18next/') ? 'i18n-vendor' : undefined },
        },
    },
});
