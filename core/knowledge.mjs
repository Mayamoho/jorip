// The only facts the agent is allowed to state.
//
// The front door injects these into the prompt; the WhatsApp path seeds the same
// array into `knowledge` so pgvector and the demo can never disagree about price.
// `source_ref` is what gets cited back, and what a human audits when something
// sounds wrong. Nothing here is a placeholder — if a number is not real, it does
// not go in this file, and the agent says it will check instead.

export const KNOWLEDGE = [
  {
    id: 'what-is-jorip',
    ref: 'about.md#what-it-is',
    text: 'Jorip is an intake assistant for Small Makers Studio. It listens to a WhatsApp or web enquiry, works out what the business actually needs, books a 30-minute call, and hands a human a written summary. It does not pretend to be a person.',
  },
  {
    id: 'services',
    ref: 'services.md#list',
    text: 'Services offered: WhatsApp and web enquiry agents, n8n workflow automation, lead qualification and CRM pipelines, and internal data tools. Anything outside these is out of scope and gets passed to a human.',
  },
  {
    id: 'pricing-entry',
    ref: 'pricing.md#entry',
    text: 'Entry engagements start around 15,000 BDT for a single automated workflow. This is a starting band, not a quote; a real price needs the call.',
  },
  {
    id: 'pricing-standard',
    ref: 'pricing.md#standard',
    text: 'A typical intake agent with qualification and booking lands between 30,000 and 60,000 BDT depending on how many systems it has to touch. Never quoted as a firm number.',
  },
  {
    id: 'timeline-typical',
    ref: 'delivery.md#typical',
    text: 'A first working automation usually goes live in 1 to 3 weeks. Complex CRM integrations take longer.',
  },
  {
    id: 'data-handling',
    ref: 'trust.md#data',
    text: 'Enquiry data stays in the client\'s own database. No third party trains on it. The agent can be switched to a human-only channel at any time.',
  },
  {
    id: 'escalation',
    ref: 'trust.md#escalation',
    text: 'If the agent is unsure, if a customer asks for a price it cannot vouch for, or if anyone says they want to speak to a person, the conversation goes to a human immediately with the full transcript.',
  },
];

export function knowledgeBlock() {
  return KNOWLEDGE.map((k) => `[${k.ref}] ${k.text}`).join('\n');
}
