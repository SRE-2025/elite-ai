// The Elite Learning Loop: what actually works for THIS user, learned from their own results
// and kept on this device. Public leaderboards are the starting point, a Champion Audit refines
// it, and everyday outcomes personalize it.
//
// Built from the other AIs' design reviews:
// - ChatGPT: the learning loop; keep satisfaction separate from verified correctness; treat
//   copy/share as engagement, not a quality vote; give other AIs tryouts so a winner can't lock
//   in; don't crown a champion on a handful of signals.
// - Gemini: personal routing per task type; credit the specialists upstream (sources they found,
//   checks they passed), not just the final writer; don't ask users to judge an answer they never
//   saw — hence blind A/B checks instead of "was this better than one AI?".

import { store } from './store.js';

export const CATEGORIES = {
  research: 'Research & current events',
  writing: 'Writing & editing',
  coding: 'Coding',
  math: 'Math & numbers',
  factcheck: 'Fact-checking',
  longdoc: 'Long documents',
  planning: 'Planning',
  critique: 'Critique & feedback',
  translation: 'Translation',
  general: 'General',
};

const RULES = [
  ['translation', /\btranslat|\bin (spanish|french|german|japanese|chinese|italian|portuguese|korean|arabic)\b/i],
  ['coding', /\b(code|coding|function|bug|debug|javascript|typescript|python|sql|regex|api|script|css|html|compile|stack trace)\b/i],
  ['factcheck', /\b(fact[- ]?check|is it true|true or false|verify|accurate\?)/i],
  ['critique', /\b(poke holes|critique|weak(ness|est)|risks?\b|devil'?s advocate|review my|feedback on|what'?s wrong)/i],
  ['math', /\b(calculate|math|equation|percent|probability|statistics|how many|average|interest rate|solve)\b|%/i],
  ['research', /\b(latest|current(ly)?|today|this (week|month|year)|news|recent|price of|cost of|who is|right now|20\d\d)\b/i],
  ['planning', /\b(plan|schedule|itinerary|roadmap|steps to|strategy|checklist|timeline)\b/i],
  ['writing', /\b(write|draft|email|rewrite|edit|blog|post|letter|caption|essay|story|poem|headline|bio)\b/i],
];

export function classify(text) {
  const t = String(text || '');
  if (t.length > 6000) return 'longdoc';
  for (const [cat, re] of RULES) if (re.test(t)) return cat;
  return 'general';
}

const MAX = 400;
export const MIN_SIGNALS = 5;
export const TRYOUT_RATE = 0.1; // share of team tasks where another AI gets a turn
export const BLIND_RATE = 1 / 8; // share of team tasks that get a blind A/B check

const load = () => store.read('outcomes', []);
const save = (list) => {
  let l = list.slice(0, MAX);
  while (!store.write('outcomes', l) && l.length > 10) l = l.slice(0, Math.floor(l.length * 0.8));
};

const cell = (map, pid) => (map[pid] ||= { pos: 0, neg: 0 });
const done = (s) => s && s.status === 'done' && !s.superseded && !s.replacedBy;

function verdictOf(text) {
  const first = String(text || '').split('\n').find((l) => /verdict/i.test(l)) || '';
  return /✅|looks right/i.test(first) ? 'pass' : /❌|has problems/i.test(first) ? 'fail' : null;
}

// Called when an answer finishes (no prompt or answer text is stored — only what happened).
export function recordOutcome(msg) {
  if (!msg?.id || msg.status !== 'done') return;
  const specialists = (msg.steps || []).filter(done);
  const writer = done(msg.writer) ? msg.writer.provider : specialists.length === 1 ? specialists[0].provider : null;
  const calls = [msg.planner, ...specialists, msg.writer, ...(msg.checks || [])].filter(done);
  const list = load();
  const existing = list.find((o) => o.id === msg.id);
  const o = existing || { id: msg.id, ts: Date.now(), sat: {}, eng: {}, team: null };

  // Verified signals are recomputed each time, from independent checks of the final answer.
  // A pass credits everyone who built the answer equally; a fail lands harder on the writer, who
  // made the final claims.
  o.ver = {};
  for (const c of (msg.checks || []).filter(done)) {
    const v = verdictOf(c.output);
    if (!v) continue;
    for (const s of specialists) if (s.provider !== c.provider) cell(o.ver, s.provider)[v === 'pass' ? 'pos' : 'neg'] += v === 'pass' ? 0.5 : 0.25;
    if (writer && writer !== c.provider) cell(o.ver, writer)[v === 'pass' ? 'pos' : 'neg'] += 0.5;
  }
  Object.assign(o, {
    category: msg.category || 'general',
    mode: msg.mode,
    providers: [...new Set(calls.map((s) => s.provider))],
    author: writer,
    tryout: msg.tryout || null,
    cost: [...calls, msg.blind].filter(Boolean).reduce((a, s) => a + (s.cost || 0), 0),
    ms: msg.ms || 0,
  });
  if (!existing) list.unshift(o);
  save(list);
}

// User signals. `delta` is +1 to add, -1 to undo.
//  up / down / best — satisfaction votes
//  source           — the user opened a source this AI found (credits upstream research)
//  accept           — copied or shared the answer: engagement only, never a quality vote
export function signal(msgId, pid, kind, delta = 1) {
  const list = load();
  const o = list.find((x) => x.id === msgId);
  if (!o || !pid) return;
  if (kind === 'accept') {
    o.eng[pid] = Math.max(0, (o.eng[pid] || 0) + delta);
  } else {
    const c = cell(o.sat, pid);
    if (kind === 'down') c.neg = Math.max(0, c.neg + delta);
    else c.pos = Math.max(0, c.pos + delta * (kind === 'source' ? 0.5 : 1));
  }
  save(list);
}

