// How the AIs work together. Every credit the app shows comes from this execution log —
// never from an AI describing its own work.

import { P, available, chat, hasWeb } from './providers.js';
import { classify, plannerHints, pickTryout, CATEGORIES } from './learning.js';

// Default first choice for each team role, from public leaderboards (see EVIDENCE in providers.js,
// reviewed 2026-10-20). A Champion Audit replaces these with the user's own measured rankings.
//  plan:      Opus 5.5 #1 Agent Arena steerability; Argon #1 instruction following; Sol #16
//  write:     Opus 5.5 #1 creative writing, Argon #2 (within margin); Sol #30
//  verify:    Argon lowest hallucination rate (15%) and #1 factuality board; DeepSeek 94–97%
//  challenge: no critique benchmark exists — strongest reasoners first (low confidence)
//  research:  Sol #2 Search Arena; sonar-pro #37 of 42 (only web-capable AIs are eligible)
export const DEFAULT_ORDER = {
  plan: ['anthropic', 'google', 'openai', 'deepseek', 'xai', 'mistral', 'perplexity'],
  write: ['anthropic', 'google', 'openai', 'deepseek', 'xai', 'mistral', 'perplexity'],
  verify: ['google', 'anthropic', 'openai', 'xai', 'mistral', 'perplexity', 'deepseek'],
  challenge: ['google', 'anthropic', 'openai', 'xai', 'deepseek', 'mistral', 'perplexity'],
  research: ['openai', 'google', 'perplexity', 'anthropic', 'xai', 'mistral', 'deepseek'],
};

// Which audited skill decides each role.
export const ROLE_SKILL = { plan: 'planning', write: 'writing', verify: 'factcheck', challenge: 'critique', research: 'research' };

export const ROLE_LABELS = { plan: 'Planner', write: 'Final writer', verify: 'Verifier' };

export function orderFor(role, settings) {
  const base = DEFAULT_ORDER[role];
  const measured = settings.useAudit ? settings.routing?.[ROLE_SKILL[role]] : null;
  return measured?.length ? [...measured, ...base.filter((id) => !measured.includes(id))] : base;
}

export function pick(role, avail, settings, exclude = []) {
  const ok = (id) => avail.includes(id) && !exclude.includes(id);
  const chosen = settings.roles?.[role];
  if (chosen && chosen !== 'auto' && ok(chosen)) return chosen;
  return orderFor(role, settings).find(ok) || avail.find(ok) || null;
}

