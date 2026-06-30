import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = process.cwd();
const source = resolve(root, 'manifest.json');
const target = resolve(root, 'dist', 'manifest.json');

await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
