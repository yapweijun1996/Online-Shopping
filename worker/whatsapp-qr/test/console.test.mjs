import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('entry suppresses dependency console output before dependency evaluation', () => {
  const source = `
    import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (url.includes('/node_modules/') && url.endsWith('.js') && result.format === 'module') {
        return { ...result, source: 'console.info({ rootKey: "fictional-root-key" });\\n' + result.source };
      }
      return result;
    }});
    await import(${JSON.stringify(new URL('../src/main.js', import.meta.url).href)});
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, WHATSAPP_QR_URL: '', WHATSAPP_QR_TOKEN_FILE: '' }
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.ok(!`${result.stdout}${result.stderr}`.includes('fictional-root-key'), 'dependency rootKey leaked to process output');
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, '{"state":"ERROR","code":"WORKER_FAILED"}\n');
});
