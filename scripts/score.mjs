// The deterministic qualification scorer.
//
// The model extracts facts. This file decides what they mean.
// Two reasons it is not a prompt:
//   1. it is unit-testable without spending a token, and
//   2. a client asking "why is this one hot" gets an answer with numbers in it.
//
// Body of the n8n Code node; kept standalone so eval/ can import it directly.

export const RULE_VERSION = 'v1';

const NEED = { specific_programme: 25, category: 15, vague: 7, none: 0 };
const AUTHORITY = { self: 15, boss_or_team: 9, unknown: 0 };
const TIMELINE = { now: 25, within_month: 18, within_quarter: 10, later: 0, unknown: 0 };

const BUDGET_BANDS = [
  { min: 30000, pts: 25 },
  { min: 15000, pts: 18 },
  { min: 5000,  pts: 10 },
  { min: 1,     pts: 3 },
];

const HOT_AT = 60;
const WARM_AT = 35;
const MIN_CONFIDENCE = 0.5;

function budgetPoints(budget) {
  if (budget === null || budget === undefined) return 0;   // unknown ≠ free
  const band = BUDGET_BANDS.find((b) => budget >= b.min);
  return band ? band.pts : 0;
}

function pick(table, key) {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : 0;
}

export function score(x) {
  const need_pts = pick(NEED, x.need);
  const budget_pts = budgetPoints(x.budget_bdt);
  const timeline_pts = pick(TIMELINE, x.timeline);
  const authority_pts = pick(AUTHORITY, x.authority);
  const total = need_pts + budget_pts + timeline_pts + authority_pts;

  const base = { need_pts, budget_pts, timeline_pts, authority_pts, total, rule_version: RULE_VERSION };

  // An extraction we do not trust is not a lead — it is a question.
  // Acting on a shaky guess is how an agent books a call nobody wanted.
  if (x.confidence === null || x.confidence === undefined || x.confidence < MIN_CONFIDENCE) {
    return { ...base, hotness: null, action: 'clarify', reason_code: 'low_confidence' };
  }

  // Vetoes beat arithmetic. Someone who says they want nothing we sell is
  // cold at any budget, and a 25-point need cannot rescue a 0-point authority
  // when they have already said no to money.
  if (x.need === 'none')      return { ...base, hotness: 'cold', action: 'nurture', reason_code: 'veto_no_need' };
  if (x.budget_bdt === 0)     return { ...base, hotness: 'cold', action: 'nurture', reason_code: 'veto_no_budget' };

  const hotness = total >= HOT_AT ? 'hot' : total >= WARM_AT ? 'warm' : 'cold';
  return { ...base, hotness, action: hotness === 'hot' ? 'offer_slot' : hotness === 'warm' ? 'keep_qualifying' : 'nurture', reason_code: null };
}