// How the planner sees each teammate: reputation, audit evidence, and web access.
function memberLine(id, settings) {
  const m = settings.useAudit ? settings.measured?.[id] : null;
  const evidence = m && (m.best?.length || m.strong?.length)
    ? ` | measured in this user's audit — best at: ${m.best?.join(', ') || 'nothing yet'}${m.strong?.length ? `; also strong at: ${m.strong.join(', ')}` : ''}`
    : '';
  const web = hasWeb(id, settings) ? 'HAS live web search' : 'no live web access (knowledge cutoff)';
  return `- ${id} — ${P[id].name} — championed for: ${P[id].champion}${evidence} | ${web}`;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
const who = (id) => (P[id].name === P[id].company ? P[id].name : `${P[id].name} (${P[id].company})`);

function contextBlock(history) {
  const turns = history.filter((m) => m.content).slice(-8);
  if (!turns.length) return '';
  return 'Earlier in this conversation (for context):\n' +
    turns.map((m) => `${m.role === 'user' ? 'User' : 'Elite AI'}: ${clip(m.content, 1500)}`).join('\n\n') + '\n\n';
}

// Alternating user/assistant messages for a one-AI conversation.
function chatHistory(history, task) {
  const msgs = [];
  for (const m of [...history.filter((x) => x.content), { role: 'user', content: task }]) {
    const role = m.role === 'user' ? 'user' : 'assistant';
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content += '\n\n' + m.content;
    else msgs.push({ role, content: m.content });
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  return msgs.slice(-16);
}

export const todayLong = () => new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
// A getter so the date is always current, even if the app stays open past midnight.
const T = { get INTRO() { return `Elite AI is a team of AIs from different companies, each championed for what it does best. Today's date is ${todayLong()}.`; } };
const FORMAT = 'Format with Markdown (short headings, bullets, tables) only where it helps readability.';

// Web-capable AIs search only on steps that need current facts (searches may be billed separately).
const WANTS_WEB = /research|fact|verif|check|opinion|current|latest|recent|news|today|price|source|cite/i;

// ---- One AI call, recorded as a step --------------------------------------------

async function runStep(ctx, step, { system, messages, toFinal = false, maxTokens }) {
  step.status = 'working';
  step.output = '';
  ctx.update();
  try {
    const r = await chat(step.provider, ctx.settings, {
      system,
      messages,
      maxTokens,
      signal: ctx.signal,
      search: step.provider !== 'perplexity' && hasWeb(step.provider, ctx.settings) && WANTS_WEB.test(`${step.role} ${step.instruction || ''} ${ctx.task}`),
      onToken: (_, full) => {
        step.output = full;
        if (toFinal) ctx.msg.content = full;
        ctx.update();
      },
    });
    Object.assign(step, {
      output: r.text, model: r.model, via: r.via, usage: r.usage, ms: r.ms, cost: r.cost, citations: r.citations, note: r.note, status: 'done',
    });
    if (toFinal) ctx.msg.content = r.text;
    ctx.spend(r.cost);
  } catch (e) {
    if (e.name === 'AbortError') { step.status = 'stopped'; throw e; }
    step.status = 'error';
    step.error = e.message;
  }
  ctx.update();
  return step;
}

function collectSources(msg) {
  const seen = new Set();
  msg.sources = [];
  for (const s of [...(msg.steps || []), ...(msg.checks || [])]) {
    for (const c of s.citations || []) {
      if (!seen.has(c.url)) { seen.add(c.url); msg.sources.push({ ...c, provider: s.provider }); }
    }
  }
}

function newStep(provider, role, extra = {}) {
  return { id: 's' + Math.random().toString(36).slice(2, 8), provider, role, status: 'waiting', output: '', ...extra };
}

// ---- Elite Team ----------------------------------------------------------------------

export function plannerSystem(avail, settings, hints = '') {
  const allFive = settings.allFive && avail.length > 1;
  return `You are the planner for Elite AI. ${T.INTRO}

Plan how the team should handle the user's latest request.
- Use the FEWEST team members that will produce the most trustworthy result. Simple, casual or quick requests get exactly 1 step.
- Add a member only when their specialty clearly improves the answer: live web research for anything current (news, prices, recent facts, local info); a specialist for code, math, translation or a second perspective.
- Anything that needs current information must go to a member that HAS live web search. Members without it only know what they learned in training.
- Prefer members whose measured audit results show they are best at the skill a step needs.
${allFive ? `- The user has switched on ALL FIVE mode: give EVERY team member exactly one step that fits its specialty (${avail.length} steps), so all of them contribute (this overrides the fewest-members rule). DeepSeek may only draft math, code or structure — never facts.\n` : ''}- ${allFive ? `At most ${avail.length} steps.` : 'At most 3 steps — every extra AI adds time and cost.'} Steps with no dependencies run in parallel; a step can build on earlier steps via depends_on.
- Do NOT add a final "combine / summarize / write the answer" step — the team's final writer does that automatically.
- Set "verify" to true only when the request is high-stakes or fact-heavy enough to justify an independent check (health, money, legal, safety, important facts, code that must run).

Team members:
${avail.map((id) => memberLine(id, settings)).join('\n')}
${hints ? `\n${hints}\n` : ''}
Reply with ONLY this JSON — no code fences, no commentary:
{"complexity":"simple|moderate|complex","category":"${Object.keys(CATEGORIES).join('|')}","reason":"one short sentence on why this team","verify":false,"steps":[{"id":"s1","assignee":"<member id>","role":"<2-3 word role>","instruction":"<exactly what this member should produce>","depends_on":[]}]}`;
}

const ALIASES = { chatgpt: 'openai', gpt: 'openai', claude: 'anthropic', gemini: 'google', grok: 'xai', 'x-ai': 'xai' };

export function parsePlan(text, avail) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  const idMap = {};
  const steps = [];
  for (const [i, s] of (Array.isArray(j.steps) ? j.steps : []).slice(0, 5).entries()) {
    let prov = String(s.assignee || '').toLowerCase().trim();
    prov = ALIASES[prov] || prov;
    if (!avail.includes(prov)) continue;
    const step = newStep(prov, clip(String(s.role || 'Specialist'), 40), {
      instruction: clip(String(s.instruction || ''), 1500),
      // Only earlier steps can be dependencies, so a plan can never deadlock.
      depends_on: (Array.isArray(s.depends_on) ? s.depends_on : []).map((d) => idMap[String(d)]).filter(Boolean),
    });
    idMap[String(s.id ?? 's' + (i + 1))] = step.id;
    steps.push(step);
  }
  if (!steps.length) return null;
  return { steps, reason: clip(String(j.reason || ''), 300), verify: j.verify === true, category: CATEGORIES[j.category] ? j.category : null };
}

function defaultPlan(avail, settings) {
  if (avail.length === 1) {
    return { reason: 'Only one AI is connected.', steps: [newStep(avail[0], 'Answer', { instruction: '', depends_on: [] })] };
  }
  const steps = [];
  const researcher = pick('research', avail.filter((id) => hasWeb(id, settings)), settings);
  if (researcher) {
    steps.push(newStep(researcher, 'Researcher', { instruction: 'Find the current, relevant facts for this request, with sources.', depends_on: [] }));
  }
  steps.push(newStep(pick('plan', avail, settings, researcher ? [researcher] : []), 'Analyst', { instruction: 'Work through the request and draft a thorough answer.', depends_on: [] }));
  return { reason: 'Default team: research plus analysis, merged by the final writer.', steps };
}

function stepPrompt(ctx, step, inputs, single) {
  const p = P[step.provider];
  const research = step.provider === 'perplexity' || /research/i.test(step.role);
  if (single) {
    return {
      system: `You are ${who(step.provider)}, answering on behalf of Elite AI. ${T.INTRO} You were chosen for this request for your strength in: ${p.champion}. Answer the user directly and helpfully. ${FORMAT}`,
      messages: [{ role: 'user', content: contextBlock(ctx.history) + ctx.task + (step.instruction ? `\n\n(Planner's note: ${step.instruction})` : '') }],
    };
  }
  const teamWork = inputs.length
    ? '\n\nWork from teammates you can build on:\n\n' + inputs.map((s) => `### ${s.role} — ${P[s.provider].name}\n${clip(s.output, 12000)}`).join('\n\n')
    : '';
  return {
    system: `You are ${who(step.provider)} on the Elite AI team. ${T.INTRO} Your role: ${step.role}. You were picked for: ${p.champion}. Do only your assignment and do it excellently. Be substantive but concise — a teammate turns the team's work into the final answer.${research ? ' Cite the source URL for every key fact.' : ''}`,
    messages: [{ role: 'user', content: `${contextBlock(ctx.history)}User's request:\n${ctx.task}\n\nYour assignment (${step.role}):\n${step.instruction || 'Handle the request.'}${teamWork}` }],
  };
}

function writerPrompt(ctx, steps) {
  const failed = (ctx.msg.steps || []).filter((s) => s.status === 'error');
  return {
    messages: [{
      role: 'user',
      content: `${contextBlock(ctx.history)}User's request:\n${ctx.task}\n\nTeammates' work:\n\n` +
        steps.map((s) => `### ${s.role} — ${P[s.provider].name} (live web: ${hasWeb(s.provider, ctx.settings) ? 'yes' : 'no'})\n${s.instruction ? `(Assignment: ${s.instruction})\n` : ''}${clip(s.output, 14000)}` +
          (s.citations?.length ? `\nSources: ${s.citations.map((c) => c.url).join(' ')}` : '')).join('\n\n') +
        (failed.length ? `\n\n(Note: ${failed.map((s) => P[s.provider].name).join(', ')} could not contribute this time.)` : ''),
    }],
  };
}

async function writeFinal(ctx, steps, avail) {
  const { msg, settings } = ctx;
  const tried = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const writer = pick('write', avail, settings, tried);
    if (!writer) break;
    tried.push(writer);
    const step = newStep(writer, 'Final writer');
    msg.writer = step;
    msg.phase = `${P[writer].name} is writing the final answer`;
    await runStep(ctx, step, {
      system: `You are ${who(writer)}, the final writer for Elite AI. ${T.INTRO} Teammates have each completed part of the user's request. Write the single best final answer, directly to the user:
- Merge their work into one clear, well-organized answer.
- Where teammates disagree, go with the better-supported view and briefly say so.
- Keep useful source links as Markdown links. Never invent sources.
- Only teammates with live web access had current information. If the request depends on recent facts that nobody researched live, say the details may be out of date.
- Don't describe the internal process or credit teammates — the app shows credits automatically.
${FORMAT}`,
      ...writerPrompt(ctx, steps),
      toFinal: true,
    });
    if (step.status === 'done') {
      if (tried.length > 1) noteSubstitution(msg, 'Final writer', tried[0], writer, msg.failed.at(-1)?.error);
      return;
    }
    // Keep the failed attempt in the log: substitutions are never silent.
    (msg.failed ||= []).push(step);
    msg.writer = null;
  }
  // No writer available: show the team's work as-is so nothing is lost.
  msg.content = steps.map((s) => `### ${s.role} — ${P[s.provider].name}\n\n${s.output}`).join('\n\n');
}

