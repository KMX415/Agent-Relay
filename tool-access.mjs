import { tools } from './tools.mjs';

export function normalizeAllowedTools(value) {
  if (value === undefined || value === null) return null;
  const names = typeof value === 'string' ? value.split(',').map(name => name.trim()) : value;
  const known = new Set(tools.map(tool => tool.name));
  if (!Array.isArray(names) || !names.length || names.some(name => typeof name !== 'string' || !known.has(name)) || new Set(names).size !== names.length)
    throw new Error('Tool subset must contain unique, exact supported tool names');
  return [...names].sort();
}

export function assertToolAllowed(name, allowedTools) {
  if (allowedTools !== null && !allowedTools.includes(name)) throw new Error('Tool is not enabled for this connection');
}

export function restrictedSurface(surface, allowedTools) {
  return allowedTools === null ? surface : surface.filter(tool => allowedTools.includes(tool.name));
}
