import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('configuration, status and attachment paths are isolated from the user installation', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-config-isolation-'));
  try {
    const script = `
      import { join } from 'node:path';
      import { existsSync } from 'node:fs';
      import { crewConfigDir } from './src/config-paths.mjs';
      import { writeGlobalConfig } from './src/install/install.mjs';
      import { createShardWriter } from './src/status-shard.mjs';
      if (crewConfigDir() !== process.env.DSHPLUGIN_CREW_CONFIG_DIR) throw new Error('wrong state root');
      writeGlobalConfig({ mode: 'hub', hub_url: 'http://127.0.0.1:3081' });
      const writer = createShardWriter('fixture');
      writer.publish([]);
      if (!existsSync(join(crewConfigDir(), 'status.d'))) throw new Error('status not isolated');
    `;
    const env = { ...process.env, DSHPLUGIN_CREW_CONFIG_DIR: root };
    delete env.DSH_CREW_CONFIG_DIR;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url), env, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).hub_url, 'http://127.0.0.1:3081');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