function noteSubstitution(msg, role, from, to, reason, byUser = false) {
  (msg.substitutions ||= []).push({ role, from, to, reason: reason ? clip(reason, 200) : '', byUser });
}

// The best stand-in for a failed step: a web-capable AI for research-type work, otherwise the
// strongest available generalist — never the AI that just failed.
export function suggestReplacement(step, settings, exclude = []) {
  const avail = available(settings).filter((id) => id !== step.provider && !exclude.includes(id));
  const needsWeb = WANTS_WEB.test(`${step.role} ${step.instruction || ''}`);
  const pool = needsWeb && avail.some((id) => hasWeb(id, settings)) ? avail.filter((id) => hasWeb(id, settings)) : avail;
  return pick(needsWeb ? 'research' : 'plan', pool, settings);
}

// Redo one failed step with another AI (the user's choice), then rebuild the final answer.
export async function redoStep(ctx, stepId, provider) {
  const { msg, settings } = ctx;
  const old = msg.steps.find((s) => s.id === stepId);
  if (!old) return;
  const step = newStep(provider, old.role, { instruction: old.instruction, depends_on: old.depends_on || [] });
  old.replacedBy = step.id;
  msg.steps.splice(msg.steps.indexOf(old) + 1, 0, step);
  noteSubstitution(msg, old.role, old.provider, provider, old.error, true);
  msg.error = '';
  const live = msg.steps.filter((s) => !s.replacedBy);
  const byId = Object.fromEntries(msg.steps.map((s) => [s.id, s]));
  const inputs = step.depends_on.map((d) => byId[d]).filter((d) => d?.status === 'done');

  if (msg.mode === 'compare') {
    msg.phase = `${P[provider].name} is answering`;
    await runStep(ctx, step, {
      system: `You are ${who(provider)}, answering inside Elite AI, where the user compares answers from several AIs side by side. Today's date is ${todayLong()}. Give your best, complete answer. ${FORMAT}`,
      messages: chatHistory(ctx.history, ctx.task),
    });
  } else {
    const single = live.length === 1;
    msg.phase = `${P[provider].name} is redoing the ${old.role} step`;
    await runStep(ctx, step, { ...stepPrompt(ctx, step, inputs, single), toFinal: single });
    if (step.status !== 'done') throw new Error(step.error);
    if (!single) {
      const ok = live.filter((s) => s.status === 'done');
      // Earlier final answer and its checks stay in the log (and the cost total), marked superseded.
      msg.failed ||= [];
      const hadVerifier = (msg.checks || []).some((c) => c.role === 'Verifier');
      if (msg.writer) msg.failed.push({ ...msg.writer, superseded: true });
      for (const c of msg.checks || []) msg.failed.push({ ...c, superseded: true });
      msg.checks = [];
      await writeFinal(ctx, ok, available(settings));
      // The new answer gets the same independent check the old one had.
      const verifier = hadVerifier && pick('verify', available(settings), settings, [msg.writer?.provider]);
      if (verifier) await secondOpinion(ctx, verifier, 'Verifier');
    }
  }
  collectSources(msg);
}

