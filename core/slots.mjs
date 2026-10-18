// The option space. The model is shown these ids and may name one of them;
// anything else fails validation. This is what makes "it promised a time that
// does not exist" structurally impossible rather than merely unlikely.
//
// Deterministic by construction: given the same `now`, the same slots come out.
// No randomness, so a replay of a conversation produces the same offer and the
// eval battery can pin it.

const DHAKA_OFFSET_MIN = 360; // UTC+6, no DST in Bangladesh
const OPEN_HOUR = 10;
const CLOSE_HOUR = 18;
const SLOT_MINUTES = 30;
const LEAD_TIME_MINUTES = 240; // never offer a slot that starts inside 4 hours
const OFFER_COUNT = 6;
const SCAN_DAYS = 10;

function pad(n) {
  return String(n).padStart(2, '0');
}

function labelFor(utcMs) {
  const d = new Date(utcMs + DHAKA_OFFSET_MIN * 60_000);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const h24 = d.getUTCHours();
  const ampm = h24 >= 12 ? 'pm' : 'am';
  const h12 = ((h24 + 11) % 12) + 1;
  return `${days[d.getUTCDay()]} ${d.getUTCDate()}/${d.getUTCMonth() + 1}, ${h12}:${pad(d.getUTCMinutes())}${ampm}`;
}

/**
 * Free talking slots, in order, as they exist on the server right now.
 * @param {Date|number} now
 * @param {{taken?: string[]}} [opts] starts_at values already held or booked
 * @returns {{id:string, starts_at:string, label:string}[]}
 */
export function freeSlots(now, opts = {}) {
  const startMs = typeof now === 'number' ? now : now.getTime();
  const taken = new Set(opts.taken ?? []);
  const earliest = startMs + LEAD_TIME_MINUTES * 60_000;
  const out = [];

  for (let day = 0; day < SCAN_DAYS && out.length < OFFER_COUNT; day++) {
    // Walk in Dhaka-local days by anchoring midnight-local onto the UTC clock.
    const localNow = new Date(startMs + DHAKA_OFFSET_MIN * 60_000);
    const anchor = Date.UTC(
      localNow.getUTCFullYear(),
      localNow.getUTCMonth(),
      localNow.getUTCDate() + day,
    );
    const dow = new Date(anchor).getUTCDay();
    if (dow === 5 || dow === 6) continue; // Fri–Sat weekend for most BD businesses

    for (let m = OPEN_HOUR * 60; m + SLOT_MINUTES <= CLOSE_HOUR * 60; m += SLOT_MINUTES) {
      const utcMs = anchor - DHAKA_OFFSET_MIN * 60_000 + m * 60_000;
      if (utcMs < earliest) continue;
      const starts_at = `${new Date(utcMs).toISOString().slice(0, 19)}Z`;
      if (taken.has(starts_at)) continue;
      out.push({ id: starts_at, starts_at, label: labelFor(utcMs) });
      if (out.length >= OFFER_COUNT) break;
    }
  }
  return out;
}

/** The server's answer to "is this a slot we can actually honour?" */
export function isOfferable(slots, id) {
  return typeof id === 'string' && slots.some((s) => s.id === id);
}

/** Just the ids, for the repair prompt and for tests. */
export function slotIds(slots) {
  return slots.map((s) => s.id);
}
