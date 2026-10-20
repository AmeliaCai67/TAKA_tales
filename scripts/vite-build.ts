// Build-only gzip: read the final files after all Vite/Rollup transforms have finished.
import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

export function compressedAssets() {
    let outDir = '';
    return {
        name: 'taka-compressed-assets',
        apply: 'build' as const,
        enforce: 'post' as const,
        configResolved(config: { root: string; build: { outDir: string } }) {
            outDir = resolve(config.root, config.build.outDir);
        },
        writeBundle(_options: unknown, bundle: Record<string, { type: string }>) {
            for (const name of Object.keys(bundle)) {
                if (!/\.(js|css|html|json|svg)$/.test(name)) continue;
                const bytes = readFileSync(join(outDir, name));
                if (bytes.byteLength < 1024) continue;
                const compressed = gzipSync(bytes, { level: 9 });
                if (compressed.byteLength < bytes.byteLength) writeFileSync(join(outDir, name + '.gz'), compressed);
            }
        },
    };
}