export async function runTeam(ctx) {
  const { msg, settings } = ctx;
  const avail = ctx.avail || available(settings);
  if (!avail.length) throw new Error('No AIs are connected yet — add a key in Settings.');

  let plan = null;
  // Exploration (ChatGPT's review): now and then another AI gets a turn so a favourite can't lock in.
  msg.tryout = settings.allFive ? null : pickTryout(classify(ctx.task), avail);
  if (avail.length > 1) {
    const planner = pick('plan', avail, settings);
    msg.planner = newStep(planner, 'Planner');
    msg.phase = `${P[planner].name} is planning the team`;
    await runStep(ctx, msg.planner, {
      system: plannerSystem(avail, settings, plannerHints(classify(ctx.task), avail, Object.fromEntries(avail.map((id) => [id, P[id].name])), msg.tryout)),
      messages: [{ role: 'user', content: contextBlock(ctx.history) + 'Latest request:\n' + ctx.task }],
      maxTokens: 1500,
    });
    if (msg.planner.status === 'done') {
      plan = parsePlan(msg.planner.output, avail);
      if (!plan) msg.planner.note = 'The plan was unreadable, so the default team was used.';
    }
  }
  plan ||= defaultPlan(avail, settings);
  msg.category = plan.category || classify(ctx.task);
  msg.reason = plan.reason;
  msg.steps = plan.steps;
  ctx.update();

  const single = msg.steps.length === 1;
  const byId = Object.fromEntries(msg.steps.map((s) => [s.id, s]));
  const running = {};
  const run = (s) => (running[s.id] ||= (async () => {
    await Promise.all(s.depends_on.map((d) => run(byId[d])));
    const inputs = s.depends_on.map((d) => byId[d]).filter((d) => d.status === 'done');
    msg.phase = single ? `${P[s.provider].name} is answering` : 'Specialists at work';
    return runStep(ctx, s, { ...stepPrompt(ctx, s, inputs, single), toFinal: single });
  })());
  await Promise.all(msg.steps.map(run));

  const ok = msg.steps.filter((s) => s.status === 'done');
  if (!ok.length) throw new Error(msg.steps.map((s) => s.error).filter(Boolean).join(' • ') || 'No AI could answer.');
  if (!single) await writeFinal(ctx, ok, avail);

  if (plan.verify && avail.length > 1) {
    const author = msg.writer?.provider || msg.steps[0].provider;
    const verifier = pick('verify', avail, settings, [author]);
    if (verifier) await secondOpinion(ctx, verifier, 'Verifier');
  }
  collectSources(msg);
}

