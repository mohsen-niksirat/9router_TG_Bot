import { db } from 'sdk';
import { sql } from 'sdk/db';

/**
 * Wall-clock delay without timers.
 *
 * The tgcloud V8 isolate has no setTimeout/setInterval (see commit cb081bb),
 * so loops that must wait for real time — album debounce, Manus task polling —
 * burn the interval in slices and yield to the event loop with a tiny db
 * round-trip every couple of milliseconds.
 */
export async function sleep(ms) {
  const end = Date.now() + ms;
  let nextYield = 0;
  while (Date.now() < end) {
    const now = Date.now();
    if (now >= nextYield) {
      try {
        await db.get(sql`SELECT 1`);
      } catch {
        // Aborting the wait on a db hiccup would break pacing — keep spinning.
      }
      nextYield = now + 2;
    }
  }
}