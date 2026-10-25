import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RECORD_KEY,
  NAME_KEY,
  readRecord,
  saveIfBetter,
  clearRecord,
  clearLocalGameData,
  readStoredName,
  saveName,
  sanitizeOpponentName,
  normalizeRecord,
  describeRecord,
} from '../public/js/records.mjs';

class MemoryStorage {
  constructor(initial = {}) {
    this.map = new Map(Object.entries(initial));
    this.blocked = false;
  }
  getItem(key) {
    if (this.blocked) throw new Error('storage blocked');
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    if (this.blocked) throw new Error('storage blocked');
    this.map.set(key, String(value));
  }
  removeItem(key) {
    if (this.blocked) throw new Error('storage blocked');
    this.map.delete(key);
  }
}

test('first score creates a record with opponent name and duration', () => {
  const storage = new MemoryStorage();
  const result = saveIfBetter(
    { score: 12, opponentName: 'Bo', roundDurationSeconds: 60 },
    storage,
  );
  assert.equal(result.saved, true);
  assert.equal(result.firstRecord, true);
  assert.equal(result.improved, false);
  assert.deepEqual(result.record, { bestScore: 12, opponentName: 'Bo', roundDurationSeconds: 60 });
  assert.deepEqual(readRecord(storage).record, result.record);
});

test('a higher score replaces the record and a lower score does not', () => {
  const storage = new MemoryStorage();
  saveIfBetter({ score: 20, opponentName: 'Bo', roundDurationSeconds: 30 }, storage);

  const lower = saveIfBetter({ score: 12, opponentName: 'Cy', roundDurationSeconds: 90 }, storage);
  assert.equal(lower.saved, false);
  assert.equal(lower.improved, false);
  assert.equal(readRecord(storage).record.bestScore, 20);
  assert.equal(readRecord(storage).record.opponentName, 'Bo');

  const equal = saveIfBetter({ score: 20, opponentName: 'Dee', roundDurationSeconds: 60 }, storage);
  assert.equal(equal.saved, false);

  const higher = saveIfBetter({ score: 28, opponentName: 'Eve', roundDurationSeconds: 90 }, storage);
  assert.equal(higher.saved, true);
  assert.equal(higher.improved, true);
  assert.deepEqual(readRecord(storage).record, {
    bestScore: 28,
    opponentName: 'Eve',
    roundDurationSeconds: 90,
  });
});

test('only the three allowed fields are stored', () => {
  const storage = new MemoryStorage();
  saveIfBetter(
    {
      score: 5,
      opponentName: 'Bo',
      roundDurationSeconds: 30,
      email: 'private@example.test',
      history: [{ score: 1 }],
    },
    storage,
  );
  const raw = JSON.parse(storage.getItem(RECORD_KEY));
  assert.deepEqual(Object.keys(raw).sort(), ['bestScore', 'opponentName', 'roundDurationSeconds']);
});

test('a zero score still creates a first record', () => {
  const storage = new MemoryStorage();
  const result = saveIfBetter({ score: 0, opponentName: 'Bo' }, storage);
  assert.equal(result.saved, true);
  assert.equal(result.firstRecord, true);
  assert.equal(readRecord(storage).record.bestScore, 0);
});

test('corrupted storage is reported and does not throw', () => {
  for (const value of ['{not json', 'null', '[]', '"text"', '{"bestScore":"12"}', '{"bestScore":-4}', '{"bestScore":12}']) {
    const storage = new MemoryStorage({ [RECORD_KEY]: value });
    const result = readRecord(storage);
    assert.equal(result.record, null, `value ${value} should not be trusted`);
    assert.equal(result.corrupt, true);
  }
  const recovered = saveIfBetter({ score: 3, opponentName: 'Bo' }, new MemoryStorage({ [RECORD_KEY]: 'garbage' }));
  assert.equal(recovered.saved, true);
});

test('unavailable storage never crashes the game', () => {
  const blocked = new MemoryStorage();
  blocked.blocked = true;

  const read = readRecord(blocked);
  assert.equal(read.record, null);
  assert.equal(read.available, false);

  const write = saveIfBetter({ score: 10, opponentName: 'Bo' }, blocked);
  assert.equal(write.saved, false);
  assert.equal(write.available, false);
  assert.equal(write.error, 'storage_unavailable');

  assert.deepEqual(clearRecord(blocked), { ok: false, available: false });
  assert.deepEqual(clearLocalGameData(blocked), { ok: false, available: false });
  assert.equal(readStoredName(blocked), '');
  assert.equal(saveName('Ada', blocked), false);

  const noStorage = readRecord(null);
  assert.equal(noStorage.available, false);
  assert.equal(saveIfBetter({ score: 1, opponentName: 'Bo' }, null).saved, false);
});

test('opponent names are cleaned and validated', () => {
  assert.equal(sanitizeOpponentName('  Bo  '), 'Bo');
  assert.equal(sanitizeOpponentName('Bo\u0000\u0007'), 'Bo');
  assert.equal(sanitizeOpponentName('x'.repeat(100)).length, 32);
  assert.equal(sanitizeOpponentName(42), '');
  assert.equal(normalizeRecord({ bestScore: 3, opponentName: '   ' }), null);
  assert.equal(normalizeRecord({ bestScore: 3.5, opponentName: 'Bo' }), null);
  assert.deepEqual(normalizeRecord({ bestScore: 3, opponentName: 'Bo', roundDurationSeconds: 45 }), {
    bestScore: 3,
    opponentName: 'Bo',
  });
});

test('clearing removes the record and the saved name only', () => {
  const storage = new MemoryStorage();
  saveName('Ada', storage);
  saveIfBetter({ score: 9, opponentName: 'Bo', roundDurationSeconds: 60 }, storage);

  assert.equal(clearRecord(storage).ok, true);
  assert.equal(readRecord(storage).record, null);
  assert.equal(readStoredName(storage), 'Ada');

  saveIfBetter({ score: 9, opponentName: 'Bo' }, storage);
  assert.equal(clearLocalGameData(storage).ok, true);
  assert.equal(readRecord(storage).record, null);
  assert.equal(readStoredName(storage), '');
  assert.ok(!storage.getItem(NAME_KEY));
});

test('saved names are readable and truncated', () => {
  const storage = new MemoryStorage();
  saveName('Ada', storage);
  assert.equal(readStoredName(storage), 'Ada');
  saveName('z'.repeat(80), storage);
  assert.equal(readStoredName(storage).length, 32);
});

test('record descriptions handle missing fields', () => {
  assert.deepEqual(describeRecord(null), {
    score: 'No record saved',
    opponent: 'Not available',
    duration: 'Not available',
  });
  assert.deepEqual(describeRecord({ bestScore: 4, opponentName: 'Bo' }), {
    score: '4',
    opponent: 'Bo',
    duration: 'Not recorded',
  });
  assert.equal(describeRecord({ bestScore: 4, opponentName: 'Bo', roundDurationSeconds: 30 }).duration, '30 seconds');
});
