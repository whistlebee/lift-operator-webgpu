import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const engine = readFileSync(new URL('../dist/engine-core.js', import.meta.url), 'utf8');
const mode = /<script id="bogeo-viewer-mode">([\s\S]*?)<\/script>/.exec(html);
const startup = /\/\/ STARTUP CALLS\n([\s\S]*?)\nwindow\.encodePayload =/.exec(engine);
assert(mode && mode.index < html.indexOf('src="engine-core.js"'));
assert(startup);

function startPage(path) {
    const window = { location: new URL(path, 'https://example.test/lift/'), history: {}, addEventListener };
    const timers = [];
    let onReady;
    function addEventListener(event, handler) {
        assert.equal(event, 'DOMContentLoaded');
        onReady = handler;
    }
    window.history.replaceState = (_state, _title, url) => { window.location = url; };
    const context = {
        window, URL, URLSearchParams, Registry: { pendingManifest: [] }, gameTick() {}, animationTick() {},
        setInterval: (_callback, ms) => timers.push(ms),
        requestAnimationFrame: () => timers.push('animation'),
    };
    runInNewContext(mode[1] + '\n' + startup[1], context);
    onReady();
    return { url: window.location, timers };
}

test('bare viewer URL disables both native clocks before the engine starts', () => {
    const { url, timers } = startPage('./?round=23&seed=42#game');
    assert.equal(url.href, 'https://example.test/lift/?round=23&seed=42&simulation=true#game');
    assert.deepEqual(timers, []);
});

test('manual game keeps its native clocks and nested simulation realms remain unchanged', async () => {
    const manual = startPage('./?simulation=false');
    const realm = startPage('./?simulation=true&realm=1');
    assert.deepEqual(manual.timers, [1000, 'animation']);
    assert.deepEqual(realm.timers, []);
    for (const { url } of [manual, realm]) {
        globalThis.location = url;
        try {
            // No document or GPU is present: the policy entry must do nothing here.
            await import(new URL(`../dist/bogeo-webgpu.mjs?test=${url.searchParams.get('simulation')}`, import.meta.url));
        } finally {
            delete globalThis.location;
        }
    }
});
