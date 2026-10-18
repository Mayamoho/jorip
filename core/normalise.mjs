// Turn whatever Meta posted into the shape the rest of the flow uses.
// Pure: no clock reads beyond one injected `now`, no I/O, so it is testable
// against captured payloads rather than against a live sandbox.

/**
 * @param {object} body the parsed WhatsApp webhook body
 * @param {{now?:Date}} [opts]
 * @returns {{messages:object[], ignored:boolean, reason:string|null, statuses:object[]}}
 */
export function normaliseInbound(body, opts = {}) {
  const now = opts.now ?? new Date();
  const value = body?.entry?.[0]?.changes?.[0]?.value ?? {};
  const contacts = new Map(
    (body?.entry ?? []).flatMap((e) => (e.changes ?? []).flatMap((c) => c.value?.contacts ?? []))
      .map((c) => [c.wa_id, c.profile?.name ?? null]),
  );

  const messages = [];
  const statuses = [];

  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue;
      const v = change.value ?? {};

      for (const msg of v.messages ?? []) {
        messages.push({
          wamid: msg.id ?? null,
          // E.164 without the '+', exactly as Meta sends it — the same form the
          // lead table's unique key uses. Normalising it here means the insert
          // and the lookup cannot disagree about who a number is.
          wa_number: msg.from ?? null,
          profile_name: contacts.get(msg.from) ?? null,
          // WhatsApp ships text, audio, sticker, document, location, buttons…
          // Anything unmapped arrives as a null body and the reply step has to
          // handle that rather than assume a string was there.
          body: msg.text?.body ?? null,
          message_type: msg.type ?? 'unknown',
          // Meta's own timestamp, not ours — a retried webhook keeps it.
          sent_at: msg.timestamp ? new Date(Number(msg.timestamp) * 1000).toISOString() : null,
          received_at: now.toISOString(),
          status: 'received',
        });
      }

      // Reads, sent-acknowledgements and deliveries are noise for us, but a
      // failed delivery is not: it means the reply never reached a phone.
      for (const st of v.statuses ?? []) {
        statuses.push({
          wamid: st.id ?? null,
          status: st.status ?? null,
          recipient: st.recipient_id ?? null,
          error: st.errors?.[0]?.message ?? null,
          error_code: st.errors?.[0]?.code ?? null,
        });
      }
    }
  }

  const usable = messages.filter((m) => m.wamid && m.wa_number);
  return {
    messages: usable,
    statuses,
    ignored: usable.length === 0 && statuses.length === 0,
    reason: usable.length === 0 && statuses.length === 0 ? 'no_messages_in_payload' : null,
  };
}

/** The transcript the brain needs, newest last, oldest dropped first. */
export function buildTranscript(history, leadText) {
  const turns = [];
  for (const h of history ?? []) {
    if (!h?.body) continue;                      // audio/sticker/document arrive bodyless
    turns.push({ role: h.direction === 'in' ? 'lead' : 'assistant', text: h.body });
  }
  if (leadText) turns.push({ role: 'lead', text: leadText });
  return turns;
}
