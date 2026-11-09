import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const game = join(root, 'game');
if (!existsSync(join(game, '.git'))) {
    throw new Error('Initialize the game submodule with git submodule update --init');
}
const revision = execFileSync('git', ['rev-parse', 'HEAD:game'], { cwd: root, encoding: 'utf8' }).trim();
const staging = mkdtempSync(join(root, '.site-build-'));
const site = join(staging, 'site');

try {
    mkdirSync(site);
    const archive = join(staging, 'game.tar');
    execFileSync('git', ['archive', '--format=tar', '--output=' + archive, revision], { cwd: game, stdio: 'inherit' });
    execFileSync('tar', ['-xf', archive, '-C', site], { stdio: 'inherit' });
    rmSync(join(site, '.github'), { recursive: true, force: true });
    copyFileSync(join(site, 'README.md'), join(site, 'UPSTREAM_README.md'));

    for (const name of [
        '.nojekyll', 'README.md', 'bogeo-adapter.js', 'bogeo-driver.js',
        'bogeo-shop.js', 'bogeo-webgpu.mjs', 'evaluation.json',
        'policy-manifest.json', 'policy', 'webgpu',
    ]) {
        cpSync(join(root, name), join(site, name), { recursive: true });
    }

    const page = join(site, 'index.html');
    const html = readFileSync(page, 'utf8');
    if (!html.includes('</body>')) throw new Error('Upstream index.html is missing its closing body tag');
    const integration = '<script src="./bogeo-adapter.js"></script>'
        + '<script src="./bogeo-shop.js"></script>'
        + '<script type="module" src="./bogeo-webgpu.mjs?distilled=1"></script>';
    writeFileSync(page, html.replace('</body>', integration + '</body>'));

    const output = join(root, 'dist');
    rmSync(output, { recursive: true, force: true });
    renameSync(site, output);
    console.log('Built dist/ from Lift Operator ' + revision);
} finally {
    rmSync(staging, { recursive: true, force: true });
}
