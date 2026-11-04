import { fetch } from 'sdk';

/**
 * Wall-clock helpers for the tgcloud V8 isolate.
 *
 * Runtime facts (probed live on 2026-11-04, endpoint zzprobe):
 *   - setTimeout / clearTimeout / AbortController / AbortSignal: ALL ABSENT
 *   - CPU budget per invocation: ~3.0 s ("Terminated: CPU timer exceeded 3014ms")
 *   - waiting on network is NOT CPU — socket I/O time is free of the meter
 *
 * So the only safe way to wait is to spend wall-time on network round-trips,
 * never on a spinning Date.now() loop (that burned ~100% CPU and got
 * invocations killed mid-flight — the "stuck ⏳ placeholder" bug).
 */

// Tiny static 404 (SPA serves index only for extension-less paths); ~0.3 KB
// round-trip, body discarded — pure idle wall-clock time for the CPU meter.
// Measured: 25s of this pacing survives; a busy-spin Date.now() loop hits the
// ~3.0s CPU budget and gets the invocation killed ("CPU timer exceeded").
const NAP_URL = 'https://app9029829582.tgcloud.ai/robots.txt';
export const WITH_TIMEOUT_NOTE = 'net-paced, no abort';

/** Real wall-time delay at ~zero isolate CPU cost. */
export async function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      // Network round-trip = free idle time; response is discarded unread.
      await fetch(NAP_URL, { method: 'GET' });
    } catch {
      if (Date.now() >= end) return; // dial-out dead → still honor the deadline
    }
  }
}

/**
 * Await a promise but give up after `ms` — timerless (no Abort available, so
 * the abandoned call keeps running in the background; Promise.race keeps its
 * handlers, so a late rejection is swallowed instead of crashing the isolate).
 * Throws an error flagged `isTimeout: true`.
 */
export async function withTimeout(promise, ms) {
  let settled = false;
  let outcome = null;
  const real = Promise.resolve(promise).then(
    (value) => { settled = true; outcome = { ok: true, value }; },
    (error) => { settled = true; outcome = { ok: false, error }; },
  );

  await Promise.race([real, sleep(ms)]);

  if (!settled) {
    real.catch(() => {}); // late settle is irrelevant now
    const err = new Error(`timeout after ${ms}ms`);
    err.isTimeout = true;
    throw err;
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}