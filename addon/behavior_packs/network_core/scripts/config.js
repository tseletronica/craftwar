import { variables } from '@minecraft/server-admin';

function readStringVariable(name, fallback) {
  const value = variables.get(name);
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim();
  return normalized || fallback;
}

function readNumberVariable(name, fallback) {
  const value = Number(variables.get(name));
  return Number.isFinite(value) ? value : fallback;
}

function readBooleanVariable(name, fallback) {
  const value = variables.get(name);
  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function readListVariable(name) {
  const value = variables.get(name);
  if (typeof value !== 'string') {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export const NETWORK_CONFIG = {
  baseUrl: readStringVariable('networkBaseUrl', 'http://api:8080'),
  serverSlug: readStringVariable('serverSlug', 'capital'),
  transferHost: readStringVariable('transferHost', ''),
  capitalPort: readNumberVariable('capitalPort', 19132),
  arenasPort: readNumberVariable('arenasPort', 19133),
  firePort: readNumberVariable('firePort', 19134),
  waterPort: readNumberVariable('waterPort', 19135),
  earthPort: readNumberVariable('earthPort', 19136),
  airPort: readNumberVariable('airPort', 19137),
  explorationPort: readNumberVariable('explorationPort', 19138),
  adminCreativeGamertags: readListVariable('adminCreativeGamertags'),
  adminOperatorXuIds: readListVariable('adminOperatorXuIds'),
  allowExtraDimensions: readBooleanVariable('allowExtraDimensions', false),
  heartbeatIntervalTicks: readNumberVariable('heartbeatIntervalTicks', 200),
  autosaveIntervalTicks: readNumberVariable('autosaveIntervalTicks', 1200)
};
