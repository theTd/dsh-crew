import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pluginEnv } from './plugin-env.mjs';

/** All plugin-owned runtime state shares one overridable root. */
export function crewConfigDir() {
  const configured = pluginEnv('CREW_CONFIG_DIR');
  if (configured === undefined) return join(homedir(), '.config', 'dsh-crew');
  if (!configured || !isAbsolute(configured)) {
    throw new Error('DSHPLUGIN_CREW_CONFIG_DIR must be a non-empty absolute path');
  }
  return configured;
}
