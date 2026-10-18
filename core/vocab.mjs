// The enum space the model is allowed to answer in — defined once.
//
// This file exists because the schema comment, the scorer's point tables and the
// extraction validator once disagreed about the spelling of `within_month`. When
// they drift, score.mjs's pick() returns 0 for an unrecognised key, so a perfectly
// good extraction scores as a cold lead and nothing looks broken. It is broken.
//
// SQL CHECK constraints in db/init/001_schema.sql mirror these arrays by hand.
// If you change one, change the other, then run `node --test eval/*.test.mjs`.

export const NEED = ['specific_programme', 'category', 'vague', 'none'];

export const TIMELINE = ['now', 'within_month', 'within_quarter', 'later', 'unknown'];

export const AUTHORITY = ['self', 'boss_or_team', 'unknown'];

// `null` hotness is legal in code (score returns it with action='clarify') but
// never legal in the database, which is why score.hotness has a NOT NULL CHECK.
export const HOTNESS = ['hot', 'warm', 'cold'];

export const ACTION = ['offer_slot', 'keep_qualifying', 'nurture', 'clarify', 'escalate'];

export const BUDGET_STATE = ['stated', 'unknown'];

const asSet = (xs) => new Set(xs);

export const NEED_SET = asSet(NEED);
export const TIMELINE_SET = asSet(TIMELINE);
export const AUTHORITY_SET = asSet(AUTHORITY);
export const HOTNESS_SET = asSet(HOTNESS);
export const ACTION_SET = asSet(ACTION);