// ---- Compare ----------------------------------------------------------------------------

export async function runCompare(ctx) {
  const { msg } = ctx;
  msg.category = classify(ctx.task);
  const ids = ctx.avail;
  if (!ids.length) throw new Error('No AIs are connected yet — add a key in Settings.');
  msg.steps = ids.map((id) => newStep(id, 'Answer'));
  msg.phase = `Asking ${ids.length} AI${ids.length > 1 ? 's' : ''} at once`;
  ctx.update();
  await Promise.all(msg.steps.map((s) => runStep(ctx, s, {
    system: `You are ${who(s.provider)}, answering inside Elite AI, where the user compares answers from several AIs side by side. Today's date is ${todayLong()}. Give your best, complete answer. ${FORMAT}`,
    messages: chatHistory(ctx.history, ctx.task),
  })));
  if (!msg.steps.some((s) => s.status === 'done')) throw new Error(msg.steps.map((s) => s.error).filter(Boolean).join(' • '));
  collectSources(msg);
}

// Turns a Compare round into one Elite answer.
export async function mergeCompare(ctx) {
  const ok = ctx.msg.steps.filter((s) => s.status === 'done');
  await writeFinal(ctx, ok, available(ctx.settings));
  collectSources(ctx.msg);
}

// ---- Cross-check -------------------------------------------------------------------