// Result of a blind A/B check: 'team' | 'solo' | 'same', plus which AI answered alone.
export function blindResult(msgId, winner, soloPid) {
  const list = load();
  const o = list.find((x) => x.id === msgId);
  if (!o) return;
  o.team = winner === 'team' ? 'better' : winner === 'solo' ? 'worse' : 'same';
  o.solo = soloPid;
  if (winner === 'solo') cell(o.sat, soloPid).pos += 1;
  save(list);
}

// Per task type: each AI's score — verified results count double, satisfaction once, engagement
// not at all — as a Bayesian average starting from 50% so a few signals can't crown a champion.
// Plus blind team-vs-one-AI results.
export function personalStats() {
  const stats = {};
  const outcomes = load();
  for (const o of outcomes) {
    const c = (stats[o.category] ||= { providers: {}, team: { better: 0, same: 0, worse: 0 }, tasks: 0 });
    c.tasks++;
    if (o.team) c.team[o.team]++;
    for (const [pid, s] of Object.entries(o.sat || {})) { const p = cell(c.providers, pid); p.pos += s.pos; p.neg += s.neg; }
    for (const [pid, s] of Object.entries(o.ver || {})) { const p = cell(c.providers, pid); p.vpos = (p.vpos || 0) + s.pos; p.vneg = (p.vneg || 0) + s.neg; }
    for (const [pid, n] of Object.entries(o.eng || {})) { const p = cell(c.providers, pid); p.eng = (p.eng || 0) + n; }
  }
  for (const c of Object.values(stats)) {
    for (const p of Object.values(c.providers)) {
      const vpos = p.vpos || 0, vneg = p.vneg || 0;
      p.n = p.pos + p.neg + vpos + vneg;
      const w = p.pos + p.neg + 2 * (vpos + vneg);
      p.score = (p.pos + 2 * vpos + 1) / (w + 2);
      p.spread = Math.sqrt((p.score * (1 - p.score)) / (w + 3)); // rough ± for display
    }
  }
  return { stats, total: outcomes.length };
}

export function rankedFor(category, avail) {
  const c = personalStats().stats[category];
  if (!c) return [];
  return Object.entries(c.providers)
    .filter(([pid, p]) => avail.includes(pid) && p.n >= MIN_SIGNALS)
    .map(([pid, p]) => ({ pid, ...p }))
    .sort((a, b) => b.score - a.score);
}

// A clear personal favourite: enough evidence, and ahead of the runner-up by a real margin.
export function personalChampion(category, avail) {
  const [top, next] = rankedFor(category, avail);
  if (!top) return null;
  return !next || top.score - next.score >= 0.05 ? top : null;
}

// Lines the planner reads, so routing follows this user's own results once there's enough of them.
// `tryout` names an AI to give a turn to (exploration), overriding the preference for this task.
export function plannerHints(category, avail, names, tryout = null) {
  const lines = [];
  const rows = rankedFor(category, avail);
  const champ = personalChampion(category, avail);
  if (rows.length) {
    lines.push(`This user's own results on ${CATEGORIES[category].toLowerCase()} requests (independently verified results count double): ` +
      rows.map((r) => `${names[r.pid]} ${Math.round(r.score * 100)}% (${Math.round(r.n)} signals)`).join(', ') + '.' +
      (champ && !tryout ? ` Prefer ${names[champ.pid]} for steps that fit its specialty.` : ''));
  }
  if (tryout) {
    lines.push(`Tryout: this task is one where another AI gets a turn so rankings stay honest — if any step fits ${names[tryout]}'s specialty, assign it to ${names[tryout]}.`);
  }
  const c = personalStats().stats[category];
  if (c && c.team.same + c.team.worse >= 3 && c.team.better <= 1) {
    lines.push(`In blind checks, this user found the full team no better than a single AI on ${CATEGORIES[category].toLowerCase()} requests (${c.team.same + c.team.worse} of ${c.team.better + c.team.same + c.team.worse}). Use 1 step unless the request clearly needs more.`);
  }
  return lines.join('\n');
}

// Exploration: occasionally pick an AI that isn't the user's current favourite for this task type.
export function pickTryout(category, avail, rand = Math.random()) {
  if (avail.length < 3 || rand >= TRYOUT_RATE) return null;
  const champ = personalChampion(category, avail);
  if (!champ) return null; // nothing to keep honest yet
  const others = avail.filter((id) => id !== champ.pid && id !== 'deepseek');
  return others.length ? others[Math.floor(rand / TRYOUT_RATE * others.length) % others.length] : null;
}

// A money-and-time-saving tip when blind checks show the team isn't earning its keep.
export function suggestion(category, avail, names) {
  const c = personalStats().stats[category];
  if (!c) return null;
  const votes = c.team.better + c.team.same + c.team.worse;
  if (votes < 3 || c.team.better > votes / 3) return null;
  const best = personalChampion(category, avail);
  return `In blind checks on ${CATEGORIES[category].toLowerCase()}, the team beat one AI in only ${c.team.better} of ${votes} tasks.` +
    (best ? ` Direct mode with ${names[best.pid]} is faster and cheaper.` : ' Direct mode is faster and cheaper.');
}

export function exportOutcomes() {
  return { exported: new Date().toISOString(), note: 'Elite AI outcomes — no prompts or answers, only which AIs worked on what kind of task and how they did.', outcomes: load() };
}

export function resetOutcomes() {
  store.write('outcomes', []);
}
