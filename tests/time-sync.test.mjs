import test from 'node:test';
import assert from 'node:assert/strict';

import { createServerClock, median } from '../public/js/time-sync.mjs';

test('median handles odd and even samples', () => {
  assert.equal(median([]), 0);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 3, 2]), 2);
  assert.equal(median([1, 2, 3, 10]), 2.5);
});

test('round trip samples align the client clock with the server', () => {
  const clock = createServerClock();
  const now = Date.now();
  // Server is 12 seconds ahead of this browser.
  clock.addRoundTrip(now + 12000, now - 40, now + 40);
  assert.ok(Math.abs(clock.offset() - 12000) < 5);
  assert.ok(Math.abs(clock.now() - (Date.now() + 12000)) < 60);
});

test('the best round trips win and samples stay bounded', () => {
  const clock = createServerClock({ maxSamples: 3 });
  const now = Date.now();
  clock.addRoundTrip(now + 5000, now, now + 400);
  clock.addRoundTrip(now + 5000, now, now + 20);
  clock.addRoundTrip(now + 5000, now, now + 10);
  clock.addRoundTrip(now + 5000, now, now + 30);
  // Median of the three lowest round trips sits close to a 10 to 30 ms half trip.
  assert.ok(clock.offset() > 4980 && clock.offset() < 5000);
});

test('a coarse server timestamp provides a fallback before any round trip', () => {
  const clock = createServerClock();
  const clientNow = Date.now();
  clock.noteServerNow(clientNow + 8000, clientNow);
  assert.ok(Math.abs(clock.now() - (Date.now() + 8000)) < 50);
});

test('reset clears the estimate', () => {
  const clock = createServerClock();
  clock.addRoundTrip(Date.now() + 1000, Date.now() - 5, Date.now() + 5);
  clock.reset();
  assert.ok(Math.abs(clock.offset()) < 5);
});
