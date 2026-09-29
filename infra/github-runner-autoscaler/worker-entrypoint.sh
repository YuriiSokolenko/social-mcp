#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${RUNNER_TOKEN:?RUNNER_TOKEN is required}"
: "${RUNNER_NAME:?RUNNER_NAME is required}"
: "${RUNNER_LABELS:=n150,pi-agent}"

# Pi needs writable state for lock files and refreshed auth/model metadata.
# Seed a private copy from the host-mounted read-only configuration.
if [ -d /pi-config-ro ]; then
  rm -rf /home/runner/.pi/agent
  mkdir -p /home/runner/.pi/agent
  cp -a /pi-config-ro/. /home/runner/.pi/agent/
fi

# The host-mounted Pi config may have an older unpinned adapter installation.
# Overlay the version baked into this image, then pin the package and permit
# project MCP servers for the headless `pi` invocations used by GitHub Actions.
if [ -d /opt/pi-adapter-seed/npm ]; then
  mkdir -p /home/runner/.pi/agent/npm
  cp -a /opt/pi-adapter-seed/npm/. /home/runner/.pi/agent/npm/
  node --input-type=module <<'NODE'
import fs from 'node:fs';

const file = '/home/runner/.pi/agent/settings.json';
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const packages = Array.isArray(settings.packages) ? settings.packages : [];
const version = process.env.PI_MCP_ADAPTER_VERSION;
if (!version) throw new Error('PI_MCP_ADAPTER_VERSION is required');
const adapter = `npm:pi-mcp-adapter@${version}`;
const withoutAdapter = packages.filter((item) => {
  const source = typeof item === 'string' ? item : item?.source;
  return typeof source !== 'string' || !/^npm:pi-mcp-adapter(?:@|$)/.test(source);
});
settings.packages = [adapter, ...withoutAdapter];
// Jobs run in a disposable, per-job container. Trust that job's checkout so
// Pi's headless CI mode loads its project .mcp.json and other project config.
settings.defaultProjectTrust = 'always';
fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });

const adapterConfigFile = '/home/runner/.pi/agent/mcp-adapter.json';
let adapterConfig = {};
try {
  adapterConfig = JSON.parse(fs.readFileSync(adapterConfigFile, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const legacyConfigFile = '/home/runner/.pi/agent/mcp.json';
try {
  const legacyConfig = JSON.parse(fs.readFileSync(legacyConfigFile, 'utf8'));
  // pi-mcp-adapter 3.x moved the global configuration to mcp-adapter.json.
  // Carry over servers and adapter options from the existing host config so
  // the image upgrade does not silently drop Context7/SearXNG or Orbit MCP.
  adapterConfig.mcpServers = { ...(legacyConfig.mcpServers ?? {}), ...(adapterConfig.mcpServers ?? {}) };
  adapterConfig.settings = { ...(legacyConfig.settings ?? {}), ...(adapterConfig.settings ?? {}) };
  for (const [key, value] of Object.entries(legacyConfig)) {
    if (key !== 'mcpServers' && key !== 'settings' && !(key in adapterConfig)) adapterConfig[key] = value;
  }
  fs.renameSync(legacyConfigFile, `${legacyConfigFile}.migrated`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
adapterConfig.settings = { ...(adapterConfig.settings ?? {}), projectServers: 'allow' };
fs.writeFileSync(adapterConfigFile, `${JSON.stringify(adapterConfig, null, 2)}\n`, { mode: 0o600 });
NODE
fi

cd /home/runner/actions-runner

./config.sh \
  --url "https://github.com/${GITHUB_REPOSITORY}" \
  --token "${RUNNER_TOKEN}" \
  --name "${RUNNER_NAME}" \
  --labels "${RUNNER_LABELS}" \
  --work "_work" \
  --ephemeral \
  --unattended \
  --disableupdate

exec ./run.sh
