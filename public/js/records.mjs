/**
 * Personal record storage.
 *
 * Only three fields are ever written:
 *   { bestScore, opponentName, roundDurationSeconds }
 *
 * Records belong to this browser only. They are not synced, not verified by the
 * server and not tamper proof. Stored values are re-validated on read because
 * local storage is editable by anyone with access to the device.
 */

export const RECORD_KEY = 'sticker-showdown:record:v1';
export const NAME_KEY = 'sticker-showdown:name:v1';
const MAX_SCORE = 100000;
const MAX_NAME = 32;
const VALID_DURATIONS = [30, 60, 90];

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function readRaw(storage, key) {
  try {
    if (!storage) return { available: false, value: null };
    return { available: true, value: storage.getItem(key) };
  } catch {
    return { available: false, value: null };
  }
}

export function sanitizeOpponentName(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
}

export function normalizeRecord(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const score = candidate.bestScore;
  if (!Number.isInteger(score) || score < 0 || score > MAX_SCORE) return null;

  const opponentName = sanitizeOpponentName(candidate.opponentName);
  if (!opponentName) return null;

  const record = { bestScore: score, opponentName };
  const duration = candidate.roundDurationSeconds;
  if (VALID_DURATIONS.includes(duration)) {
    record.roundDurationSeconds = duration;
  }
  return record;
}

/**
 * @param {Storage|null} [storage]
 * @returns {{record: object|null, corrupt: boolean, available: boolean}}
 */
export function readRecord(storage = defaultStorage()) {
  const raw = readRaw(storage, RECORD_KEY);
  if (!raw.available) return { record: null, corrupt: false, available: false };
  if (!raw.value) return { record: null, corrupt: false, available: true };

  try {
    const parsed = JSON.parse(raw.value);
    const record = normalizeRecord(parsed);
    if (!record) return { record: null, corrupt: true, available: true };
    return { record, corrupt: false, available: true };
  } catch {
    return { record: null, corrupt: true, available: true };
  }
}

/**
 * Saves only when the score beats the stored best.
 * @returns {{saved:boolean, improved:boolean, firstRecord:boolean, record:object|null, available:boolean, error?:string}}
 */
export function saveIfBetter(
  { score, opponentName, roundDurationSeconds },
  storage = defaultStorage(),
) {
  if (!Number.isInteger(score) || score < 0 || score > MAX_SCORE) {
    return { saved: false, improved: false, firstRecord: false, record: null, available: true };
  }
  const name = sanitizeOpponentName(opponentName);
  if (!name) {
    return {
      saved: false,
      improved: false,
      firstRecord: false,
      record: null,
      available: true,
      error: 'missing_opponent',
    };
  }

  const current = readRecord(storage);
  if (current.record && score <= current.record.bestScore) {
    return {
      saved: false,
      improved: false,
      firstRecord: false,
      record: current.record,
      available: current.available,
    };
  }

  const next = { bestScore: score, opponentName: name };
  if (VALID_DURATIONS.includes(roundDurationSeconds)) {
    next.roundDurationSeconds = roundDurationSeconds;
  }

  try {
    if (!storage) throw new Error('storage_unavailable');
    storage.setItem(RECORD_KEY, JSON.stringify(next));
  } catch {
    return {
      saved: false,
      improved: false,
      firstRecord: !current.record,
      record: current.record,
      available: false,
      error: 'storage_unavailable',
    };
  }

  return {
    saved: true,
    improved: Boolean(current.record),
    firstRecord: !current.record,
    record: next,
    available: true,
  };
}

export function clearRecord(storage = defaultStorage()) {
  try {
    if (!storage) return { ok: false, available: false };
    storage.removeItem(RECORD_KEY);
    return { ok: true, available: true };
  } catch {
    return { ok: false, available: false };
  }
}

export function clearLocalGameData(storage = defaultStorage()) {
  try {
    if (!storage) return { ok: false, available: false };
    storage.removeItem(RECORD_KEY);
    storage.removeItem(NAME_KEY);
    return { ok: true, available: true };
  } catch {
    return { ok: false, available: false };
  }
}

export function readStoredName(storage = defaultStorage()) {
  const raw = readRaw(storage, NAME_KEY);
  if (!raw.available || !raw.value) return '';
  return raw.value.slice(0, 32);
}

export function saveName(name, storage = defaultStorage()) {
  try {
    if (!storage) return false;
    storage.setItem(NAME_KEY, String(name).slice(0, 32));
    return true;
  } catch {
    return false;
  }
}

export function describeRecord(record) {
  if (!record) return { score: 'No record saved', opponent: 'Not available', duration: 'Not available' };
  return {
    score: String(record.bestScore),
    opponent: record.opponentName,
    duration: record.roundDurationSeconds ? `${record.roundDurationSeconds} seconds` : 'Not recorded',
  };
}