export async function runCrossCheck(ctx) {
  const { msg, settings } = ctx;
  msg.category = classify(ctx.task);
  const avail = ctx.avail;
  if (!avail.length) throw new Error('No AIs are connected yet — add a key in Settings.');
  const drafter = pick('write', avail, settings);
  const v = pick('verify', avail, settings, [drafter]);
  const c = pick('challenge', avail, settings, [drafter, v]);
  const reviewers = [v && ['Fact-checker', v], c && ['Challenger', c]].filter(Boolean);

  const draft = newStep(drafter, 'Drafter');
  msg.steps = [draft];
  msg.phase = `${P[drafter].name} is drafting`;
  await runStep(ctx, draft, {
    system: `You are ${who(drafter)} on the Elite AI team. ${T.INTRO} Write a strong first draft answering the user; teammates will review it before you finalize. ${FORMAT}`,
    messages: chatHistory(ctx.history, ctx.task),
    toFinal: !reviewers.length,
  });
  if (draft.status !== 'done') throw new Error(draft.error);
  if (!reviewers.length) { collectSources(msg); return; }

  const reviews = reviewers.map(([role, id]) => newStep(id, role));
  msg.steps.push(...reviews);
  msg.phase = `${reviews.map((r) => P[r.provider].name).join(' and ')} reviewing the draft`;
  await Promise.all(reviews.map((r) => runStep(ctx, r, {
    system: `You are ${who(r.provider)} on the Elite AI team, reviewing a teammate's draft as the ${r.role}. Be specific and constructive: flag factual errors, weak reasoning, missing points${r.role === 'Challenger' ? ', and assumptions worth challenging' : ''}. Bullet points, max 200 words. If the draft is solid, say so briefly.`,
    messages: [{ role: 'user', content: `${contextBlock(ctx.history)}User's request:\n${ctx.task}\n\nDraft by ${P[drafter].name}:\n${draft.output}` }],
  })));

  const done = reviews.filter((r) => r.status === 'done');
  const revise = newStep(drafter, 'Reviser');
  msg.steps.push(revise);
  msg.phase = `${P[drafter].name} is revising`;
  await runStep(ctx, revise, {
    system: `You are ${who(drafter)}. Revise your draft using your teammates' reviews: adopt the points that are right, ignore the ones that aren't. Output only the improved final answer, written to the user. ${FORMAT}`,
    messages: [{
      role: 'user',
      content: `${contextBlock(ctx.history)}User's request:\n${ctx.task}\n\nYour draft:\n${draft.output}\n\nReviews:\n\n${
        done.map((r) => `### ${r.role} — ${P[r.provider].name}\n${r.output}`).join('\n\n') || '(No reviews came back.)'}`,
    }],
    toFinal: true,
  });
  if (revise.status !== 'done') msg.content = draft.output;
  collectSources(msg);
}

