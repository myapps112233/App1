/**
 * Small clock helper that keeps browser time aligned with the server.
 *
 * The server decides when a round starts and ends. The browser only renders the
 * remaining time using an offset estimated from round trips, so a slightly wrong
 * local clock cannot shift the visible countdown by minutes.
 */

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function createServerClock({ maxSamples = 5 } = {}) {
  const samples = [];
  let coarseOffset = 0;
  let hasCoarse = false;

  return {
    /** Round trip sample: sentAt/receivedAt are local timestamps around the call. */
    addRoundTrip(serverNow, sentAt, receivedAt) {
      if (!Number.isFinite(serverNow) || !Number.isFinite(sentAt) || !Number.isFinite(receivedAt)) {
        return;
      }
      const rtt = Math.max(0, receivedAt - sentAt);
      samples.push({ offset: serverNow - (sentAt + receivedAt) / 2, rtt });
      if (samples.length > maxSamples) {
        samples.sort((a, b) => a.rtt - b.rtt);
        samples.splice(maxSamples);
      }
    },

    /** Coarse alignment from a timestamp delivered in a server event. */
    noteServerNow(serverNow, clientNow = Date.now()) {
      if (!Number.isFinite(serverNow)) return;
      if (samples.length) return;
      coarseOffset = serverNow - clientNow;
      hasCoarse = true;
    },

    offset() {
      if (samples.length) return median(samples.map((sample) => sample.offset));
      return hasCoarse ? coarseOffset : 0;
    },

    now() {
      return Date.now() + this.offset();
    },

    reset() {
      samples.length = 0;
      coarseOffset = 0;
      hasCoarse = false;
    },
  };
}
