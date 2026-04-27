import { randomUUID } from 'node:crypto';

export function createRequestId({
  source = 'req',
  now = Date.now,
  randomUUID: uuid = randomUUID,
} = {}) {
  const prefix = String(source)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'req';
  return `${prefix}_${now().toString(36)}_${uuid().slice(0, 8)}`;
}