// ---- Direct ---------------------------------------------------------------------------

export async function runDirect(ctx) {
  const { msg } = ctx;
  msg.category = classify(ctx.task);
  const id = ctx.provider;
  const step = newStep(id, 'Answer');
  msg.steps = [step];
  msg.phase = `${P[id].name} is answering`;
  await runStep(ctx, step, {
    system: `You are ${who(id)}, chatting with the user inside Elite AI. Today's date is ${todayLong()}. ${FORMAT}`,
    messages: chatHistory(ctx.history, ctx.task),
    toFinal: true,
  });
  if (step.status !== 'done') throw new Error(step.error);
  collectSources(msg);
}

// ---- Second opinion (on any answer) ------------------------------------------------

export async function secondOpinion(ctx, provider, role = 'Second opinion') {
  const { msg, settings } = ctx;
  msg.checks ||= [];
  const check = newStep(provider, role);
  msg.checks.push(check);
  msg.phase = `${P[provider].name} is checking the answer`;
  // Check against what the team actually gathered, not just the checker's own memory
  // (suggested by both ChatGPT and Gemini in their design reviews).
  const evidence = (msg.steps || []).filter((s) => s.status === 'done' && !s.replacedBy && s.provider !== provider && (s.citations?.length || hasWeb(s.provider, settings)));
  const evidenceBlock = evidence.length
    ? '\n\nEvidence teammates gathered (check the answer against it):\n\n' + evidence.map((s) => `### ${s.role} — ${P[s.provider].name}\n${clip(s.output, 6000)}${s.citations?.length ? `\nSources: ${s.citations.map((c) => c.url).join(' ')}` : ''}`).join('\n\n')
    : '';
  const searches = hasWeb(provider, settings) && provider !== 'perplexity';
  await runStep(ctx, check, {
    system: `You are ${who(provider)}, giving an independent second opinion inside Elite AI. Today's date is ${todayLong()}. Check the answer below for factual errors, risky advice, broken logic or code bugs, and important omissions.${evidence.length ? ' Compare it with the evidence teammates gathered and flag any claim that no source supports.' : ''}${searches ? ' Use your web search to verify key facts independently — agreement between AIs is not proof.' : ''} Start with exactly one verdict line:
Verdict: ✅ Looks right   — or —   Verdict: ⚠️ Mostly right, with caveats   — or —   Verdict: ❌ Has problems
Then up to 5 short bullets naming specific issues (quote the claim). If nothing material is wrong, one bullet on what you checked. Max 160 words.`,
    messages: [{ role: 'user', content: `${contextBlock(ctx.history)}User's request:\n${ctx.task}\n\nAnswer to check:\n${msg.content}${evidenceBlock}` }],
    maxTokens: 1200,
  });
  collectSources(msg);
}

// ---- Blind check (learning loop) ----------------------------------------------------------------
// One AI answers the same request alone, so the user can compare it with the team's answer
// without knowing which is which — a real counterfactual instead of a guess.
export async function blindSolo(ctx, provider) {
  const { msg } = ctx;
  const step = newStep(provider, 'Blind check', { blindCheck: true, order: Math.random() < 0.5 ? 'team-first' : 'solo-first' });
  msg.blind = step;
  msg.phase = 'Preparing a blind check';
  await runStep(ctx, step, {
    system: `You are ${who(provider)}. Today's date is ${todayLong()}. Answer the user directly and helpfully. ${FORMAT}`,
    messages: chatHistory(ctx.history, ctx.task),
  });
  if (step.status !== 'done') msg.blind = null; // a failed check is simply skipped
}
