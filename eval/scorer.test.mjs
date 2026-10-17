import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score, RULE_VERSION } from '../scripts/score.mjs';

const base = { need: 'specific_programme', budget_bdt: 30000, timeline: 'now', authority: 'self', confidence: 0.9 };

test('a complete, eager, self-deciding lead is hot', () => {
  assert.equal(score(base).hotness, 'hot');
  assert.equal(score(base).total, 90);
  assert.equal(score(base).action, 'offer_slot');
});

test('unknown budget is not scored as if it were free', () => {
  const r = score({ ...base, budget_bdt: null });
  assert.equal(r.budget_pts, 0);
  assert.equal(r.hotness, 'hot');          // 25+0+25+15 = 65 — still hot, still needs the number asked
  assert.equal(r.total, 65);
});

test('budget bands are monotonic', () => {
  const pts = [50000, 30000, 20000, 15000, 9000, 5000, 1000].map((b) => score({ ...base, budget_bdt: b }).budget_pts);
  assert.deepEqual(pts, [25, 25, 18, 18, 10, 10, 3]);
});

test('a vague enquiry with no money and no timeline is cold', () => {
  const r = score({ need: 'vague', budget_bdt: null, timeline: 'unknown', authority: 'unknown', confidence: 0.8 });
  assert.equal(r.total, 7);
  assert.equal(r.hotness, 'cold');
  assert.equal(r.action, 'nurture');
});

test('no need vetoes the score, however rich', () => {
  const r = score({ ...base, need: 'none' });
  assert.equal(r.hotness, 'cold');
  assert.equal(r.reason_code, 'veto_no_need');
});

test('an explicit zero budget vetoes, even with a specific need', () => {
  const r = score({ ...base, budget_bdt: 0 });
  assert.equal(r.hotness, 'cold');
  assert.equal(r.reason_code, 'veto_no_budget');
});

test('a shaky extraction becomes a question, not a decision', () => {
  const r = score({ ...base, confidence: 0.3 });
  assert.equal(r.hotness, null);
  assert.equal(r.action, 'clarify');
  assert.equal(r.reason_code, 'low_confidence');
});

test('a missing confidence is treated as an untrusted extraction', () => {
  assert.equal(score({ ...base, confidence: undefined }).action, 'clarify');
});

test('an unknown category from the model scores zero, not undefined', () => {
  const r = score({ need: 'definitely_a_typo', budget_bdt: null, timeline: 'someday', authority: 'alien', confidence: 0.9 });
  assert.equal(r.total, 0);
  assert.equal(r.hotness, 'cold');
});

test('the warm band keeps qualifying instead of pitching a slot', () => {
  const r = score({ need: 'category', budget_bdt: 9000, timeline: 'within_month', authority: 'unknown', confidence: 0.85 });
  assert.equal(r.total, 43);
  assert.equal(r.hotness, 'warm');
  assert.equal(r.action, 'keep_qualifying');
});

test('the hot line is inclusive at 60', () => {
  const r = score({ need: 'specific_programme', budget_bdt: 30000, timeline: 'within_quarter', authority: 'unknown', confidence: 0.9 });
  assert.equal(r.total, 60);
  assert.equal(r.hotness, 'hot');
});

test('one point below the line stays warm', () => {
  const r = score({ need: 'category', budget_bdt: 30000, timeline: 'within_quarter', authority: 'boss_or_team', confidence: 0.9 });
  assert.equal(r.total, 59);
  assert.equal(r.hotness, 'warm');
});

test('every score carries the rule version, so old rows stay explainable', () => {
  assert.equal(score(base).rule_version, RULE_VERSION);
});

test('the same input always gives the same answer', () => {
  assert.deepEqual(score(base), score(base));
});
