import { PROVIDERS, RESERVES, EVIDENCE, P, OPENROUTER, connection, available, modelFor, modelKey, listModels, autoPick, loadPrices, hasWeb, LOCAL_FAMILIES, LOCAL_DEFAULT_URL, DEPLOY, allowedHosts, listPrivateModels } from './providers.js';
import { installNetworkGuard, networkLog, networkSummary } from './net.js';
import { runTeam, runCompare, mergeCompare, runCrossCheck, runDirect, secondOpinion, pick, ROLE_LABELS, redoStep, suggestReplacement, blindSolo, runHuddle, stripStance } from './orchestrator.js';
import { SKILLS, SKILL, TASKS, estimateAudit, runAudit, saveRun, loadRuns, summarizeRuns, rankings, perAI, recommend, confidence, isTop } from './audit.js';
import { renderMarkdown, esc } from './markdown.js';
import { store } from './store.js';
import { CATEGORIES, MIN_SIGNALS, BLIND_RATE, recordOutcome, signal, blindResult, personalStats, rankedFor, personalChampion, suggestion, exportOutcomes, resetOutcomes } from './learning.js';

const VERSION = '0.4.0 beta';

const MODES = {
  huddle: { label: 'Huddle', hint: 'The AIs talk it through with each other inside the app — no web, no outside sites — then agree on one answer.' },
  team: { label: 'Elite Team', hint: 'The planner picks the best AI for each part of your task, then one final answer — with credits.' },
  compare: { label: 'Compare', hint: 'Every AI on your team answers side by side. Pick the best or merge them into one.' },
  crosscheck: { label: 'Cross-check', hint: 'One AI drafts, others fact-check and challenge it, then the draft is revised.' },
  direct: { label: 'Direct', hint: 'Chat with one AI of your choice.' },
};

const EXAMPLES = [
  'What changed in AI this week, and what does it mean for a small business?',
  'Plan a 3-day Austin trip in March for a family of four on a $1,500 budget.',
  'Write a warm, short email inviting my team to a Friday demo day.',
  'Explain compound interest with a worked example, then quiz me.',
  'Translate “We’re closed Monday for the holiday” into Spanish, French and Japanese.',
  'Poke holes in this idea: a subscription service for weekly car washes.',
];

// ---- State -----------------------------------------------------------------------------

const DEFAULTS = {
  keys: {}, models: {}, off: {}, roles: { plan: 'auto', write: 'auto', verify: 'auto' },
  geminiSearch: true, openaiSearch: true, dailyCap: 5, mode: 'team', directProvider: null, welcomed: false,
  useAudit: false, routing: null, measured: null, auditAt: null, allFive: false, learningChecks: 'some',
  sealed: false, huddleRounds: 3,
  local: { on: false, url: LOCAL_DEFAULT_URL, models: {} },
  gateway: { on: false, url: '', key: '', models: {} },
};
const loaded = store.read('settings', {});
const settings = { ...DEFAULTS, ...loaded, roles: { ...DEFAULTS.roles, ...(loaded.roles || {}) } };
settings.local = { ...DEFAULTS.local, ...(loaded.local || {}), models: { ...(loaded.local?.models || {}) } };
settings.gateway = { ...DEFAULTS.gateway, ...(loaded.gateway || {}), models: { ...(loaded.gateway?.models || {}) } };
// A company deployment (config.js) can pin privacy settings for everyone; see ENTERPRISE.md.
if (DEPLOY) {
  if (DEPLOY.sealed) settings.sealed = true;
  if (DEPLOY.gateway?.url) settings.gateway = { on: true, url: DEPLOY.gateway.url, key: settings.gateway.key || DEPLOY.gateway.key || '', models: { ...(DEPLOY.gateway.models || {}) } };
  if (DEPLOY.local?.url) settings.local = { ...settings.local, url: DEPLOY.local.url, on: DEPLOY.local.on ?? settings.local.on, models: { ...(DEPLOY.local.models || {}), ...settings.local.models } };
}
const isSealed = () => !!(settings.sealed || settings.local?.on || settings.gateway?.on);
// Every request goes through the guard; in Sealed mode only the connected AIs are reachable.
installNetworkGuard(() => ({ sealed: isSealed(), hosts: allowedHosts(settings) }));
let threads = store.read('threads', []);
let scores = store.read('scores', {});
let currentId = threads[0]?.id || null;

const ui = {
  controller: null,
  runningMsg: null,
  open: new Set(),
  models: {}, // modelKey -> [{id}]
  keyMsg: {}, // provider -> {ok, text}
  installPrompt: null,
  sheet: null,
  audit: { view: 'setup', full: false, team: true, run: null, controller: null, timer: 0 },
};

const saveSettings = () => store.write('settings', settings);
const saveScores = () => store.write('scores', scores);

function saveThreads() {
  threads.sort((a, b) => b.updated - a.updated);
  while (!store.write('threads', threads) && threads.length > 1) threads.pop(); // storage full: drop the oldest
}

const today = () => new Date().toLocaleDateString('en-CA');
function spentToday() {
  const s = store.read('spend', null);
  return s && s.day === today() ? s.usd : 0;
}
function addSpend(usd) {
  if (typeof usd !== 'number' || !isFinite(usd)) return;
  store.write('spend', { day: today(), usd: spentToday() + usd });
}

const thread = () => threads.find((t) => t.id === currentId) || null;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---- Formatting helpers --------------------------------------------------------------------

const $ = (s, el = document) => el.querySelector(s);
const money = (usd) => (usd == null ? '—' : usd === 0 ? '$0' : usd < 0.01 ? '<$0.01' : '
const secs = (ms) => (ms == null ? '' : (ms / 1000).toFixed(1) + 's');
const num = (n) => (n || 0).toLocaleString();
const isTouch = matchMedia('(pointer: coarse)').matches;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

const badge = (id, size = '') => `<span class="badge ${size}" style="--c:${P[id].color}" aria-hidden="true">${P[id].mark}</span>`;
const chip = (id, label = '') => `<span class="chip" style="--c:${P[id].color}">${badge(id, 'sm')}<b>${esc(P[id].name)}</b>${label ? `<span>${esc(label)}</span>` : ''}</span>`;
const domain = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

function toast(text, ms = 2600) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

// ---- Credits & totals (from the execution log only) -------------------------------------------

function allCalls(msg) {
  return [msg.planner, ...(msg.steps || []), msg.writer, ...(msg.checks || []), ...(msg.failed || []), msg.blind].filter(Boolean);
}

function credits(msg) {
  const map = new Map();
  for (const s of allCalls(msg)) {
    if (s.status !== 'done' || s.superseded || s.blindCheck) continue;
    if (!map.has(s.provider)) map.set(s.provider, []);
    const roles = map.get(s.provider);
    if (!roles.includes(s.role)) roles.push(s.role);
  }
  return [...map.entries()];
}

function totals(msg) {
  const calls = allCalls(msg).filter((s) => s.status === 'done' || s.status === 'error');
  let cost = 0, unknown = false, tokens = 0;
  for (const s of calls) {
    if (s.status !== 'done') continue;
    tokens += (s.usage?.in || 0) + (s.usage?.out || 0);
    if (s.cost == null) unknown = true; else cost += s.cost;
  }
  return { calls: calls.length, ais: new Set(calls.filter((s) => s.status === 'done').map((s) => s.provider)).size, tokens, cost, unknown };
}

// ---- Rendering: messages ---------------------------------------------------------------------

function renderUser(msg) {
  return `<article class="msg user" data-mid="${msg.id}"><div class="bubble">${esc(msg.content).replace(/\n/g, '<br>')}</div></article>`;
}

const STATUS_ICON = { waiting: '○', working: '<span class="spin" aria-label="working"></span>', done: '✓', error: '!', stopped: '■' };

function stepMeta(s) {
  const bits = [];
  if (s.model) bits.push(esc(s.model.replace(/^[\w-]+\//, '')) + (s.via === 'openrouter' ? ' · via OpenRouter' : ''));
  if (s.ms) bits.push(secs(s.ms));
  if (s.usage) bits.push(num(s.usage.in + s.usage.out) + ' tokens');
  if (s.status === 'done') bits.push(s.cost == null ? 'cost n/a' : '≈' + money(s.cost));
  return bits.join(' · ');
}

function renderStepRow(msg, s, { showOutput = true, rate = true } = {}) {
  const key = `o-${msg.id}-${s.id}`;
  const live = s.status === 'working' && s.output;
  return `<div class="step ${s.status}">
    <div class="step-head">${chip(s.provider, s.role)}<span class="st">${STATUS_ICON[s.status] || ''}</span></div>
    <div class="step-meta">${stepMeta(s)}</div>
    ${s.instruction ? `<div class="step-instr"><b>Assignment:</b> ${esc(s.instruction)}</div>` : ''}
    ${s.note ? `<div class="step-instr">${esc(s.note)}</div>` : ''}
    ${s.error ? `<div class="err-line">${esc(s.error)}</div>` : ''}
    ${s.replacedBy ? '<div class="step-instr">↳ Redone by another AI below.</div>' : ''}
    ${s.superseded ? '<div class="step-instr">Superseded after a step was redone.</div>' : ''}
    ${live ? `<div class="live">${esc(s.output.slice(-220))}</div>` : ''}
    ${showOutput && s.status === 'done' && s.output ? `<details data-key="${key}"${ui.open.has(key) ? ' open' : ''}><summary>Show ${esc(P[s.provider].name)}’s contribution</summary><div class="md">${renderMarkdown(s.output)}</div></details>` : ''}
    ${rate && s.status === 'done' && msg.status !== 'running' ? `<div class="rate" role="group" aria-label="Rate this contribution">
      <button class="mini${s.rating === 'up' ? ' on' : ''}" data-act="rate" data-mid="${msg.id}" data-sid="${s.id}" data-v="up" aria-label="Helpful">👍</button>
      <button class="mini${s.rating === 'down' ? ' on' : ''}" data-act="rate" data-mid="${msg.id}" data-sid="${s.id}" data-v="down" aria-label="Not helpful">👎</button></div>` : ''}
  </div>`;
}

function renderPlannerRow(msg) {
  const s = msg.planner;
  if (!s) return '';
  let planText = '';
  if (s.status === 'done') {
    planText = msg.reason ? `<div class="step-instr"><b>Plan:</b> ${esc(msg.reason)}</div>` : '';
    if (msg.steps?.length) {
      planText += `<ol class="plan-list">${msg.steps.map((x) => `<li>${chip(x.provider, x.role)}${x.depends_on?.length ? '<small> builds on earlier work</small>' : ''}</li>`).join('')}</ol>`;
    }
  }
  return `<div class="step ${s.status}">
    <div class="step-head">${chip(s.provider, 'Planner')}<span class="st">${STATUS_ICON[s.status] || ''}</span></div>
    <div class="step-meta">${stepMeta(s)}</div>${planText}
    ${s.note ? `<div class="step-instr">${esc(s.note)}</div>` : ''}
    ${s.error ? `<div class="err-line">${esc(s.error)} — used the default team instead.</div>` : ''}
  </div>`;
}

function renderLiveTeam(msg) {
  // Watch the team work while a run is in progress: who is doing what, streaming live.
  const rows = [
    msg.planner ? renderPlannerRow(msg) : '',
    ...(msg.steps || []).map((s) => renderStepRow(msg, s, { showOutput: false, rate: false })),
    msg.writer ? renderStepRow(msg, msg.writer, { showOutput: false, rate: false }) : '',
  ].join('');
  return rows.trim() ? `<div class="live-team">${rows}</div>` : '';
}

function renderCompare(msg) {
  const done = msg.steps.filter((s) => s.status === 'done').length;
  return `<div class="compare">${msg.steps.map((s) => `<section class="card ${s.status}${msg.best === s.id ? ' best' : ''}">
      <header>${chip(s.provider)}<span class="st">${STATUS_ICON[s.status] || ''}</span></header>
      <div class="card-meta">${stepMeta(s)}</div>
      ${s.error ? `<div class="err-line">${esc(s.error)}</div>` : `<div class="md">${renderMarkdown(s.output || '')}${s.status === 'working' ? '<span class="caret"></span>' : ''}</div>`}
      ${s.status === 'done' && msg.status !== 'running' ? `<footer>
        <button class="btn sm ${msg.best === s.id ? 'gold' : 'ghost'}" data-act="best" data-mid="${msg.id}" data-sid="${s.id}">${msg.best === s.id ? '★ Your pick' : '☆ Best answer'}</button>
        <button class="btn sm ghost" data-act="copy-step" data-mid="${msg.id}" data-sid="${s.id}">Copy</button></footer>` : ''}
    </section>`).join('')}</div>
    ${done >= 2 && msg.status !== 'running' && !msg.content ? `<div class="merge-row"><button class="btn gold" data-act="merge" data-mid="${msg.id}">✦ Merge into one Elite answer</button></div>` : ''}`;
}

// Failures are never silent: show every substitution, and offer a qualified stand-in for each
// failed step (the user decides — Elite AI never swaps an AI on its own except the final writer).
function renderRecovery(msg) {
  const seen = new Set();
  const notes = (msg.substitutions || []).filter((x) => {
    const k = `${x.role}|${x.from}|${x.to}|${x.byUser}`;
    return !seen.has(k) && seen.add(k);
  }).map((x) => `<div class="sub-note">⚠ ${x.from === x.to
    ? `Retried ${esc(P[x.to].name)}'s ${esc(x.role)} step`
    : x.byUser ? `You asked ${esc(P[x.to].name)} to redo ${esc(P[x.from].name)}'s ${esc(x.role)} step`
      : `${esc(P[x.from].name)} couldn't finish as ${esc(x.role)}, so ${esc(P[x.to].name)} stepped in`}${x.reason ? ` — ${esc(x.reason)}` : ''}</div>`).join('');
  if (msg.status === 'running') return notes;
  const failed = (msg.steps || []).filter((s) => s.status === 'error' && !s.replacedBy);
  const offers = failed.map((s) => {
    const alt = msg.mode === 'compare' ? s.provider : suggestReplacement(s, settings);
    return alt ? `<button class="btn sm" data-act="redo" data-mid="${msg.id}" data-sid="${s.id}" data-id="${alt}">${alt === s.provider ? `Retry ${esc(P[alt].name)}` : `Redo ${esc(P[s.provider].name)}'s ${esc(s.role)} step with ${esc(P[alt].name)}`}</button>` : '';
  }).join('');
  return notes + (offers && msg.mode !== 'crosscheck' && msg.mode !== 'direct' ? `<div class="recovery"><span class="muted small">${failed.length} step${failed.length > 1 ? 's' : ''} failed. Finished work is kept.</span>${offers}</div>` : '');
}

// The huddle room: every message one AI sent to the others, inside the app.
function renderHuddle(msg) {
  const h = msg.huddle;
  if (!h) return '';
  const key = `room-${msg.id}`;
  const running = msg.status === 'running';
  const rounds = [...new Set((msg.steps || []).map((x) => x.round))];
  const body = rounds.map((r) => `<div class="round-sep">${r === 0 ? 'Opening thoughts' : `Round ${r + 1}`}</div>` +
    msg.steps.filter((x) => x.round === r).map((x) => `<div class="rmsg ${x.status}" style="--c:${P[x.provider].color}">
      <div class="rmsg-head">${badge(x.provider, 'sm')}<b>${esc(P[x.provider].name)}</b>${x.to?.length ? `<span class="to">→ ${x.to.map((id) => esc(P[id].name)).join(', ')}</span>` : ''}${x.stance ? `<span class="stance ${x.stance}">${x.stance === 'agree' ? '✓ agrees' : '✋ objects'}</span>` : ''}<span class="st">${x.status === 'working' ? STATUS_ICON.working : x.status === 'error' ? '!' : ''}</span></div>
      ${x.error ? `<div class="err-line">${esc(x.error)}</div>` : `<div class="md">${renderMarkdown(stripStance(x.output || ''))}</div>`}
      ${x.stance === 'object' && x.reason ? `<div class="step-instr">Would change: ${esc(x.reason)}</div>` : ''}
    </div>`).join('')).join('');
  const spoke = (msg.steps || []).filter((x) => x.status === 'done').length;
  const summary = running ? `In progress · ${h.members.length} AIs talking`
    : `${h.consensus ? '✓ The team agreed' : h.objections?.length ? `${h.objections.length} still objecting — noted in the answer` : 'Rounds complete'} · ${spoke} messages`;
  return `<details class="room" data-key="${key}"${running || ui.open.has(key) ? ' open' : ''}><summary><span>🔒 Huddle room</span><small>${esc(summary)}</small></summary>
    <div class="room-note">The AIs are talking to each other inside Elite AI. Nobody in the room can search the web or reach any outside site.</div>${body}</details>`;
}

function renderChecks(msg) {
  return (msg.checks || []).map((c) => `<div class="check ${c.status}">
    <div class="step-head">${chip(c.provider, c.role)}<span class="st">${STATUS_ICON[c.status] || ''}</span></div>
    ${c.error ? `<div class="err-line">${esc(c.error)}</div>` : `<div class="md">${renderMarkdown(c.output || '')}</div>`}
  </div>`).join('');
}

function renderSources(msg) {
  if (!msg.sources?.length) return '';
  const key = `src-${msg.id}`;
  return `<details class="sources" data-key="${key}"${ui.open.has(key) ? ' open' : ''}><summary>Sources (${msg.sources.length})</summary><ol>${
    msg.sources.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" data-act="src" data-mid="${msg.id}" data-pid="${s.provider}">${esc(s.title && s.title !== domain(s.url) ? s.title : domain(s.url))}</a> <small>${esc(domain(s.url))} · via ${esc(P[s.provider].name)}</small></li>`).join('')
  }</ol></details>`;
}

function renderReplay(msg) {
  const t = totals(msg);
  if (!t.calls || msg.mode === 'direct' || msg.status === 'running') return '';
  const key = `r-${msg.id}`;
  const rows = [
    msg.planner ? renderPlannerRow(msg) : '',
    msg.mode === 'compare' || msg.mode === 'huddle' ? '' : (msg.steps || []).map((s) => renderStepRow(msg, s)).join(''),
    msg.writer ? renderStepRow(msg, msg.writer, { showOutput: false }) : '',
    (msg.failed || []).length ? `<div class="earlier">Earlier attempts</div>${msg.failed.map((x) => renderStepRow(msg, x, { showOutput: false, rate: false })).join('')}` : '',
  ].join('');
  if (!rows.trim()) return '';
  return `<details class="replay" data-key="${key}"${ui.open.has(key) ? ' open' : ''}>
    <summary><span>Team replay</span><small>${t.ais} AI${t.ais === 1 ? '' : 's'} · ${t.calls} call${t.calls === 1 ? '' : 's'}${msg.ms ? ' · ' + secs(msg.ms) : ''} · ≈${money(t.cost)}${t.unknown ? '+' : ''}</small></summary>
    <div class="replay-body">${rows}</div></details>`;
}

function renderAssistant(msg) {
  const running = msg.status === 'running';
  const team = credits(msg);
  const t = totals(msg);
  const answerStreaming = running && msg.content;
  return `<article class="msg ai ${msg.status}" data-mid="${msg.id}">
    ${msg.tryout && credits(msg).some(([id]) => id === msg.tryout) ? `<div class="muted small">🔬 Tryout: ${esc(P[msg.tryout].name)} got a turn on this task so the rankings stay honest.</div>` : ''}
    <div class="credits"><span class="mode-tag">${esc(MODES[msg.mode]?.label || '')}</span>${team.map(([id, roles]) => chip(id, roles.join(' + '))).join('')}</div>
    ${running ? `<div class="progress"><span class="spin"></span>${esc(msg.phase || 'Working')}…</div>${(msg.mode === 'team' || msg.mode === 'crosscheck') && !msg.content ? renderLiveTeam(msg) : ''}` : ''}
    ${msg.mode === 'compare' && msg.steps?.length ? renderCompare(msg) : ''}
    ${msg.mode === 'huddle' ? renderHuddle(msg) : ''}
    ${msg.content ? `<div class="answer md">${msg.mode === 'compare' ? '<div class="answer-label">✦ Elite answer</div>' : ''}${renderMarkdown(msg.content)}${answerStreaming ? '<span class="caret"></span>' : ''}</div>` : ''}
    ${msg.error ? `<div class="error-box">${esc(msg.error)}${/key|connect|Settings/i.test(msg.error) ? ' <button class="btn sm" data-act="settings">Open Settings</button>' : ''}</div>` : ''}
    ${msg.status === 'stopped' ? '<div class="muted small">Stopped.</div>' : ''}
    ${renderRecovery(msg)}
    ${renderChecks(msg)}
    ${renderSources(msg)}
    ${renderReplay(msg)}
    ${!running && (msg.content || msg.steps?.some((s) => s.status === 'done')) ? `<div class="actions">
      ${msg.content ? `<button class="btn sm ghost" data-act="copy" data-mid="${msg.id}">Copy</button>` : ''}
      ${msg.content && navigator.share ? `<button class="btn sm ghost" data-act="share" data-mid="${msg.id}">Share</button>` : ''}
      ${msg.content && available(settings).length > 1 ? `<button class="btn sm ghost" data-act="second" data-mid="${msg.id}">Get a second opinion</button>` : ''}
      ${msg.mode === 'direct' && t.calls ? `<span class="muted small">${esc(stepMeta(msg.steps[0]))}</span>` : ''}
    </div>` : ''}
    ${renderBlind(msg)}
  </article>`;
}

const names = () => Object.fromEntries(PROVIDERS.map((p) => [p.id, p.name]));

// Blind check (learning loop): the team's answer next to one AI's answer, unlabeled, so the user
// judges two answers they can actually see. ChatGPT asked "was the team better than one AI?";
// Gemini pointed out nobody can judge an answer they never saw — this does both.
function renderBlind(msg) {
  const b = msg.blind;
  if (!b || msg.status !== 'done' || !msg.content) return '';
  const teamFirst = b.order === 'team-first';
  const [A, B] = teamFirst ? [msg.content, b.output] : [b.output, msg.content];
  const winner = b.verdict;
  const label = (x) => (x === 'team' ? 'the Elite Team' : x === 'solo' ? `${P[b.provider].name} alone` : '');
  const reveal = winner ? `<p class="small">${winner === 'same' ? 'You called it even.' : `You picked ${label(winner)}.`} Answer A was ${label(teamFirst ? 'team' : 'solo')}; Answer B was ${label(teamFirst ? 'solo' : 'team')}. Thanks — your team learns from this.</p>` : '';
  const tip = winner && winner !== 'team' ? suggestion(msg.category, available(settings), names()) : null;
  const keyA = `bl-a-${msg.id}`, keyB = `bl-b-${msg.id}`;
  return `<div class="blind">
    <div class="blind-head"><b>🔬 Blind check</b><span class="muted small">Same request, two answers, no names. Which helps you more?</span></div>
    <details data-key="${keyA}"${ui.open.has(keyA) ? ' open' : ''}><summary>Answer A</summary><div class="md">${renderMarkdown(A)}</div></details>
    <details data-key="${keyB}"${ui.open.has(keyB) ? ' open' : ''}><summary>Answer B</summary><div class="md">${renderMarkdown(B)}</div></details>
    <div class="fb-row">${[['A', 'A is better'], ['same', 'About the same'], ['B', 'B is better']].map(([v, t]) => {
      const meaning = v === 'same' ? 'same' : (v === 'A') === teamFirst ? 'team' : 'solo';
      return `<button class="mini${winner === meaning ? ' on' : ''}" data-act="blind-vote" data-mid="${msg.id}" data-v="${meaning}">${t}</button>`;
    }).join('')}</div>${reveal}</div>
    ${tip ? `<div class="tip-line">💡 ${esc(tip)}</div>` : ''}`;
}

// Run a blind check on about 1 in 8 team answers (Settings can switch this off).
async function maybeBlind(ctx) {
  const { msg } = ctx;
  const mode = settings.learningChecks === false ? 'off' : settings.learningChecks === true ? 'some' : settings.learningChecks || 'some';
  if (mode === 'off' || !msg.content || credits(msg).length < 2) return;
  if (mode !== 'all' && Math.random() >= BLIND_RATE) return;
  const avail = available(settings);
  const solo = personalChampion(msg.category, avail)?.pid || msg.writer?.provider || pick('write', avail, settings);
  if (solo) await blindSolo(ctx, solo);
}

const renderMsg = (msg) => (msg.role === 'user' ? renderUser(msg) : renderAssistant(msg));

// ---- Rendering: empty state, sidebar, composer -------------------------------------------------

function renderEmpty() {
  const avail = available(settings);
  const iosTip = isIOS && !isStandalone && !store.read('iosTipDone', false);
  return `<section class="empty">
    <img class="hero-mark" src="icons/icon.svg" alt="" width="72" height="72">
    <h1>Every great AI.<br><span class="gold">Working together.</span></h1>
    <p class="lead">Elite AI puts the Elite 5 — ChatGPT, Claude, Gemini, Grok and DeepSeek — on one team, each championed for what it does best, with every contribution credited.</p>
    ${iosTip ? `<div class="tip">📲 <b>Install on iPhone:</b> tap the Share button, then <b>Add to Home Screen</b>. <button class="link" data-act="ios-tip-done">Got it</button></div>` : ''}
    ${!avail.length ? `<div class="cta-card"><div><b>Connect your AIs to start</b><p>You use your own AI accounts and pay each company directly. One OpenRouter key unlocks all five, or add each company's key.</p></div><button class="btn gold" data-act="settings">Connect my AIs</button></div>` : ''}
    <div class="how">
      <div><span>1</span><b>Plan</b><p>A lead AI breaks your task into steps.</p></div>
      <div><span>2</span><b>Champions work</b><p>Each step goes to the AI that does it best — in parallel.</p></div>
      <div><span>3</span><b>One answer, full credits</b><p>A final writer merges the work. Replay exactly who did what.</p></div>
    </div>
    <h2 class="section-title">The team <button class="link" data-act="team">See details</button></h2>
    <div class="roster">${PROVIDERS.map((p) => {
      const conn = connection(p.id, settings);
      return `<button class="roster-item${conn ? '' : ' off'}" data-act="${conn ? 'team' : 'settings'}">${badge(p.id)}<span><b>${esc(p.name)}</b><small>${esc(p.champion)}</small></span><i>${conn ? (settings.off[p.id] ? 'Benched' : '●') : '+'}</i></button>`;
    }).join('')}</div>
    ${avail.length ? `<h2 class="section-title">Try one</h2><div class="examples">${EXAMPLES.map((e) => `<button class="example" data-act="example">${esc(e)}</button>`).join('')}</div>` : ''}
  </section>`;
}

function renderFeed() {
  const feed = $('#feed');
  const t = thread();
  feed.innerHTML = !t || !t.messages.length ? renderEmpty() : `<div class="thread">${t.messages.map(renderMsg).join('')}</div>`;
}

function renderSidebar() {
  $('#thread-list').innerHTML = threads.length
    ? threads.map((t) => `<div class="thread-item${t.id === currentId ? ' active' : ''}">
        <button class="thread-open" data-act="open-thread" data-tid="${t.id}"><b>${esc(t.title)}</b><small>${new Date(t.updated).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${esc(MODES[t.messages[0]?.mode]?.label || '')}</small></button>
        <button class="icon-btn sm" data-act="del-thread" data-tid="${t.id}" aria-label="Delete conversation">×</button></div>`).join('')
    : '<p class="muted small pad">Your conversations will appear here. They are saved only on this device.</p>';
}

function renderModes() {
  document.querySelectorAll('.modes button').forEach((b) => {
    const on = b.dataset.mode === settings.mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on);
  });
}

function directProvider() {
  const avail = available(settings);
  if (avail.includes(settings.directProvider)) return settings.directProvider;
  return avail[0] || null;
}

function renderComposer() {
  const avail = available(settings);
  const mode = settings.mode;
  const direct = mode === 'direct';
  const chosen = direct ? directProvider() : null;
  $('#team-row').innerHTML = PROVIDERS.map((p) => {
    const conn = connection(p.id, settings);
    if (!conn) return `<button class="pill ghost" data-act="settings" title="Connect ${esc(p.name)}">${badge(p.id, 'sm')}${esc(p.name)} <i>+</i></button>`;
    const on = direct ? p.id === chosen : !settings.off[p.id];
    return `<button class="pill${on ? ' on' : ''}" style="--c:${p.color}" data-act="${direct ? 'pick-direct' : 'toggle-ai'}" data-id="${p.id}" aria-pressed="${on}" title="${esc(p.champion)}">${badge(p.id, 'sm')}${esc(p.name)}</button>`;
  }).join('') + (mode === 'team' && avail.length > 2
    ? `<button class="pill all5${settings.allFive ? ' on' : ''}" data-act="all-five" aria-pressed="${!!settings.allFive}" title="Every AI contributes on every task — slower and costs more">✦ All ${avail.length}</button>`
    : '');

  let who = '';
  if (avail.length) {
    if (mode === 'team') {
      const planner = avail.length > 1 ? pick('plan', avail, settings) : null;
      const writer = pick('write', avail, settings);
      who = settings.allFive && avail.length > 2 ? `All ${avail.length} AIs contribute on every task (slower, costs more)` : !planner ? `${P[avail[0]].name} answers` : planner === writer ? `${P[planner].name} plans and writes the final answer · specialists in between` : `${P[planner].name} plans · ${P[writer].name} writes the final answer`;
    } else if (mode === 'huddle') {
      who = avail.length < 2 ? 'Connect a second AI to huddle' : `${avail.length} AIs huddle inside the app · up to ${settings.huddleRounds || 3} rounds · ${P[pick('write', avail, settings)].name} writes the answer`;
    } else if (mode === 'compare') who = `${avail.length} AI${avail.length > 1 ? 's' : ''} answer side by side`;
    else if (mode === 'crosscheck') {
      const d = pick('write', avail, settings);
      who = `${P[d].name} drafts · ${avail.length > 1 ? 'others review' : 'connect another AI to review'}`;
    } else who = chosen ? `Chatting with ${P[chosen].name}` : '';
  }
  const spent = spentToday();
  $('#composer-meta').innerHTML = avail.length
    ? `${isSealed() ? '<span class="sealed-tag" title="Only your connected AIs are reachable">🔒 Sealed</span><span class="dot-sep">•</span>' : ''}<span>${esc(who)}</span><span class="dot-sep">•</span><span>Today ≈${money(spent)}${settings.dailyCap > 0 ? ` of $${settings.dailyCap} cap` : ''}</span>`
    : `<button class="link" data-act="settings">Connect your AIs to start →</button>`;
  $('#input').placeholder = direct && chosen ? `Message ${P[chosen].name}…` : mode === 'compare' ? 'Ask every AI at once…' : mode === 'huddle' ? 'Give the team something to talk through…' : 'Give the team a task…';
  const running = !!ui.controller;
  const send = $('#btn-send');
  send.classList.toggle('stop', running);
  send.setAttribute('aria-label', running ? 'Stop' : 'Send');
  send.innerHTML = running ? '<svg viewBox="0 0 24 24" width="18" height="18"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  $('#install-btn').hidden = !ui.installPrompt;
}

function renderAll() {
  renderModes();
  renderSidebar();
  renderFeed();
  renderComposer();
}

// Live updates during a run: patch changed messages ~20x a second. A timer (not
// requestAnimationFrame) so updates still land if the app was in the background.
const pending = new Set();
let frame = 0;
function scheduleMsg(msg) {
  pending.add(msg);
  frame ||= setTimeout(() => {
    frame = 0;
    const feed = $('#feed');
    const stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 140;
    for (const m of pending) {
      const el = feed.querySelector(`[data-mid="${m.id}"]`);
      if (el) el.outerHTML = renderMsg(m);
    }
    pending.clear();
    if (stick) feed.scrollTop = feed.scrollHeight;
  }, 50);
}

function scrollToBottom() {
  const feed = $('#feed');
  setTimeout(() => { feed.scrollTop = thread()?.messages.length ? feed.scrollHeight : 0; }, 0);
}

// ---- Running a task -------------------------------------------------------------------------

function makeCtx(msg, task, history, extra = {}) {
  return {
    msg, task, history, settings,
    signal: ui.controller.signal,
    update: () => scheduleMsg(msg),
    spend: (usd) => addSpend(usd),
    ...extra,
  };
}

async function guarded(msg, fn) {
  ui.runningMsg = msg;
  msg.status = 'running';
  const t0 = performance.now();
  renderComposer();
  scheduleMsg(msg);
  try {
    await fn();
    msg.status = 'done';
  } catch (e) {
    if (e.name === 'AbortError') msg.status = 'stopped';
    else { msg.status = 'error'; msg.error = e.message; }
  }
  msg.ms = (msg.ms || 0) + Math.round(performance.now() - t0);
  msg.phase = '';
  if (msg.status === 'done') recordOutcome(msg);
  ui.controller = null;
  ui.runningMsg = null;
  const t = thread();
  if (t) t.updated = Date.now();
  saveThreads();
  scheduleMsg(msg);
  renderComposer();
  renderSidebar();
}

function overBudget() {
  if (settings.dailyCap > 0 && spentToday() >= settings.dailyCap) {
    toast(`Daily budget of $${settings.dailyCap} reached. Raise it in Settings → Budget.`, 4000);
    return true;
  }
  return false;
}

async function send(text) {
  text = text.trim();
  if (!text || ui.controller) return;
  const avail = available(settings);
  if (!avail.length) { openSettings(); toast('Connect at least one AI first.'); return; }
  if (overBudget()) return;

  let t = thread();
  if (!t) {
    t = { id: uid(), title: text.slice(0, 60), created: Date.now(), updated: Date.now(), messages: [] };
    threads.unshift(t);
    currentId = t.id;
  }
  const history = t.messages.map((m) => ({ role: m.role, content: m.content }));
  const mode = settings.mode;
  const user = { id: uid(), role: 'user', content: text, mode, ts: Date.now() };
  const msg = { id: uid(), role: 'assistant', mode, content: '', steps: [], status: 'running', ts: Date.now() };
  t.messages.push(user, msg);
  t.updated = Date.now();
  $('#input').value = '';
  autoGrow();
  renderFeed();
  renderSidebar();
  scrollToBottom();

  ui.controller = new AbortController();
  const ctx = makeCtx(msg, text, history, { avail });
  await guarded(msg, () => {
    if (mode === 'huddle') return runHuddle(ctx);
    if (mode === 'compare') return runCompare(ctx);
    if (mode === 'crosscheck') return runCrossCheck(ctx);
    if (mode === 'direct') return runDirect({ ...ctx, provider: directProvider() });
    return runTeam(ctx).then(() => maybeBlind(ctx));
  });
}

function findMsg(id) {
  const t = thread();
  const i = t?.messages.findIndex((m) => m.id === id) ?? -1;
  return i < 0 ? {} : { t, msg: t.messages[i], index: i };
}

async function followUp(msgId, fn) {
  if (ui.controller) return;
  if (overBudget()) return;
  const { t, msg, index } = findMsg(msgId);
  if (!msg) return;
  const task = t.messages[index - 1]?.content || '';
  const history = t.messages.slice(0, index - 1).map((m) => ({ role: m.role, content: m.content }));
  msg.error = '';
  ui.controller = new AbortController();
  await guarded(msg, () => fn(makeCtx(msg, task, history)));
}

// ---- Sheets (settings, team, second opinion, feedback, welcome) ----------------------------------

function openSheet(title, body, { wide = false, onRender } = {}) {
  ui.sheet = { title, body, wide, onRender };
  $('#sheet-root').innerHTML = `<div class="sheet-backdrop" data-act="close-sheet"><div class="sheet${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <header><h2>${esc(title)}</h2><button class="icon-btn" data-act="close-sheet" aria-label="Close">×</button></header>
    <div class="sheet-body">${typeof body === 'function' ? body() : body}</div></div></div>`;
  document.body.classList.add('sheet-open');
  onRender?.();
}

function refreshSheet() {
  if (!ui.sheet || typeof ui.sheet.body !== 'function') return;
  const bodyEl = $('.sheet-body');
  if (!bodyEl) return;
  const active = document.activeElement;
  const keep = active && bodyEl.contains(active) && active.dataset.field ? active.dataset.field : null;
  // Background updates (model lists, key checks) must never wipe what someone is typing.
  const typed = {};
  bodyEl.querySelectorAll('input[data-field], textarea[data-field]').forEach((f) => { if (f.value && f.type !== 'number') typed[f.dataset.field] = f.value; });
  const top = bodyEl.scrollTop;
  bodyEl.innerHTML = ui.sheet.body();
  for (const [field, value] of Object.entries(typed)) {
    const f = bodyEl.querySelector(`[data-field="${field}"]`);
    if (f) f.value = value;
  }
  bodyEl.scrollTop = top;
  if (keep) bodyEl.querySelector(`[data-field="${keep}"]`)?.focus();
}

function closeSheet() {
  ui.sheet = null;
  $('#sheet-root').innerHTML = '';
  document.body.classList.remove('sheet-open');
}

const maskKey = (k) => (k ? `${k.slice(0, 5)}…${k.slice(-4)}` : '');

function providerRow(p) {
  const conn = connection(p.id, settings);
  const key = settings.keys[p.id];
  const mk = conn ? modelKey(p.id, conn.via) : null;
  const models = mk ? ui.models[mk] : null;
  const current = conn ? modelFor(p.id, settings) : null;
  const options = (models?.length ? models.map((m) => m.id) : current ? [current] : []);
  if (current && !options.includes(current)) options.unshift(current);
  const m = ui.keyMsg[p.id];
  const status = !conn ? '<span class="status off">Not connected</span>'
    : conn.via === 'openrouter' ? '<span class="status via">Via OpenRouter</span>'
    : m && !m.ok ? '<span class="status bad">Check key</span>' : '<span class="status ok">Connected</span>';
  return `<div class="prov" style="--c:${p.color}">
    <div class="prov-head">${badge(p.id)}<div class="prov-name"><b>${esc(p.name)}</b> <small>${esc(p.company)}</small><div class="champ">${esc(p.champion)}</div></div>${status}</div>
    <div class="row">
      <input type="password" autocomplete="off" spellcheck="false" data-field="key-${p.id}" placeholder="${key ? 'Saved key ' + esc(maskKey(key)) + ' — paste to replace' : `Paste your ${esc(p.company)} API key`}">
      <button class="btn sm" data-act="save-key" data-id="${p.id}">Save</button>
      ${key ? `<button class="btn sm ghost" data-act="remove-key" data-id="${p.id}">Remove</button>` : ''}
    </div>
    ${conn ? `<div class="row wrap">
      <label class="field">Model <select data-act="model" data-id="${p.id}">${options.map((o) => `<option value="${esc(o)}"${o === current ? ' selected' : ''}>${esc(o.replace(p.orPrefix, ''))}</option>`).join('')}</select></label>
      <button class="btn sm ghost" data-act="load-models" data-id="${p.id}">${models ? 'Refresh list' : 'Load models'}</button>
      <label class="check-label"><input type="checkbox" data-act="bench" data-id="${p.id}"${settings.off[p.id] ? '' : ' checked'}> On the team</label>
    </div>` : ''}
    ${m ? `<div class="prov-msg ${m.ok ? 'ok' : 'bad'}">${esc(m.text)}</div>` : ''}
    <div class="links"><a href="${p.keyUrl}" target="_blank" rel="noopener noreferrer">Get a key ↗</a><a href="${p.usageUrl}" target="_blank" rel="noopener noreferrer">Usage &amp; limits ↗</a><a href="${p.productUrl}" target="_blank" rel="noopener noreferrer">Try ${esc(p.name)} ↗</a></div>
  </div>`;
}

function roleSelect(role) {
  const avail = available(settings);
  return `<label class="field">${ROLE_LABELS[role]} <select data-act="role" data-role="${role}">
    <option value="auto"${settings.roles[role] === 'auto' ? ' selected' : ''}>Auto (${avail.length ? esc(P[pick(role, avail, { roles: {} })]?.name || '—') : '—'})</option>
    ${avail.map((id) => `<option value="${id}"${settings.roles[role] === id ? ' selected' : ''}>${esc(P[id].name)}</option>`).join('')}
  </select></label>`;
}

// Privacy & deployment: Sealed mode, offline AIs on this computer, a company gateway, and a
// log of every outside request the app has made this session.
function privacySection() {
  const locked = !!DEPLOY;
  const net = networkSummary();
  const lm = ui.localModels || [];
  const gm = ui.gwModels || [];
  const seatSelect = (act, id, current, list, allowNone = true) => {
    const opts = [...new Set([current, ...list.map((m) => m.id)].filter(Boolean))];
    return `<select data-act="${act}" data-id="${id}">${allowNone ? `<option value="">— sits out —</option>` : ''}${opts.map((o) => `<option value="${esc(o)}"${o === current ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  };
  return `<section class="set">
    <h3>🔒 Privacy: where your data goes</h3>
    <p class="muted">Elite AI has no server. Requests go only to the AIs you connect, and in a Huddle the AIs talk to each other inside this app.${locked ? ' <b>These settings are managed by your company.</b>' : ''}</p>
    <label class="check-label"><input type="checkbox" data-act="sealed"${settings.sealed ? ' checked' : ''}${locked && DEPLOY.sealed ? ' disabled' : ''}> <span><b>Sealed mode</b> — the app may only talk to your connected AIs. No web search, no other sites, no price lookups. Anything else is blocked and logged.</span></label>
    <div class="netlog"><b>Outside requests this session:</b> ${net.length ? net.map((n) => `<span class="chip-plain">${esc(n.host)} · ${n.count}${n.blocked ? ` (${n.blocked} blocked)` : ''}</span>`).join('') : '<span class="muted">none yet</span>'} <button class="link" data-act="netlog">Full log</button></div>

    <h4>Offline: AIs on this computer</h4>
    <p class="muted small">OpenAI (gpt-oss), Google (Gemma) and DeepSeek publish open models you can run on your own machine with Ollama or LM Studio, so nothing leaves the device. Claude, and the newest ChatGPT, Gemini and Grok models, only run on their companies' servers, so they sit out in offline mode.</p>
    <label class="check-label"><input type="checkbox" data-act="local-on"${settings.local.on ? ' checked' : ''}> Use AIs on this computer only</label>
    <div class="row"><input type="text" data-field="local-url" data-act="local-url" value="${esc(settings.local.url || LOCAL_DEFAULT_URL)}" spellcheck="false" placeholder="${LOCAL_DEFAULT_URL}"><button class="btn sm" data-act="local-load">Find models</button></div>
    ${ui.privMsg?.local ? `<div class="prov-msg ${ui.privMsg.local.ok ? 'ok' : 'bad'}">${esc(ui.privMsg.local.text)}</div>` : ''}
    <div class="seat-grid">${Object.entries(LOCAL_FAMILIES).map(([id, fam]) => `<label class="field">${badge(id, 'sm')} ${esc(P[id].name)}'s seat ${seatSelect('local-model', id, settings.local.models[id] || '', lm.filter((m) => fam.match.test(m.id)).concat(lm.filter((m) => !fam.match.test(m.id))))}<small class="muted">${esc(fam.label)}</small></label>`).join('')}
      <label class="field">${badge('anthropic', 'sm')} Claude's seat <small class="muted">no open model — sits out offline</small></label></div>

    <h4>Company AI gateway (private network)</h4>
    <p class="muted small">For companies: send every AI through your own OpenAI-compatible gateway (for example LiteLLM or Portkey in front of AWS Bedrock, Azure OpenAI and Google Vertex) so traffic never leaves your network. Company deployments set this once for everyone; see ENTERPRISE.md.</p>
    <label class="check-label"><input type="checkbox" data-act="gw-on"${settings.gateway.on ? ' checked' : ''}${locked && DEPLOY.gateway?.url ? ' disabled' : ''}> Use our company gateway</label>
    <div class="row wrap"><input type="text" data-field="gw-url" data-act="gw-url" value="${esc(settings.gateway.url)}" spellcheck="false" placeholder="https://ai-gateway.yourcompany.com/v1"><input type="password" data-field="gw-key" data-act="gw-key" autocomplete="off" placeholder="${settings.gateway.key ? 'Gateway key saved — paste to replace' : 'Gateway key (if required)'}"><button class="btn sm" data-act="gw-load">Find models</button></div>
    ${ui.privMsg?.gw ? `<div class="prov-msg ${ui.privMsg.gw.ok ? 'ok' : 'bad'}">${esc(ui.privMsg.gw.text)}</div>` : ''}
    <div class="seat-grid">${PROVIDERS.map((p) => `<label class="field">${badge(p.id, 'sm')} ${esc(p.name)}'s seat ${gm.length ? seatSelect('gw-model', p.id, settings.gateway.models[p.id] || '', gm) : `<input type="text" data-act="gw-model" data-id="${p.id}" data-field="gw-model-${p.id}" value="${esc(settings.gateway.models[p.id] || '')}" placeholder="model name on your gateway" spellcheck="false">`}</label>`).join('')}</div>
  </section>`;
}

const GW_GUESS = { openai: /gpt|^o\d/i, anthropic: /claude/i, google: /gemini/i, xai: /grok/i, deepseek: /deepseek/i };

async function loadPrivateModels(kind) {
  const isLocal = kind === 'local';
  const url = ($(`[data-field="${isLocal ? 'local-url' : 'gw-url'}"]`)?.value || '').trim();
  if (!url) { toast('Enter the address first.'); return; }
  if (isLocal) settings.local.url = url; else settings.gateway.url = url;
  const keyInput = $('[data-field="gw-key"]')?.value.trim();
  if (!isLocal && keyInput) settings.gateway.key = keyInput;
  saveSettings();
  ui.privMsg = { ...(ui.privMsg || {}), [isLocal ? 'local' : 'gw']: { ok: true, text: 'Looking for models…' } };
  refreshSheet();
  try {
    const list = await listPrivateModels(url, isLocal ? '' : settings.gateway.key);
    if (isLocal) {
      ui.localModels = list;
      for (const [id, fam] of Object.entries(LOCAL_FAMILIES)) {
        if (!settings.local.models[id]) { const hit = list.find((m) => fam.match.test(m.id)); if (hit) settings.local.models[id] = hit.id; }
      }
    } else {
      ui.gwModels = list;
      for (const p of PROVIDERS) {
        if (!settings.gateway.models[p.id]) { const hit = list.find((m) => GW_GUESS[p.id].test(m.id)); if (hit) settings.gateway.models[p.id] = hit.id; }
      }
    }
    saveSettings();
    ui.privMsg[isLocal ? 'local' : 'gw'] = { ok: true, text: `Found ${list.length} model${list.length === 1 ? '' : 's'}. Matching ones were placed in their seats — change any seat below.` };
  } catch (e) {
    const blocked = e instanceof TypeError;
    ui.privMsg[isLocal ? 'local' : 'gw'] = { ok: false, text: blocked
      ? (isLocal ? 'Could not reach it. Is Ollama or LM Studio running? For the web version, start Ollama with OLLAMA_ORIGINS set to this site (see ENTERPRISE.md).' : 'Could not reach the gateway. On the public beta only known AI companies are reachable; deploy Elite AI inside your network with tools/configure.mjs to use a private gateway.')
      : e.message };
  }
  refreshSheet();
  renderComposer();
}

function netlogBody() {
  const rows = networkLog().filter((e) => !e.internal);
  return `<p class="muted">Every outside request Elite AI made this session (host and path only — never keys or content).${isSealed() ? ' Sealed mode is on: only your connected AIs are allowed.' : ''}</p>
  ${rows.length ? `<div class="table-wrap"><table class="matrix netlog-table"><thead><tr><th>Time</th><th>Where</th><th>What</th><th></th></tr></thead><tbody>${rows.map((e) => `<tr><td>${new Date(e.at).toLocaleTimeString()}</td><td>${esc(e.host)}</td><td>${esc(e.method)} ${esc(e.path)}</td><td>${e.allowed ? '✓' : '<span class="bad">blocked</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<p>No outside requests yet.</p>'}`;
}

function settingsBody() {
  const orKey = settings.keys.openrouter;
  const m = ui.keyMsg.openrouter;
  return `
  <section class="set">
    <h3>Connect your AIs</h3>
    <p class="muted">You bring your own AI accounts and pay each company directly — Elite AI never sees, stores or resells your keys. Keys are saved <b>only on this device</b>${isStandalone ? '' : ' in this browser'}; prompts go straight from here to each AI company.</p>
    <div class="prov or">
      <div class="prov-head"><span class="badge" style="--c:#e2b553">★</span><div class="prov-name"><b>Easiest: one key for all five</b><div class="champ">An OpenRouter key reaches every AI below, billed at each model's listed price plus OpenRouter's fee. Any company key you add directly takes priority.</div></div>${orKey ? '<span class="status ok">Connected</span>' : ''}</div>
      <div class="row">
        <input type="password" autocomplete="off" spellcheck="false" data-field="key-openrouter" placeholder="${orKey ? 'Saved key ' + esc(maskKey(orKey)) + ' — paste to replace' : 'Paste your OpenRouter API key'}">
        <button class="btn sm" data-act="save-key" data-id="openrouter">Save</button>
        ${orKey ? '<button class="btn sm ghost" data-act="remove-key" data-id="openrouter">Remove</button>' : ''}
      </div>
      ${m ? `<div class="prov-msg ${m.ok ? 'ok' : 'bad'}">${esc(m.text)}</div>` : ''}
      <div class="links"><a href="${OPENROUTER.keyUrl}" target="_blank" rel="noopener noreferrer">Get a key ↗</a><a href="${OPENROUTER.creditsUrl}" target="_blank" rel="noopener noreferrer">Credits &amp; limits ↗</a></div>
    </div>
    <h4>Or connect each AI company directly</h4>
    ${PROVIDERS.map(providerRow).join('')}
    <p class="muted small">Safety tip: give each key a monthly spending limit in that company's dashboard, and don't install Elite AI on a shared device.</p>
  </section>
  ${privacySection()}
  <section class="set">
    <h3>Team roles</h3>
    <p class="muted small">${settings.useAudit ? `“Auto” uses your Champion Audit from ${esc(new Date(settings.auditAt).toLocaleDateString())}.` : '“Auto” uses public reputation until you run a Champion Audit.'} <button class="link" data-act="audit">${settings.useAudit ? 'See audit' : 'Run a Champion Audit'}</button></p>
    <div class="row wrap">${roleSelect('plan')}${roleSelect('write')}${roleSelect('verify')}<label class="field">Huddle rounds <select data-act="hrounds">${[2, 3, 4].map((n) => `<option value="${n}"${Number(settings.huddleRounds || 3) === n ? ' selected' : ''}>${n}</option>`).join('')}</select></label></div>
    <label class="check-label"><input type="checkbox" data-act="osearch"${settings.openaiSearch !== false ? ' checked' : ''}> Let ChatGPT search the web on research and fact-check steps (it leads the search benchmarks; OpenAI bills searches separately)</label>
    <label class="field">Learning checks (blind A/B of the team vs one AI; each adds one AI call) <select data-act="lchecks">${[['some', `About 1 in ${Math.round(1 / BLIND_RATE)} team answers`], ['all', 'Every team answer (learns fastest)'], ['off', 'Off']].map(([v, t]) => `<option value="${v}"${(settings.learningChecks === true ? 'some' : settings.learningChecks === false ? 'off' : settings.learningChecks || 'some') === v ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
    <label class="check-label"><input type="checkbox" data-act="gsearch"${settings.geminiSearch ? ' checked' : ''}> Let Gemini search Google when it works (grounded answers with sources; Google may bill searches separately)</label>
  </section>
  <section class="set">
    <h3>Budget</h3>
    <div class="row wrap"><label class="field">Daily cap (USD, 0 = none) <input type="number" min="0" step="0.5" inputmode="decimal" data-act="cap" data-field="cap" value="${settings.dailyCap}"></label>
    <span class="muted">Today ≈${money(spentToday())}</span></div>
    <p class="muted small">Costs are estimates from each model's public list price. Your real bill is on each company's usage page.</p>
  </section>
  <section class="set">
    <h3>Install</h3>
    <p class="muted">${isStandalone ? 'Elite AI is installed on this device. ✓'
      : isIOS ? 'iPhone / iPad: open this page in Safari, tap <b>Share</b>, then <b>Add to Home Screen</b>. Keys you saved in Safari need to be added again inside the installed app.'
      : 'Desktop: click the install icon in Chrome or Edge’s address bar (or the Install button at the top), and Elite AI opens in its own window.'}</p>
    ${ui.installPrompt ? '<button class="btn gold" data-act="install">Install Elite AI</button>' : ''}
  </section>
  <section class="set">
    <h3>Your data</h3>
    <div class="row wrap">
      <button class="btn sm ghost" data-act="export">Export conversations</button>
      <button class="btn sm ghost" data-act="clear-threads">Delete all conversations</button>
      <button class="btn sm ghost" data-act="clear-keys">Remove all keys</button>
    </div>
  </section>
  <section class="set">
    <h3>About</h3>
    <p class="muted small">Built by Claude (Anthropic) with design reviews from ChatGPT (OpenAI) and Gemini (Google): ChatGPT shaped Team Replay, second opinions, cost caps, failure recovery, the trust test, the learning loop, tryouts and All 5 mode; Gemini shaped evidence-based verification, the three-step cap, fresh audit numbers, personal routing, upstream credit and the case for blind checks.</p>
    <p class="muted small">Elite AI ${VERSION}. Credits, timings, tokens and costs come from the app's own execution log, never from an AI describing itself. When AIs work together, your request — and teammates' work on it — is sent to each AI company involved, under that company's own terms and privacy policy.</p>
    <p class="muted small">Elite AI is an independent app and is not affiliated with, sponsored or endorsed by OpenAI, Anthropic, Google, xAI, DeepSeek or OpenRouter. Product names belong to their owners and are used only to identify each service.</p>
  </section>`;
}

function openSettings() {
  openSheet('Settings', settingsBody, { wide: true });
  for (const p of PROVIDERS) if (connection(p.id, settings)) ensureModels(p.id);
}

function teamBody() {
  const audited = settings.useAudit && settings.auditAt;
  return `<div class="audit-callout">
      <div><b>${audited ? `Roles use your audit from ${esc(new Date(settings.auditAt).toLocaleDateString())}` : `Roles follow public leaderboards (${esc(EVIDENCE.date)})`}</b>
      <p class="muted small">${audited ? 'Each role goes to the AI that scored best on your own keys.' : 'Run a Champion Audit to test every AI on the same tasks with your own keys and see who is actually best at each job.'}</p></div>
      <button class="btn sm gold" data-act="audit">${audited ? 'Audit again' : 'Run a Champion Audit'}</button>
    </div>
  <p class="muted">Your 👍/👎 and “best answer” picks are tallied here too, so you can see who earns their spot.</p>
  <div class="team-grid">${PROVIDERS.map((p) => {
    const conn = connection(p.id, settings);
    const s = scores[p.id] || {};
    const m = settings.useAudit ? settings.measured?.[p.id] : null;
    return `<div class="team-card" style="--c:${p.color}">
      <div class="prov-head">${badge(p.id)}<div class="prov-name"><b>${esc(p.name)}</b> <small>by ${esc(p.company)}</small></div>
        ${conn ? (settings.off[p.id] ? '<span class="status off">Benched</span>' : '<span class="status ok">On the team</span>') : '<span class="status off">Not connected</span>'}</div>
      <p><b>Championed for:</b> ${esc(p.champion)}</p>
      <p class="muted small">Evidence: ${esc(p.evidence)}</p>
      ${m?.best?.length ? `<p class="measured">★ <b>Measured best at:</b> ${esc(m.best.join(', '))}</p>` : ''}
      ${m?.strong?.length ? `<p class="measured">Also strong at: ${esc(m.strong.join(', '))}</p>` : ''}
      ${conn ? `<p class="muted small">Model: ${esc(modelFor(p.id, settings).replace(p.orPrefix, ''))}${conn.via === 'openrouter' ? ' (via OpenRouter)' : ''} · Live web: ${hasWeb(p.id, settings) ? 'yes' : 'no'}</p>` : ''}
      <p class="muted small">Your ratings: 👍 ${s.up || 0} · 👎 ${s.down || 0} · ★ best ${s.best || 0}</p>
      <a class="link" href="${p.productUrl}" target="_blank" rel="noopener noreferrer">Try ${esc(p.name)} from ${esc(p.company)} ↗</a>
    </div>`;
  }).join('')}</div>
  <details class="sources why-five"><summary>Why only five?</summary><div class="pad small">
    <p>Elite AI keeps only the AIs the evidence supports. Left out as of ${esc(EVIDENCE.date)}:</p>
    <ul>${RESERVES.map((p) => `<li><b>${esc(p.name)}</b>${p.company !== p.name ? ` (${esc(p.company)})` : ""} — ${esc(p.evidence)}</li>`).join('')}</ul>
    <p>They stay on the reserve bench and can be promoted back if a future review shows they've caught up.</p>
    <p class="muted">Sources: ${EVIDENCE.sources.map(([label, url]) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`).join(' · ')}</p>
  </div></details>`;
}

// ---- Your Elite Index ------------------------------------------------------------------

const CATEGORY_SKILL = { research: 'research', writing: 'writing', coding: 'coding', math: 'math', factcheck: 'factcheck', longdoc: 'longdoc', planning: 'planning', critique: 'critique', translation: 'translation' };

function indexBody() {
  const avail = available(settings);
  const { stats, total } = personalStats();
  const runs = loadRuns();
  const ranks = runs.length ? rankings(summarizeRuns(runs, settings)) : {};
  const cell = (pid, extra = '') => (pid ? `${chip(pid)}${extra ? `<small> ${extra}</small>` : ''}` : '<span class="muted">—</span>');
  return `<p class="lead-sm">Who does each job is decided by three layers of evidence. The first two anyone could copy. <b>The third is yours alone</b> — it grows every time an answer passes a check, you rate an answer, open a source, pick a winner, or take a blind check.</p>
  <div class="layers">
    <div><span>1</span><b>Public leaderboards</b><small>${esc(EVIDENCE.date)}</small></div>
    <div><span>2</span><b>Your Champion Audits</b><small>${runs.length} audit${runs.length === 1 ? '' : 's'}</small></div>
    <div><span>3</span><b>Your everyday results</b><small>${total} task${total === 1 ? '' : 's'} learned from</small></div>
  </div>
  <div class="table-wrap"><table class="matrix index"><thead><tr><th>Task type</th><th>1 · Public pick</th><th>2 · Your audit</th><th>3 · Your results</th><th>Blind checks: team vs one AI</th></tr></thead><tbody>${
    Object.entries(CATEGORIES).map(([cat, label]) => {
      const mine = rankedFor(cat, avail)[0];
      const audit = CATEGORY_SKILL[cat] ? ranks[CATEGORY_SKILL[cat]]?.[0] : null;
      const team = stats[cat]?.team;
      const votes = team ? team.better + team.same + team.worse : 0;
      return `<tr><td><b>${esc(label)}</b><small>${stats[cat]?.tasks || 0} tasks</small></td>
        <td>${cell(EVIDENCE.bestFor[cat])}</td>
        <td>${audit ? cell(audit.pid, audit.score.toFixed(1)) : cell(null)}</td>
        <td>${mine ? cell(mine.pid, `${Math.round(mine.score * 100)}% ±${Math.round(mine.spread * 100)} · ${Math.round(mine.n)} signals`) : `<span class="muted small">needs ${MIN_SIGNALS}+ signals</span>`}</td>
        <td>${votes ? `<span class="small">👍 ${team.better} · = ${team.same} · 👎 ${team.worse}</span>` : '<span class="muted">—</span>'}</td></tr>`;
    }).join('')}</tbody></table></div>
  <p class="muted small"><b>How scores work:</b> answers that pass an independent check count double and credit everyone who built them; your 👍/👎 and best-answer picks count once; opening a source credits the AI that found it; copying or sharing counts as engagement, not a vote. An AI needs ${MIN_SIGNALS}+ signals and a clear lead before the planner treats it as your favourite, and about 1 in 10 tasks gives another AI a tryout so a favourite can't lock in. If blind checks keep showing the team is no better than one AI for a task type, the planner keeps it to one AI and Elite AI suggests Direct mode to save time and money.</p>
  <p class="muted small">Private by design: this lives only on this device and stores no prompts or answers — just which AIs worked on what kind of task and how you rated them. Opt-in sharing to a community Elite Index is planned next; it is how Elite AI will get smarter for everyone.</p>
  <div class="row wrap"><button class="btn sm ghost" data-act="index-export">Export my data</button><button class="btn sm ghost" data-act="index-reset">Reset learning</button><button class="btn sm ghost" data-act="audit">Champion audit</button></div>`;
}

// ---- Champion Audit screens ---------------------------------------------------------------

const ROLE_NAMES = { plan: 'Planner', write: 'Final writer', verify: 'Verifier', challenge: 'Challenger', research: 'Researcher' };
const fmtScore = (x) => (x == null ? '—' : x.toFixed(1));
const heat = (x) => (x == null ? '' : `background:color-mix(in srgb, var(--gold) ${Math.round(Math.max(0, x) * 5.5)}%, var(--panel))`);

function auditBody() {
  const a = ui.audit;
  if (a.run && a.run.status === 'running') return auditRunning(a.run);
  const runs = loadRuns();
  if (a.view === 'results' && runs.length) return auditResults(runs);
  return auditSetup(runs);
}

function auditSetup(runs) {
  const avail = available(settings);
  const a = ui.audit;
  const est = avail.length > 1 ? estimateAudit(settings, avail, { full: a.full, teamCheck: a.team }) : null;
  const taskCount = TASKS.filter((t) => a.full || t.quick).length;
  return `<p class="lead-sm">Are we really giving each AI the job it does best? This audit gives every AI on your team the <b>same tasks</b> and measures who actually wins — on your own keys, with today's models.</p>
  <ul class="ticks">
    <li><b>Right-answer tasks are checked automatically</b> — math, code run against hidden tests, planted-error traps, questions about a long document.</li>
    <li><b>Open-ended tasks are graded blind</b> by the other AIs: answers are anonymous and shuffled, and no AI grades its own work.</li>
    <li><b>Speed and cost</b> are measured on every answer, and results add up across audits.</li>
    <li><b>Nothing changes until you approve</b> the recommendations.</li>
  </ul>
  <h4>What gets tested</h4>
  <div class="skill-list">${SKILLS.map((sk) => `<div><b>${esc(sk.label)}</b>${sk.role ? `<span class="tag">decides the ${ROLE_NAMES[sk.role]}</span>` : ''}<small>${esc(sk.what)}</small></div>`).join('')}</div>
  <h4>AIs in this audit</h4>
  <div class="credits">${avail.map((id) => chip(id, modelFor(id, settings).replace(P[id].orPrefix, ''))).join('') || '<span class="muted">None connected yet.</span>'}</div>
  ${avail.length < 2 ? '<p class="prov-msg bad">Connect at least two AIs to compare them.</p>' : ''}
  <div class="row wrap audit-opts">
    <label class="check-label"><input type="radio" name="audit-depth" data-act="audit-depth" value="quick"${a.full ? '' : ' checked'}> Quick — 1 task per skill</label>
    <label class="check-label"><input type="radio" name="audit-depth" data-act="audit-depth" value="full"${a.full ? ' checked' : ''}> Thorough — ${TASKS.length} tasks (more reliable)</label>
  </div>
  <label class="check-label"><input type="checkbox" data-act="audit-team"${a.team ? ' checked' : ''}> Also test the whole system: does the Elite Team beat the best single AI?</label>
  ${est ? `<p class="estimate">${taskCount} tasks · about ${est.calls} AI calls · roughly ${money(est.low)}–${money(est.high)} · about ${est.minutes}–${est.minutes * 2} min${est.unknown ? ' · some prices unknown' : ''}<br><small class="muted">Charged to your own AI accounts and counted toward today's spend (≈${money(spentToday())}${settings.dailyCap > 0 ? ` of $${settings.dailyCap}` : ''}). You can stop at any time.</small></p>` : ''}
  <div class="row wrap">
    <button class="btn gold" data-act="audit-run"${avail.length < 2 ? ' disabled' : ''}>Run the audit</button>
    ${runs.length ? `<button class="btn ghost" data-act="audit-view" data-view="results">See last results (${esc(new Date(runs[0].at).toLocaleDateString())})</button>` : ''}
  </div>`;
}

function auditRunning(run) {
  const pct = run.total ? Math.min(100, Math.round((run.done / run.total) * 100)) : 0;
  const icon = (ans) => (ans.status === 'working' ? '<span class="spin"></span>' : ans.status === 'error' ? '<span class="bad">!</span>' : ans.score != null ? fmtScore(ans.score) : ans.status === 'done' ? '✓' : '·');
  return `<div class="audit-progress"><div class="bar"><i style="width:${pct}%"></i></div>
    <div class="row wrap"><span>${run.done}/${run.total} calls · ${esc(run.phase || 'Working')} · ≈${money(run.cost)} so far</span><button class="btn sm ghost" data-act="audit-stop">Stop</button></div></div>
  <div class="table-wrap"><table class="matrix"><thead><tr><th>Task</th>${run.avail.map((id) => `<th>${badge(id, 'sm')}<span>${esc(P[id].name)}</span></th>`).join('')}</tr></thead>
  <tbody>${run.items.map((it) => `<tr><td><b>${esc(SKILL[it.skill].label)}</b><small>${esc(it.title)}</small></td>${run.avail.map((id) => `<td style="${heat(it.answers[id].score)}">${icon(it.answers[id])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
  ${run.team ? `<p class="muted small">Team vs. solo: ${run.team.tasks.length} task(s) in progress…</p>` : ''}
  <p class="muted small">You can close this window — the audit keeps running and results appear here when it's done.</p>`;
}

function auditResults(runs) {
  const avail = available(settings);
  const latest = runs[0];
  const agg = summarizeRuns(runs, settings);
  const ranks = rankings(agg);
  const cards = perAI(agg, avail.filter((id) => latest.avail.includes(id) || SKILLS.some((sk) => agg[sk.id]?.[id])));
  const rec = recommend(agg, settings, avail);
  const used = runs.filter((r) => r.items.some((it) => Object.entries(it.answers).some(([pid, x]) => x.score != null && modelFor(pid, settings) === r.models[pid]))).length;
  const cols = cards.map((c) => c.pid);
  const tv = latest.team;
  const applied = settings.useAudit;
  const teamLine = tv?.tasks?.length ? (() => {
    const done = tv.tasks.filter((t) => t.verdict);
    const w = done.filter((t) => t.verdict === 'team').length, l = done.filter((t) => t.verdict === 'solo').length;
    return `<div class="team-verdict ${w > l ? 'win' : l > w ? 'loss' : ''}"><b>${!done.length ? 'No verdict — the team or solo run failed.' : w > l ? `The Elite Team beat ${esc(P[tv.solo].name)} alone (${w}–${l})` : l > w ? `${esc(P[tv.solo].name)} alone beat the Elite Team (${l}–${w})` : `Tie between the Elite Team and ${esc(P[tv.solo].name)} alone`}</b>
      ${tv.tasks.map((t) => `<p class="small">“${esc(t.prompt.slice(0, 70))}…” — ${t.verdict ? `judges: ${t.votes.map((v) => `${esc(P[v.judge].name)} → ${v.winner}${v.why ? ` (${esc(v.why)})` : ''}`).join('; ')}` : esc(t.teamError || t.soloError || 'no result')}<br>
      <span class="muted">Team (${(t.teamAIs || []).map((id) => esc(P[id].name)).join(', ')}): ${secs(t.teamMs)}, ≈${money(t.teamCost)} · Solo: ${secs(t.soloMs)}, ≈${money(t.soloCost)}</span></p>`).join('')}
      <p class="muted small">${w > l ? 'Worth it: teamwork produced the better answer, at extra cost and time shown above.' : 'If the best single AI keeps winning, use Direct mode for everyday questions and save the team for big tasks.'}</p></div>`;
  })() : '';

  return `<p class="muted small">Latest audit ${esc(new Date(latest.at).toLocaleString())} · ${latest.avail.length} AIs · ${latest.items.length} tasks · ≈${money(latest.cost)}. Scores combine ${used} audit${used === 1 ? '' : 's'} (answers from models you no longer use are left out). Scale: 0–10.</p>
  <h3 class="audit-h">Who's best at what</h3>
  <div class="table-wrap"><table class="matrix results"><thead><tr><th>Skill</th>${cols.map((id) => `<th>${badge(id, 'sm')}<span>${esc(P[id].name)}</span></th>`).join('')}<th>Confidence</th></tr></thead>
  <tbody>${SKILLS.map((sk) => {
    const rows = ranks[sk.id];
    return `<tr><td><b>${esc(sk.label)}</b>${sk.role ? `<small>decides the ${ROLE_NAMES[sk.role]}</small>` : ''}</td>${cols.map((id) => {
      const r = rows.find((x) => x.pid === id);
      const star = r && isTop(rows, id);
      return `<td class="${star ? 'top' : ''}" style="${heat(r?.score)}">${r ? `${star ? '★ ' : ''}${fmtScore(r.score)}` : '—'}</td>`;
    }).join('')}<td><span class="conf ${rows.length > 1 ? confidence(rows) : 'low'}">${rows.length > 1 ? confidence(rows) : 'n/a'}</span></td></tr>`;
  }).join('')}</tbody></table></div>

  <h3 class="audit-h">Report cards</h3>
  <div class="report-grid">${cards.sort((x, y) => (y.overall ?? -1) - (x.overall ?? -1)).map((c) => `<div class="report" style="--c:${P[c.pid].color}">
    <div class="prov-head">${badge(c.pid)}<div class="prov-name"><b>${esc(P[c.pid].name)}</b><div class="champ">${esc(modelFor(c.pid, settings)?.replace(P[c.pid].orPrefix, '') || '')}</div></div><span class="big">${fmtScore(c.overall)}</span></div>
    <p class="small">${c.wins.length ? `★ Best at: ${esc(c.wins.join(', '))}` : '<span class="muted">No first places</span>'}</p>
    <p class="muted small">Avg ${c.ms ? secs(c.ms) : '—'} per answer · ≈${money(c.costPerTask)} per task</p>
    <p class="muted small">Everyday ratings: 👍 ${scores[c.pid]?.up || 0} · 👎 ${scores[c.pid]?.down || 0} · ★ ${scores[c.pid]?.best || 0}</p></div>`).join('')}</div>

  ${tv ? `<h3 class="audit-h">Is the team better than one AI?</h3>${teamLine}` : ''}

  <h3 class="audit-h">Recommended changes</h3>
  ${rec.changes.length ? `<ul class="changes">${rec.changes.map((c) => c.clear
      ? `<li>${chip(c.from)} → ${chip(c.to)} as <b>${ROLE_NAMES[c.role]}</b> <span class="muted small">(${esc(c.skill)}: ${fmtScore(c.fromScore)} → ${fmtScore(c.toScore)} · ${c.confidence} confidence)</span></li>`
      : `<li class="close">${chip(c.to)} edged out ${chip(c.from)} for <b>${ROLE_NAMES[c.role]}</b> <span class="muted small">(${esc(c.skill)}: ${fmtScore(c.toScore)} vs ${fmtScore(c.fromScore)}) — close call, so ${esc(P[c.from].name)} keeps the job until another audit confirms the gap</span></li>`).join('')}</ul>`
    : '<p class="small">✓ The current role assignments already match the measured winners.</p>'}
  <p class="muted small">Applying also tells the planner which AI measured best at each skill, so it can route specialist steps (code, math, documents, translation) by evidence. ${Object.values(rankings(agg)).some((rows) => rows.length > 1 && confidence(rows) === 'low') ? 'Some skills rest on only 1–2 tasks — run the audit again (or a thorough audit) before trusting close calls.' : ''}</p>
  <div class="row wrap">
    <button class="btn gold" data-act="audit-apply">${applied ? 'Re-apply latest results' : 'Apply audit results'}</button>
    ${applied ? '<button class="btn ghost" data-act="audit-revert">Go back to reputation defaults</button>' : ''}
    <button class="btn ghost" data-act="audit-view" data-view="setup">Run another audit</button>
  </div>
  ${applied ? `<p class="prov-msg ok">Audit results are in use (applied ${esc(new Date(settings.auditAt).toLocaleDateString())}).</p>` : ''}

  <h3 class="audit-h">Every answer and grade</h3>
  ${latest.items.map((it) => {
    const key = `au-${latest.id}-${it.task}`;
    return `<details class="sources" data-key="${key}"${ui.open.has(key) ? ' open' : ''}><summary>${esc(SKILL[it.skill].label)} — ${esc(it.title)}</summary><div class="audit-answers">${
      latest.avail.map((id) => {
        const x = it.answers[id];
        return `<div class="step ${x.status}"><div class="step-head">${chip(id)}<span class="st">${fmtScore(x.score)}</span></div>
          ${x.note ? `<div class="step-instr">Auto-check: ${esc(x.note)}</div>` : ''}
          ${(x.grades || []).map((g) => `<div class="step-instr">${esc(P[g.judge].name)} graded ${g.score}/10${g.why ? ` — ${esc(g.why)}` : ''}</div>`).join('')}
          ${x.error ? `<div class="err-line">${esc(x.error)}</div>` : ''}
          ${x.text ? `<details><summary>Show answer</summary><div class="md">${renderMarkdown(x.text)}</div></details>` : ''}</div>`;
      }).join('')}${(it.judgeErrors || []).map((e) => `<div class="err-line">Judge problem — ${esc(e)}</div>`).join('')}</div></details>`;
  }).join('')}`;
}

function refreshAuditSoon() {
  if (ui.audit.timer) return;
  ui.audit.timer = setTimeout(() => {
    ui.audit.timer = 0;
    if (ui.sheet?.body === auditBody) refreshSheet();
  }, 200);
}

async function startAudit() {
  const avail = available(settings);
  if (avail.length < 2 || ui.audit.controller) return;
  const ctrl = new AbortController();
  ui.audit.controller = ctrl;
  try {
    const run = await runAudit({
      settings, avail, full: ui.audit.full, teamCheck: ui.audit.team, signal: ctrl.signal,
      onUpdate: (r) => { ui.audit.run = r; refreshAuditSoon(); },
      spend: addSpend,
    });
    saveRun(run);
    ui.audit.view = 'results';
    toast('Champion Audit complete ✓', 3500);
  } catch (e) {
    if (e.name === 'AbortError') toast('Audit stopped — nothing was saved.');
    else toast('Audit failed: ' + e.message, 5000);
    ui.audit.view = loadRuns().length ? 'results' : 'setup';
  }
  ui.audit.run = null;
  ui.audit.controller = null;
  if (ui.sheet?.body === auditBody) refreshSheet();
  renderComposer();
}

function applyAudit() {
  const avail = available(settings);
  const rec = recommend(summarizeRuns(loadRuns(), settings), settings, avail);
  settings.routing = rec.routing;
  settings.measured = rec.measured;
  settings.useAudit = true;
  settings.auditAt = loadRuns()[0]?.at || Date.now();
  saveSettings();
  refreshSheet();
  renderComposer();
  toast('Applied — each role now goes to the measured winner.', 3500);
}

function openSecondOpinion(msgId) {
  const { msg } = findMsg(msgId);
  if (!msg) return;
  const author = msg.writer?.provider || msg.steps?.[msg.steps.length - 1]?.provider;
  const avail = available(settings).filter((id) => id !== author);
  const suggested = pick('verify', avail, settings);
  openSheet('Get a second opinion', `<p class="muted">Another AI checks this answer and flags anything it disagrees with.</p>
    <div class="pick-list">${avail.map((id) => `<button class="pick" data-act="run-second" data-mid="${msgId}" data-id="${id}">${badge(id)}<span><b>${esc(P[id].name)}${id === suggested ? ' <em class="gold">suggested</em>' : ''}</b><small>${esc(P[id].champion)}</small></span></button>`).join('')}</div>`);
}

function feedbackBody() {
  return `<p class="muted">Thanks for testing Elite AI! Tell us what worked, what broke, and what you wish it did. Then tap Share (or Copy) and send it back to whoever invited you.</p>
    <textarea class="fb" data-field="fb" rows="6" placeholder="What worked? What broke? What would make you use this every day?"></textarea>
    <div class="row wrap">${navigator.share ? '<button class="btn gold" data-act="fb-share">Share feedback</button>' : ''}<button class="btn ${navigator.share ? 'ghost' : 'gold'}" data-act="fb-copy">Copy feedback</button></div>
    <p class="muted small">Adds: app version, your device type, mode and which AIs are connected — never your keys or conversations.</p>`;
}

function feedbackText() {
  const note = $('[data-field="fb"]')?.value.trim() || '(no comments)';
  const avail = available(settings).map((id) => P[id].name + (connection(id, settings).via === 'openrouter' ? ' (OpenRouter)' : '')).join(', ') || 'none';
  return `Elite AI feedback\n\n${note}\n\n— Version ${VERSION} · ${isIOS ? 'iPhone/iPad' : /android/i.test(navigator.userAgent) ? 'Android' : 'Desktop'}${isStandalone ? ' (installed)' : ''} · Mode: ${MODES[settings.mode].label} · AIs: ${avail}`;
}

function welcome() {
  openSheet('Welcome to Elite AI', `<div class="welcome">
    <img src="icons/icon.svg" alt="" width="64" height="64">
    <p class="lead">One app where the world's best AIs work together — and each one gets credit for what it does best.</p>
    <ul class="ticks">
      <li><b>Elite Team</b> — a planner splits your task and sends each part to the right AI.</li>
      <li><b>Compare</b> and <b>Cross-check</b> — see answers side by side, or have AIs fact-check each other.</li>
      <li><b>Full transparency</b> — Team Replay shows who did what, how long it took and what it cost.</li>
      <li><b>Your accounts, your keys</b> — you pay each AI company directly; keys stay on this device.</li>
    </ul>
    <div class="row wrap center"><button class="btn gold" data-act="settings">Connect my AIs</button><button class="btn ghost" data-act="close-sheet">Look around first</button></div>
    <p class="muted small">Beta for friends &amp; family · Not affiliated with any AI company.</p>
  </div>`);
}

// ---- Keys & models -------------------------------------------------------------------

async function ensureModels(id, force = false) {
  const conn = connection(id, settings);
  if (!conn) return;
  const mk = modelKey(id, conn.via);
  if (ui.models[mk] && !force) return;
  try {
    const list = await listModels(id, settings);
    ui.models[mk] = list;
    if (!settings.models[mk] || force) {
      const best = autoPick(id, conn.via, list);
      if (best && !settings.models[mk]) { settings.models[mk] = best; saveSettings(); }
    }
    if (force) ui.keyMsg[id] = { ok: true, text: `${list.length} models available.` };
  } catch (e) {
    if (force || conn.via === 'direct') ui.keyMsg[id] = { ok: false, text: e.message };
  }
  refreshSheet();
}

async function saveKey(id) {
  const input = $(`[data-field="key-${id}"]`);
  const key = input?.value.trim().replace(/^Bearer\s+/i, '');
  if (!key) { toast('Paste a key first.'); return; }
  if (/\s/.test(key) || key.length < 12) { ui.keyMsg[id] = { ok: false, text: 'That doesn’t look like an API key.' }; refreshSheet(); return; }
  settings.keys[id] = key;
  // A new key means a new connection — let it pick a fresh default model.
  if (id !== 'openrouter') delete settings.models[modelKey(id, 'direct')];
  saveSettings();
  ui.keyMsg[id] = { ok: true, text: 'Saved — checking…' };
  refreshSheet();

  if (id === 'openrouter') {
    try {
      const r = await fetch(OPENROUTER.base + '/key', { headers: { Authorization: 'Bearer ' + key } });
      if (!r.ok) throw new Error(r.status === 401 ? 'OpenRouter rejected this key.' : 'OpenRouter error ' + r.status);
      const d = (await r.json()).data || {};
      ui.keyMsg.openrouter = { ok: true, text: `Connected ✓ — all five AIs are now reachable${d.limit != null ? ` · limit $${d.limit}` : ''}${d.usage != null ? ` · used $${Number(d.usage).toFixed(2)}` : ''}.` };
      for (const p of PROVIDERS) if (connection(p.id, settings)?.via === 'openrouter') ensureModels(p.id);
    } catch (e) {
      ui.keyMsg.openrouter = { ok: false, text: e.message };
    }
  } else if (P[id].staticModels) {
    ui.keyMsg[id] = { ok: true, text: 'Saved ✓ — it will be verified on first use.' };
  } else {
    const conn = connection(id, settings);
    try {
      const list = await listModels(id, settings);
      ui.models[modelKey(id, conn.via)] = list;
      const best = autoPick(id, conn.via, list);
      if (best) settings.models[modelKey(id, conn.via)] = best;
      saveSettings();
      ui.keyMsg[id] = { ok: true, text: `Connected ✓ — using ${best || modelFor(id, settings)}. ${list.length} models available.` };
    } catch (e) {
      ui.keyMsg[id] = { ok: false, text: e.message };
    }
  }
  refreshSheet();
  renderComposer();
  if (!thread()?.messages.length) renderFeed();
}

// ---- Events --------------------------------------------------------------------------

function autoGrow() {
  const el = $('#input');
  // Empty box: back to one line (Chrome measures the placeholder, which can wrap when narrow).
  if (!el.value) { el.style.height = ''; el.style.overflowY = 'hidden'; return; }
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  el.style.overflowY = el.scrollHeight > 200 ? 'auto' : 'hidden';
}

function newThread() {
  currentId = null;
  closeDrawer();
  renderAll();
  scrollToBottom();
  if (!isTouch) $('#input').focus();
}

const openDrawer = () => document.body.classList.add('drawer-open');
const closeDrawer = () => document.body.classList.remove('drawer-open');

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function copy(text, label = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(label); } catch { toast('Copy failed — select the text instead.'); }
}

function accepted(msg) {
  if (msg.accepted) return;
  msg.accepted = true;
  const author = msg.writer?.provider || (msg.steps || []).find((s) => s.status === 'done' && !s.replacedBy)?.provider;
  if (author) signal(msg.id, author, 'accept', 1);
  saveThreads();
}

function plainCredits(msg) {
  return credits(msg).map(([id, roles]) => `${P[id].name} (${roles.join(' + ')})`).join(', ');
}

const actions = {
  'close-sheet': (el, e) => { if (e.target === el || el.tagName === 'BUTTON') closeSheet(); },
  settings: () => { closeDrawer(); openSettings(); },
  team: () => openSheet('Meet the team', teamBody, { wide: true }),
  audit: () => {
    closeDrawer();
    if (!ui.audit.run) ui.audit.view = loadRuns().length ? 'results' : 'setup';
    openSheet('Champion audit', auditBody, { wide: true });
  },
  'audit-run': () => startAudit(),
  'audit-stop': () => ui.audit.controller?.abort(),
  'audit-view': (el) => { ui.audit.view = el.dataset.view; refreshSheet(); $('.sheet-body').scrollTop = 0; },
  'audit-apply': () => applyAudit(),
  'audit-revert': () => {
    settings.useAudit = false;
    saveSettings(); refreshSheet(); renderComposer();
    toast('Back to reputation-based roles. Your audit results are kept.');
  },
  feedback: () => { closeDrawer(); openSheet('Send feedback', feedbackBody); },
  example: (el) => { $('#input').value = el.textContent; autoGrow(); send(el.textContent); },
  'ios-tip-done': () => { store.write('iosTipDone', true); renderFeed(); },
  'toggle-ai': (el) => {
    const id = el.dataset.id;
    settings.off[id] = !settings.off[id];
    if (!available(settings).length) { settings.off[id] = false; toast('Keep at least one AI on the team.'); }
    saveSettings();
    renderComposer();
  },
  'pick-direct': (el) => { settings.directProvider = el.dataset.id; saveSettings(); renderComposer(); },
  'open-thread': (el) => { currentId = el.dataset.tid; closeDrawer(); renderAll(); scrollToBottom(); },
  'del-thread': (el) => {
    const i = threads.findIndex((t) => t.id === el.dataset.tid);
    if (i < 0) return;
    const [gone] = threads.splice(i, 1);
    if (currentId === gone.id) currentId = null;
    saveThreads();
    renderAll();
    undoToast('Conversation deleted', () => { threads.push(gone); saveThreads(); renderAll(); });
  },
  'new-thread': () => newThread(),
  copy: (el) => { const { msg } = findMsg(el.dataset.mid); if (msg) accepted(msg); if (msg) copy(msg.content + (credits(msg).length ? `\n\n— Elite AI · ${plainCredits(msg)}` : '')); },
  'copy-step': (el) => { const { msg } = findMsg(el.dataset.mid); const s = msg?.steps.find((x) => x.id === el.dataset.sid); if (s) copy(s.output); },
  share: async (el) => {
    const { msg } = findMsg(el.dataset.mid);
    if (!msg) return;
    accepted(msg);
    try { await navigator.share({ title: 'Elite AI answer', text: msg.content + `\n\n— Elite AI · ${plainCredits(msg)}` }); } catch { /* cancelled */ }
  },
  second: (el) => openSecondOpinion(el.dataset.mid),
  redo: (el) => followUp(el.dataset.mid, (ctx) => redoStep(ctx, el.dataset.sid, el.dataset.id)),
  'run-second': (el) => { closeSheet(); followUp(el.dataset.mid, (ctx) => secondOpinion(ctx, el.dataset.id)); },
  merge: (el) => followUp(el.dataset.mid, (ctx) => mergeCompare(ctx)),
  best: (el) => {
    const { msg } = findMsg(el.dataset.mid);
    if (!msg) return;
    const prev = msg.steps.find((s) => s.id === msg.best);
    if (prev) { scores[prev.provider] = { ...scores[prev.provider], best: Math.max(0, (scores[prev.provider]?.best || 0) - 1) }; signal(msg.id, prev.provider, 'best', -1); }
    const s = msg.steps.find((x) => x.id === el.dataset.sid);
    if (msg.best === s.id) msg.best = null;
    else { msg.best = s.id; scores[s.provider] = { ...scores[s.provider], best: (scores[s.provider]?.best || 0) + 1 }; signal(msg.id, s.provider, 'best', 1); }
    saveScores(); saveThreads(); scheduleMsg(msg);
  },
  'team-fb': (el) => {
    const { msg } = findMsg(el.dataset.mid);
    if (!msg) return;
    msg.feedback = msg.feedback === el.dataset.v ? null : el.dataset.v;
    teamFeedback(msg.id, el.dataset.v);
    saveThreads();
    scheduleMsg(msg);
  },
  'blind-vote': (el) => {
    const { msg } = findMsg(el.dataset.mid);
    if (!msg?.blind) return;
    msg.blind.verdict = el.dataset.v;
    blindResult(msg.id, el.dataset.v, msg.blind.provider);
    saveThreads();
    scheduleMsg(msg);
  },
  src: (el) => {
    const { msg } = findMsg(el.dataset.mid);
    if (!msg || !el.dataset.pid) return;
    msg.clicked ||= [];
    if (msg.clicked.includes(el.href)) return;
    msg.clicked.push(el.href);
    signal(msg.id, el.dataset.pid, 'source', 1);
    saveThreads();
  },
  netlog: () => openSheet('Network activity', netlogBody, { wide: true }),
  'local-load': () => loadPrivateModels('local'),
  'gw-load': () => loadPrivateModels('gw'),
  'all-five': () => {
    settings.allFive = !settings.allFive;
    saveSettings();
    renderComposer();
    toast(settings.allFive ? 'All five AIs will contribute on every task — slower and costs more.' : 'Back to evidence-based routing: only the AIs a task needs.', 3500);
  },
  'elite-index': () => { closeDrawer(); openSheet('Your Elite Index', indexBody, { wide: true }); },
  'index-export': () => download(`elite-ai-index-${today()}.json`, JSON.stringify(exportOutcomes(), null, 2)),
  'index-reset': (el) => {
    if (el.dataset.armed !== '1') { el.dataset.armed = '1'; el.textContent = 'Tap again to reset'; return; }
    resetOutcomes(); refreshSheet(); toast('Learning history reset.');
  },
  rate: (el) => {
    const { msg } = findMsg(el.dataset.mid);
    const s = msg && allCalls(msg).find((x) => x.id === el.dataset.sid);
    if (!s) return;
    const v = el.dataset.v;
    const sc = (scores[s.provider] ||= {});
    if (s.rating) { sc[s.rating] = Math.max(0, (sc[s.rating] || 0) - 1); signal(msg.id, s.provider, s.rating, -1); }
    s.rating = s.rating === v ? null : v;
    if (s.rating) { sc[s.rating] = (sc[s.rating] || 0) + 1; signal(msg.id, s.provider, s.rating, 1); }
    saveScores(); saveThreads(); scheduleMsg(msg);
  },
  'save-key': (el) => saveKey(el.dataset.id),
  'remove-key': (el) => {
    delete settings.keys[el.dataset.id];
    delete ui.keyMsg[el.dataset.id];
    saveSettings(); refreshSheet(); renderComposer(); renderFeed();
  },
  'load-models': (el) => ensureModels(el.dataset.id, true),
  install: async () => {
    if (!ui.installPrompt) return;
    ui.installPrompt.prompt();
    await ui.installPrompt.userChoice.catch(() => null);
    ui.installPrompt = null;
    renderComposer(); refreshSheet();
  },
  export: () => download(`elite-ai-conversations-${today()}.json`, JSON.stringify(threads, null, 2)),
  'clear-threads': (el) => {
    if (el.dataset.armed !== '1') { el.dataset.armed = '1'; el.textContent = 'Tap again to delete all'; return; }
    threads = []; currentId = null; saveThreads(); renderAll(); refreshSheet(); toast('All conversations deleted.');
  },
  'clear-keys': (el) => {
    if (el.dataset.armed !== '1') { el.dataset.armed = '1'; el.textContent = 'Tap again to remove all keys'; return; }
    settings.keys = {}; settings.models = {}; ui.keyMsg = {}; ui.models = {};
    saveSettings(); refreshSheet(); renderAll(); toast('All keys removed from this device.');
  },
  'fb-share': async () => { try { await navigator.share({ title: 'Elite AI feedback', text: feedbackText() }); } catch { /* cancelled */ } },
  'fb-copy': () => copy(feedbackText(), 'Feedback copied — paste it into a text or email.'),
};

function undoToast(text, undo) {
  const t = $('#toast');
  t.innerHTML = `${esc(text)} <button class="link" id="undo-btn">Undo</button>`;
  t.classList.add('show');
  $('#undo-btn').onclick = () => { undo(); t.classList.remove('show'); };
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 5000);
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = actions[el.dataset.act];
  if (!fn) return;
  if (el.tagName === 'A') { fn(el, e); return; }
  if (el.dataset.act !== 'close-sheet') e.preventDefault();
  fn(el, e);
});

document.addEventListener('change', (e) => {
  const el = e.target;
  const act = el.dataset.act;
  if (act === 'model') {
    const conn = connection(el.dataset.id, settings);
    settings.models[modelKey(el.dataset.id, conn.via)] = el.value;
    saveSettings();
  } else if (act === 'bench') {
    settings.off[el.dataset.id] = !el.checked;
    saveSettings(); renderComposer(); refreshSheet();
  } else if (act === 'role') {
    settings.roles[el.dataset.role] = el.value;
    saveSettings(); renderComposer();
  } else if (act === 'sealed') {
    settings.sealed = el.checked;
    saveSettings(); renderAll(); refreshSheet();
    toast(el.checked ? 'Sealed: the app can only reach your connected AIs.' : 'Sealed mode off.');
  } else if (act === 'local-on') {
    settings.local.on = el.checked;
    saveSettings(); renderAll(); refreshSheet();
    if (el.checked && !Object.values(settings.local.models).some(Boolean)) toast('Click "Find models" to fill the seats from your local AI.', 3500);
  } else if (act === 'gw-on') {
    settings.gateway.on = el.checked;
    saveSettings(); renderAll(); refreshSheet();
  } else if (act === 'local-url') {
    settings.local.url = el.value.trim(); saveSettings();
  } else if (act === 'gw-url') {
    settings.gateway.url = el.value.trim(); saveSettings();
  } else if (act === 'gw-key') {
    if (el.value.trim()) { settings.gateway.key = el.value.trim(); saveSettings(); }
  } else if (act === 'local-model' || act === 'gw-model') {
    const bag = act === 'local-model' ? settings.local.models : settings.gateway.models;
    if (el.value.trim()) bag[el.dataset.id] = el.value.trim(); else delete bag[el.dataset.id];
    saveSettings(); renderComposer();
  } else if (act === 'hrounds') {
    settings.huddleRounds = Number(el.value) || 3; saveSettings(); renderComposer();
  } else if (act === 'lchecks') {
    settings.learningChecks = el.value;
    saveSettings();
  } else if (act === 'osearch') {
    settings.openaiSearch = el.checked;
    saveSettings();
  } else if (act === 'gsearch') {
    settings.geminiSearch = el.checked;
    saveSettings();
  } else if (act === 'audit-depth') {
    ui.audit.full = el.value === 'full';
    refreshSheet();
  } else if (act === 'audit-team') {
    ui.audit.team = el.checked;
    refreshSheet();
  } else if (act === 'cap') {
    settings.dailyCap = Math.max(0, Number(el.value) || 0);
    saveSettings(); renderComposer();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (ui.sheet) closeSheet(); else closeDrawer(); }
  if (e.key === 'Enter' && e.target.matches('.prov input[type=password]')) {
    e.preventDefault();
    saveKey(e.target.dataset.field.replace('key-', ''));
  }
});

// Remember which collapsible sections are open across live re-renders.
document.addEventListener('toggle', (e) => {
  const key = e.target.dataset?.key;
  if (!key) return;
  if (e.target.open) ui.open.add(key); else ui.open.delete(key);
}, true);

function init() {
  document.querySelectorAll('.modes button').forEach((b) => b.addEventListener('click', () => {
    settings.mode = b.dataset.mode;
    saveSettings();
    renderModes();
    renderComposer();
    $('#mode-hint').textContent = MODES[settings.mode].hint;
  }));
  $('#mode-hint').textContent = MODES[settings.mode].hint;
  $('#btn-threads').addEventListener('click', () => (document.body.classList.contains('drawer-open') ? closeDrawer() : openDrawer()));
  $('#drawer-scrim').addEventListener('click', closeDrawer);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#install-btn').addEventListener('click', () => actions.install());

  const input = $('#input');
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !isTouch && !e.isComposing) {
      e.preventDefault();
      send(input.value);
    }
  });
  $('#composer-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (ui.controller) ui.controller.abort();
    else send(input.value);
  });

  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    ui.installPrompt = e;
    renderComposer();
    refreshSheet();
  });
  addEventListener('appinstalled', () => { ui.installPrompt = null; renderComposer(); toast('Elite AI installed ✓'); });

  renderAll();
  scrollToBottom();
  if (!isSealed()) loadPrices();
  // Pick a default model for any connection that doesn't have one yet (lists are free to fetch).
  for (const p of PROVIDERS) {
    const conn = connection(p.id, settings);
    if (conn && !conn.model && !settings.models[modelKey(p.id, conn.via)]) ensureModels(p.id);
  }

  if (!settings.welcomed) {
    settings.welcomed = true;
    saveSettings();
    welcome();
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
  }
}

init();
 + usd.toFixed(usd < 1 ? 3 : 2));
const secs = (ms) => (ms == null ? '' : (ms / 1000).toFixed(1) + 's');
const num = (n) => (n || 0).toLocaleString();
const isTouch = matchMedia('(pointer: coarse)').matches;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

const badge = (id, size = '') => `<span class="badge ${size}" style="--c:${P[id].color}" aria-hidden="true">${P[id].mark}</span>`;
const chip = (id, label = '') => `<span class="chip" style="--c:${P[id].color}">${badge(id, 'sm')}<b>${esc(P[id].name)}</b>${label ? `<span>${esc(label)}</span>` : ''}</span>`;
const domain = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

function toast(text, ms = 2600) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

// ---- Credits & totals (from the execution log only) -------------------------------------------

function allCalls(msg) {
  return [msg.planner, ...(msg.steps || []), msg.writer, ...(msg.checks || []), ...(msg.failed || []), msg.blind].filter(Boolean);
}

function credits(msg) {
  const map = new Map();
  for (const s of allCalls(msg)) {
    if (s.status !== 'done' || s.superseded || s.blindCheck) continue;
    if (!map.has(s.provider)) map.set(s.provider, []);
    const roles = map.get(s.provider);
    if (!roles.includes(s.role)) roles.push(s.role);
  }
  return [...map.entries()];
}

function totals(msg) {
  const calls = allCalls(msg).filter((s) => s.status === 'done' || s.status === 'error');
  let cost = 0, unknown = false, tokens = 0;
  for (const s of calls) {
    if (s.status !== 'done') continue;
    tokens += (s.usage?.in || 0) + (s.usage?.out || 0);
    if (s.cost == null) unknown = true; else cost += s.cost;
  }
  return { calls: calls.length, ais: new Set(calls.filter((s) => s.status === 'done').map((s) => s.provider)).size, tokens, cost, unknown };
}

// ---- Rendering: messages ---------------------------------------------------------------------

function renderUser(msg) {
  return `<article class="msg user" data-mid="${msg.id}"><div class="bubble">${esc(msg.content).replace(/\n/g, '<br>')}</div></article>`;
}

const STATUS_ICON = { waiting: '○', working: '<span class="spin" aria-label="working"></span>', done: '✓', error: '!', stopped: '■' };

function stepMeta(s) {
  const bits = [];
  if (s.model) bits.push(esc(s.model.replace(/^[\w-]+\//, '')) + (s.via === 'openrouter' ? ' · via OpenRouter' : ''));
  if (s.ms) bits.push(secs(s.ms));
  if (s.usage) bits.push(num(s.usage.in + s.usage.out) + ' tokens');
  if (s.status === 'done') bits.push(s.cost == null ? 'cost n/a' : '≈' + money(s.cost));
  return bits.join(' · ');
}

function renderStepRow(msg, s, { showOutput = true, rate = true } = {}) {
  const key = `o-${msg.id}-${s.id}`;
  const live = s.status === 'working' && s.output;
  return `<div class="step ${s.status}">
    <div class="step-head">${chip(s.provider, s.role)}<span class="st">${STATUS_ICON[s.status] || ''}</span></div>
    <div class="step-meta">${stepMeta(s)}</div>
    ${s.instruction ? `<div class="step-instr"><b>Assignment:</b> ${esc(s.instruction)}</div>` : ''}
    ${s.note ? `<div class="step-instr">${esc(s.note)}</div>` : ''}
    ${s.error ? `<div class="err-line">${esc(s.error)}</div>` : ''}
    ${s.replacedBy ? '<div class="step-instr">↳ Redone by another AI below.</div>' : ''}
    ${s.superseded ? '<div class="step-instr">Superseded after a step was redone.</div>' : ''}
    ${live ? `<div class="live">${esc(s.output.slice(-220))}</div>` : ''}
    ${showOutput && s.status === 'done' && s.output ? `<details data-key="${key}"${ui.open.has(key) ? ' open' : ''}><summary>Show ${esc(P[s.provider].name)}’s contribution</summary><div class="md">${renderMarkdown(s.output)}</div></details>` : ''}
    ${rate && s.status === 'done' && msg.status !== 'running' ? `<div class="rate" role="group" aria-label="Rate this contribution">
      <button class="mini${s.rating === 'up' ? ' on' : ''}" data-act="rate" data-mid="${msg.id}" data-sid="${s.id}" data-v="up" aria-label="Helpful">👍</button>
      <button class="mini${s.rating === 'down' ? ' on' : ''}" data-act="rate" data-mid="${msg.id}" data-sid="${s.id}" data-v="down" aria-label="Not helpful">👎</button></div>` : ''}
  </div>`;
}

function renderPlannerRow(msg) {
  const s = msg.planner;
  if (!s) return '';
  let planText = '';
  if (s.status === 'done') {
    planText = msg.reason ? `<div class="step-instr"><b>Plan:</b> ${esc(msg.reason)}</div>` : '';
    if (msg.steps?.length) {
      planText += `<ol class="plan-list">${msg.steps.map((x) => `<li>${chip(x.provider, x.role)}${x.depends_on?.length ? '<small> builds on earlier work</small>' : ''}</li>`).join('')}</ol>`;
    }
  }
  return `<div class="step ${s.status}">
    <div class="step-head">${chip(s.provider, 'Planner')}<span class="st">${STATUS_ICON[s.status] || ''}</span></div>
    <div class="step-meta">${stepMeta(s)}</div>${planText}
    ${s.note ? `<div class="step-instr">${esc(s.note)}</div>` : ''}
    ${s.error ? `<div class="err-line">${esc(s.error)} — used the default team instead.</div>` : ''}
  </div>`;
}

function renderLiveTeam(msg) {
  // Watch the team work while a run is in progress: who is doing what, streaming live.
  const rows = [
    msg.planner ? renderPlannerRow(msg) : '',
    ...(msg.steps || []).map((s) => renderStepRow(msg, s, { showOutput: false, rate: false })),
    msg.writer ? renderStepRow(msg, msg.writer, { showOutput: false, rate: false }) : '',
  ].join('');
  return rows.trim() ? `<div class="live-team">${rows}</div>` : '';
}

function renderCompare(msg) {
  const done = msg.steps.filter((s) => s.status === 'done').length;
  return `<div class="compare">${msg.steps.map((s) => `<section class="card ${s.status}${msg.best === s.id ? ' best' : ''}">
      <header>${chip(s.provider)}<span class="st">${STATUS_ICON[s.status] || ''}</span></header>
      <div class="card-meta">${stepMeta(s)}</div>
      ${s.error ? `<div class="err-line">${esc(s.error)}</div>` : `<div class="md">${renderMarkdown(s.output || '')}${s.status === 'working' ? '<span class="caret"></span>' : ''}</div>`}
      ${s.status === 'done' && msg.status !== 'running' ? `<footer>
        <button class="btn sm ${msg.best === s.id ? 'gold' : 'ghost'}" data-act="best" data-mid="${msg.id}" data-sid="${s.id}">${msg.best === s.id ? '★ Your pick' : '☆ Best answer'}</button>
        <button class="btn sm ghost" data-act="copy-step" data-mid="${msg.id}" data-sid="${s.id}">Copy</button></footer>` : ''}
    </section>`).join('')}</div>
    ${done >= 2 && msg.status !== 'running' && !msg.content ? `<div class="merge-row"><button class="btn gold" data-act="merge" data-mid="${msg.id}">✦ Merge into one Elite answer</button></div>` : ''}`;
}

// Failures are never silent: show every substitution, and offer a qualified stand-in for each
// failed step (the user decides — Elite AI never swaps an AI on its own except the final writer).
function renderRecovery(msg) {
  const seen = new Set();
  const notes = (msg.substitutions || []).filter((x) => {
    const k = `${x.role}|${x.from}|${x.to}|${x.byUser}`;
    return !seen.has(k) && seen.add(k);
  }).map((x) => `<div class="sub-note">⚠ ${x.from === x.to
    ? `Retried ${esc(P[x.to].name)}'s ${esc(x.role)} step`
    : x.byUser ? `You asked ${esc(P[x.to].name)} to redo ${esc(P[x.from].name)}'s ${esc(x.role)} step`
      : `${esc(P[x.from].name)} couldn't finish as ${esc(x.role)}, so ${esc(P[x.to].name)} stepped in`}${x.reason ? ` — ${esc(x.reason)}` : ''}</div>`).join('');
  if (msg.status === 'running') return notes;
  const failed = (msg.steps || []).filter((s) => s.status === 'error' && !s.replacedBy);
  const offers = failed.map((s) => {
    const alt = msg.mode === 'compare' ? s.provider : suggestReplacement(s, settings);
    return alt ? `<button class="btn sm" data-act="redo" data-mid="${msg.id}" data-sid="${s.id}" data-id="${alt}">${alt === s.provider ? `Retry ${esc(P[alt].name)}` : `Redo ${esc(P[s.provider].name)}'s ${esc(s.role)} step with ${esc(P[alt].name)}`}</button>` : '';
  }).join('');
  return notes + (offers && msg.mode !== 'crosscheck' && msg.mode !== 'direct' ? `<div class="recovery"><span class="muted small">${failed.length} step${failed.length > 1 ? 's' : ''} failed. Finished work is kept.</span>${offers}</div>` : '');
}

// The huddle room: every message one AI sent to the others, inside the app.
function renderHuddle(msg) {
  const h = msg.huddle;
  if (!h) return '';
  const key = `room-${msg.id}`;
  const running = msg.status === 'running';
  const rounds = [...new Set((msg.steps || []).map((x) => x.round))];
  const body = rounds.map((r) => `<div class="round-sep">${r === 0 ? 'Opening thoughts' : `Round ${r + 1}`}</div>` +
    msg.steps.filter((x) => x.round === r).map((x) => `<div class="rmsg ${x.status}" style="--c:${P[x.provider].color}">
      <div class="rmsg-head">${badge(x.provider, 'sm')}<b>${esc(P[x.provider].name)}</b>${x.to?.length ? `<span class="to">→ ${x.to.map((id) => esc(P[id].name)).join(', ')}</span>` : ''}${x.stance ? `<span class="stance ${x.stance}">${x.stance === 'agree' ? '✓ agrees' : '✋ objects'}</span>` : ''}<span class="st">${x.status === 'working' ? STATUS_ICON.working : x.status === 'error' ? '!' : ''}</span></div>
      ${x.error ? `<div class="err-line">${esc(x.error)}</div>` : `<div class="md">${renderMarkdown(stripStance(x.output || ''))}</div>`}
      ${x.stance === 'object' && x.reason ? `<div class="step-instr">Would change: ${esc(x.reason)}</div>` : ''}
    </div>`).join('')).join('');
  const spoke = (msg.steps || []).filter((x) => x.status === 'done').length;
  const summary = running ? `In progress · ${h.members.length} AIs talking`
    : `${h.consensus ? '✓ The team agreed' : h.objections?.length ? `${h.objections.length} still objecting — noted in the answer` : 'Rounds complete'} · ${spoke} messages`;
  return `<details class="room" data-key="${key}"${running || ui.open.has(key) ? ' open' : ''}><summary><span>🔒 Huddle room</span><small>${esc(summary)}</small></summary>
    <div class="room-note">The AIs are talking to each other inside Elite AI. Nobody in the room can search the web or reach any outside site.</div>${body}</details>`;
}

function renderChecks(msg) {
  return (msg.checks || []).map((c) => `<div class="check ${c.status}">
    <div class="step-head">${chip(c.provider, c.role)}<span class="st">${STATUS_ICON[c.status] || ''}</span></div>
    ${c.error ? `<div class="err-line">${esc(c.error)}</div>` : `<div class="md">${renderMarkdown(c.output || '')}</div>`}
  </div>`).join('');
}

function renderSources(msg) {
  if (!msg.sources?.length) return '';
  const key = `src-${msg.id}`;
  return `<details class="sources" data-key="${key}"${ui.open.has(key) ? ' open' : ''}><summary>Sources (${msg.sources.length})</summary><ol>${
    msg.sources.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" data-act="src" data-mid="${msg.id}" data-pid="${s.provider}">${esc(s.title && s.title !== domain(s.url) ? s.title : domain(s.url))}</a> <small>${esc(domain(s.url))} · via ${esc(P[s.provider].name)}</small></li>`).join('')
  }</ol></details>`;
}

function renderReplay(msg) {
  const t = totals(msg);
  if (!t.calls || msg.mode === 'direct' || msg.status === 'running') return '';
  const key = `r-${msg.id}`;
  const rows = [
    msg.planner ? renderPlannerRow(msg) : '',
    msg.mode === 'compare' || msg.mode === 'huddle' ? '' : (msg.steps || []).map((s) => renderStepRow(msg, s)).join(''),
    msg.writer ? renderStepRow(msg, msg.writer, { showOutput: false }) : '',
    (msg.failed || []).length ? `<div class="earlier">Earlier attempts</div>${msg.failed.map((x) => renderStepRow(msg, x, { showOutput: false, rate: false })).join('')}` : '',
  ].join('');
  if (!rows.trim()) return '';
  return `<details class="replay" data-key="${key}"${ui.open.has(key) ? ' open' : ''}>
    <summary><span>Team replay</span><small>${t.ais} AI${t.ais === 1 ? '' : 's'} · ${t.calls} call${t.calls === 1 ? '' : 's'}${msg.ms ? ' · ' + secs(msg.ms) : ''} · ≈${money(t.cost)}${t.unknown ? '+' : ''}</small></summary>
    <div class="replay-body">${rows}</div></details>`;
}

function renderAssistant(msg) {
  const running = msg.status === 'running';
  const team = credits(msg);
  const t = totals(msg);
  const answerStreaming = running && msg.content;
  return `<article class="msg ai ${msg.status}" data-mid="${msg.id}">
    ${msg.tryout && credits(msg).some(([id]) => id === msg.tryout) ? `<div class="muted small">🔬 Tryout: ${esc(P[msg.tryout].name)} got a turn on this task so the rankings stay honest.</div>` : ''}
    <div class="credits"><span class="mode-tag">${esc(MODES[msg.mode]?.label || '')}</span>${team.map(([id, roles]) => chip(id, roles.join(' + '))).join('')}</div>
    ${running ? `<div class="progress"><span class="spin"></span>${esc(msg.phase || 'Working')}…</div>${(msg.mode === 'team' || msg.mode === 'crosscheck') && !msg.content ? renderLiveTeam(msg) : ''}` : ''}
    ${msg.mode === 'compare' && msg.steps?.length ? renderCompare(msg) : ''}
    ${msg.mode === 'huddle' ? renderHuddle(msg) : ''}
    ${msg.content ? `<div class="answer md">${msg.mode === 'compare' ? '<div class="answer-label">✦ Elite answer</div>' : ''}${renderMarkdown(msg.content)}${answerStreaming ? '<span class="caret"></span>' : ''}</div>` : ''}
    ${msg.error ? `<div class="error-box">${esc(msg.error)}${/key|connect|Settings/i.test(msg.error) ? ' <button class="btn sm" data-act="settings">Open Settings</button>' : ''}</div>` : ''}
    ${msg.status === 'stopped' ? '<div class="muted small">Stopped.</div>' : ''}
    ${renderRecovery(msg)}
    ${renderChecks(msg)}
    ${renderSources(msg)}
    ${renderReplay(msg)}
    ${!running && (msg.content || msg.steps?.some((s) => s.status === 'done')) ? `<div class="actions">
      ${msg.content ? `<button class="btn sm ghost" data-act="copy" data-mid="${msg.id}">Copy</button>` : ''}
      ${msg.content && navigator.share ? `<button class="btn sm ghost" data-act="share" data-mid="${msg.id}">Share</button>` : ''}
      ${msg.content && available(settings).length > 1 ? `<button class="btn sm ghost" data-act="second" data-mid="${msg.id}">Get a second opinion</button>` : ''}
      ${msg.mode === 'direct' && t.calls ? `<span class="muted small">${esc(stepMeta(msg.steps[0]))}</span>` : ''}
    </div>` : ''}
    ${renderBlind(msg)}
  </article>`;
}

const names = () => Object.fromEntries(PROVIDERS.map((p) => [p.id, p.name]));

// Blind check (learning loop): the team's answer next to one AI's answer, unlabeled, so the user
// judges two answers they can actually see. ChatGPT asked "was the team better than one AI?";
// Gemini pointed out nobody can judge an answer they never saw — this does both.
function renderBlind(msg) {
  const b = msg.blind;
  if (!b || msg.status !== 'done' || !msg.content) return '';
  const teamFirst = b.order === 'team-first';
  const [A, B] = teamFirst ? [msg.content, b.output] : [b.output, msg.content];
  const winner = b.verdict;
  const label = (x) => (x === 'team' ? 'the Elite Team' : x === 'solo' ? `${P[b.provider].name} alone` : '');
  const reveal = winner ? `<p class="small">${winner === 'same' ? 'You called it even.' : `You picked ${label(winner)}.`} Answer A was ${label(teamFirst ? 'team' : 'solo')}; Answer B was ${label(teamFirst ? 'solo' : 'team')}. Thanks — your team learns from this.</p>` : '';
  const tip = winner && winner !== 'team' ? suggestion(msg.category, available(settings), names()) : null;
  const keyA = `bl-a-${msg.id}`, keyB = `bl-b-${msg.id}`;
  return `<div class="blind">
    <div class="blind-head"><b>🔬 Blind check</b><span class="muted small">Same request, two answers, no names. Which helps you more?</span></div>
    <details data-key="${keyA}"${ui.open.has(keyA) ? ' open' : ''}><summary>Answer A</summary><div class="md">${renderMarkdown(A)}</div></details>
    <details data-key="${keyB}"${ui.open.has(keyB) ? ' open' : ''}><summary>Answer B</summary><div class="md">${renderMarkdown(B)}</div></details>
    <div class="fb-row">${[['A', 'A is better'], ['same', 'About the same'], ['B', 'B is better']].map(([v, t]) => {
      const meaning = v === 'same' ? 'same' : (v === 'A') === teamFirst ? 'team' : 'solo';
      return `<button class="mini${winner === meaning ? ' on' : ''}" data-act="blind-vote" data-mid="${msg.id}" data-v="${meaning}">${t}</button>`;
    }).join('')}</div>${reveal}</div>
    ${tip ? `<div class="tip-line">💡 ${esc(tip)}</div>` : ''}`;
}

// Run a blind check on about 1 in 8 team answers (Settings can switch this off).
async function maybeBlind(ctx) {
  const { msg } = ctx;
  const mode = settings.learningChecks === false ? 'off' : settings.learningChecks === true ? 'some' : settings.learningChecks || 'some';
  if (mode === 'off' || !msg.content || credits(msg).length < 2) return;
  if (mode !== 'all' && Math.random() >= BLIND_RATE) return;
  const avail = available(settings);
  const solo = personalChampion(msg.category, avail)?.pid || msg.writer?.provider || pick('write', avail, settings);
  if (solo) await blindSolo(ctx, solo);
}

const renderMsg = (msg) => (msg.role === 'user' ? renderUser(msg) : renderAssistant(msg));

// ---- Rendering: empty state, sidebar, composer -------------------------------------------------

function renderEmpty() {
  const avail = available(settings);
  const iosTip = isIOS && !isStandalone && !store.read('iosTipDone', false);
  return `<section class="empty">
    <img class="hero-mark" src="icons/icon.svg" alt="" width="72" height="72">
    <h1>Every great AI.<br><span class="gold">Working together.</span></h1>
    <p class="lead">Elite AI puts the Elite 5 — ChatGPT, Claude, Gemini, Grok and DeepSeek — on one team, each championed for what it does best, with every contribution credited.</p>
    ${iosTip ? `<div class="tip">📲 <b>Install on iPhone:</b> tap the Share button, then <b>Add to Home Screen</b>. <button class="link" data-act="ios-tip-done">Got it</button></div>` : ''}
    ${!avail.length ? `<div class="cta-card"><div><b>Connect your AIs to start</b><p>You use your own AI accounts and pay each company directly. One OpenRouter key unlocks all five, or add each company's key.</p></div><button class="btn gold" data-act="settings">Connect my AIs</button></div>` : ''}
    <div class="how">
      <div><span>1</span><b>Plan</b><p>A lead AI breaks your task into steps.</p></div>
      <div><span>2</span><b>Champions work</b><p>Each step goes to the AI that does it best — in parallel.</p></div>
      <div><span>3</span><b>One answer, full credits</b><p>A final writer merges the work. Replay exactly who did what.</p></div>
    </div>
    <h2 class="section-title">The team <button class="link" data-act="team">See details</button></h2>
    <div class="roster">${PROVIDERS.map((p) => {
      const conn = connection(p.id, settings);
      return `<button class="roster-item${conn ? '' : ' off'}" data-act="${conn ? 'team' : 'settings'}">${badge(p.id)}<span><b>${esc(p.name)}</b><small>${esc(p.champion)}</small></span><i>${conn ? (settings.off[p.id] ? 'Benched' : '●') : '+'}</i></button>`;
    }).join('')}</div>
    ${avail.length ? `<h2 class="section-title">Try one</h2><div class="examples">${EXAMPLES.map((e) => `<button class="example" data-act="example">${esc(e)}</button>`).join('')}</div>` : ''}
  </section>`;
}

function renderFeed() {
  const feed = $('#feed');
  const t = thread();
  feed.innerHTML = !t || !t.messages.length ? renderEmpty() : `<div class="thread">${t.messages.map(renderMsg).join('')}</div>`;
}

function renderSidebar() {
  $('#thread-list').innerHTML = threads.length
    ? threads.map((t) => `<div class="thread-item${t.id === currentId ? ' active' : ''}">
        <button class="thread-open" data-act="open-thread" data-tid="${t.id}"><b>${esc(t.title)}</b><small>${new Date(t.updated).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${esc(MODES[t.messages[0]?.mode]?.label || '')}</small></button>
        <button class="icon-btn sm" data-act="del-thread" data-tid="${t.id}" aria-label="Delete conversation">×</button></div>`).join('')
    : '<p class="muted small pad">Your conversations will appear here. They are saved only on this device.</p>';
}

function renderModes() {
  document.querySelectorAll('.modes button').forEach((b) => {
    const on = b.dataset.mode === settings.mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on);
  });
}

function directProvider() {
  const avail = available(settings);
  if (avail.includes(settings.directProvider)) return settings.directProvider;
  return avail[0] || null;
}

function renderComposer() {
  const avail = available(settings);
  const mode = settings.mode;
  const direct = mode === 'direct';
  const chosen = direct ? directProvider() : null;
  $('#team-row').innerHTML = PROVIDERS.map((p) => {
    const conn = connection(p.id, settings);
    if (!conn) return `<button class="pill ghost" data-act="settings" title="Connect ${esc(p.name)}">${badge(p.id, 'sm')}${esc(p.name)} <i>+</i></button>`;
    const on = direct ? p.id === chosen : !settings.off[p.id];
    return `<button class="pill${on ? ' on' : ''}" style="--c:${p.color}" data-act="${direct ? 'pick-direct' : 'toggle-ai'}" data-id="${p.id}" aria-pressed="${on}" title="${esc(p.champion)}">${badge(p.id, 'sm')}${esc(p.name)}</button>`;
  }).join('') + (mode === 'team' && avail.length > 2
    ? `<button class="pill all5${settings.allFive ? ' on' : ''}" data-act="all-five" aria-pressed="${!!settings.allFive}" title="Every AI contributes on every task — slower and costs more">✦ All ${avail.length}</button>`
    : '');

  let who = '';
  if (avail.length) {
    if (mode === 'team') {
      const planner = avail.length > 1 ? pick('plan', avail, settings) : null;
      const writer = pick('write', avail, settings);
      who = settings.allFive && avail.length > 2 ? `All ${avail.length} AIs contribute on every task (slower, costs more)` : !planner ? `${P[avail[0]].name} answers` : planner === writer ? `${P[planner].name} plans and writes the final answer · specialists in between` : `${P[planner].name} plans · ${P[writer].name} writes the final answer`;
    } else if (mode === 'huddle') {
      who = avail.length < 2 ? 'Connect a second AI to huddle' : `${avail.length} AIs huddle inside the app · up to ${settings.huddleRounds || 3} rounds · ${P[pick('write', avail, settings)].name} writes the answer`;
    } else if (mode === 'compare') who = `${avail.length} AI${avail.length > 1 ? 's' : ''} answer side by side`;
    else if (mode === 'crosscheck') {
      const d = pick('write', avail, settings);
      who = `${P[d].name} drafts · ${avail.length > 1 ? 'others review' : 'connect another AI to review'}`;
    } else who = chosen ? `Chatting with ${P[chosen].name}` : '';
  }
  const spent = spentToday();
  $('#composer-meta').innerHTML = avail.length
    ? `${isSealed() ? '<span class="sealed-tag" title="Only your connected AIs are reachable">🔒 Sealed</span><span class="dot-sep">•</span>' : ''}<span>${esc(who)}</span><span class="dot-sep">•</span><span>Today ≈${money(spent)}${settings.dailyCap > 0 ? ` of $${settings.dailyCap} cap` : ''}</span>`
    : `<button class="link" data-act="settings">Connect your AIs to start →</button>`;
  $('#input').placeholder = direct && chosen ? `Message ${P[chosen].name}…` : mode === 'compare' ? 'Ask every AI at once…' : mode === 'huddle' ? 'Give the team something to talk through…' : 'Give the team a task…';
  const running = !!ui.controller;
  const send = $('#btn-send');
  send.classList.toggle('stop', running);
  send.setAttribute('aria-label', running ? 'Stop' : 'Send');
  send.innerHTML = running ? '<svg viewBox="0 0 24 24" width="18" height="18"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  $('#install-btn').hidden = !ui.installPrompt;
}

function renderAll() {
  renderModes();
  renderSidebar();
  renderFeed();
  renderComposer();
}

// Live updates during a run: patch changed messages ~20x a second. A timer (not
// requestAnimationFrame) so updates still land if the app was in the background.
const pending = new Set();
let frame = 0;
function scheduleMsg(msg) {
  pending.add(msg);
  frame ||= setTimeout(() => {
    frame = 0;
    const feed = $('#feed');
    const stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 140;
    for (const m of pending) {
      const el = feed.querySelector(`[data-mid="${m.id}"]`);
      if (el) el.outerHTML = renderMsg(m);
    }
    pending.clear();
    if (stick) feed.scrollTop = feed.scrollHeight;
  }, 50);
}

function scrollToBottom() {
  const feed = $('#feed');
  setTimeout(() => { feed.scrollTop = thread()?.messages.length ? feed.scrollHeight : 0; }, 0);
}

// ---- Running a task -------------------------------------------------------------------------

function makeCtx(msg, task, history, extra = {}) {
  return {
    msg, task, history, settings,
    signal: ui.controller.signal,
    update: () => scheduleMsg(msg),
    spend: (usd) => addSpend(usd),
    ...extra,
  };
}

async function guarded(msg, fn) {
  ui.runningMsg = msg;
  msg.status = 'running';
  const t0 = performance.now();
  renderComposer();
  scheduleMsg(msg);
  try {
    await fn();
    msg.status = 'done';
  } catch (e) {
    if (e.name === 'AbortError') msg.status = 'stopped';
    else { msg.status = 'error'; msg.error = e.message; }
  }
  msg.ms = (msg.ms || 0) + Math.round(performance.now() - t0);
  msg.phase = '';
  if (msg.status === 'done') recordOutcome(msg);
  ui.controller = null;
  ui.runningMsg = null;
  const t = thread();
  if (t) t.updated = Date.now();
  saveThreads();
  scheduleMsg(msg);
  renderComposer();
  renderSidebar();
}

function overBudget() {
  if (settings.dailyCap > 0 && spentToday() >= settings.dailyCap) {
    toast(`Daily budget of $${settings.dailyCap} reached. Raise it in Settings → Budget.`, 4000);
    return true;
  }
  return false;
}

async function send(text) {
  text = text.trim();
  if (!text || ui.controller) return;
  const avail = available(settings);
  if (!avail.length) { openSettings(); toast('Connect at least one AI first.'); return; }
  if (overBudget()) return;

  let t = thread();
  if (!t) {
    t = { id: uid(), title: text.slice(0, 60), created: Date.now(), updated: Date.now(), messages: [] };
    threads.unshift(t);
    currentId = t.id;
  }
  const history = t.messages.map((m) => ({ role: m.role, content: m.content }));
  const mode = settings.mode;
  const user = { id: uid(), role: 'user', content: text, mode, ts: Date.now() };
  const msg = { id: uid(), role: 'assistant', mode, content: '', steps: [], status: 'running', ts: Date.now() };
  t.messages.push(user, msg);
  t.updated = Date.now();
  $('#input').value = '';
  autoGrow();
  renderFeed();
  renderSidebar();
  scrollToBottom();

  ui.controller = new AbortController();
  const ctx = makeCtx(msg, text, history, { avail });
  await guarded(msg, () => {
    if (mode === 'huddle') return runHuddle(ctx);
    if (mode === 'compare') return runCompare(ctx);
    if (mode === 'crosscheck') return runCrossCheck(ctx);
    if (mode === 'direct') return runDirect({ ...ctx, provider: directProvider() });
    return runTeam(ctx).then(() => maybeBlind(ctx));
  });
}

function findMsg(id) {
  const t = thread();
  const i = t?.messages.findIndex((m) => m.id === id) ?? -1;
  return i < 0 ? {} : { t, msg: t.messages[i], index: i };
}

async function followUp(msgId, fn) {
  if (ui.controller) return;
  if (overBudget()) return;
  const { t, msg, index } = findMsg(msgId);
  if (!msg) return;
  const task = t.messages[index - 1]?.content || '';
  const history = t.messages.slice(0, index - 1).map((m) => ({ role: m.role, content: m.content }));
  msg.error = '';
  ui.controller = new AbortController();
  await guarded(msg, () => fn(makeCtx(msg, task, history)));
}

// ---- Sheets (settings, team, second opinion, feedback, welcome) ----------------------------------

function openSheet(title, body, { wide = false, onRender } = {}) {
  ui.sheet = { title, body, wide, onRender };
  $('#sheet-root').innerHTML = `<div class="sheet-backdrop" data-act="close-sheet"><div class="sheet${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <header><h2>${esc(title)}</h2><button class="icon-btn" data-act="close-sheet" aria-label="Close">×</button></header>
    <div class="sheet-body">${typeof body === 'function' ? body() : body}</div></div></div>`;
  document.body.classList.add('sheet-open');
  onRender?.();
}

function refreshSheet() {
  if (!ui.sheet || typeof ui.sheet.body !== 'function') return;
  const bodyEl = $('.sheet-body');
  if (!bodyEl) return;
  const active = document.activeElement;
  const keep = active && bodyEl.contains(active) && active.dataset.field ? active.dataset.field : null;
  // Background updates (model lists, key checks) must never wipe what someone is typing.
  const typed = {};
  bodyEl.querySelectorAll('input[data-field], textarea[data-field]').forEach((f) => { if (f.value && f.type !== 'number') typed[f.dataset.field] = f.value; });
  const top = bodyEl.scrollTop;
  bodyEl.innerHTML = ui.sheet.body();
  for (const [field, value] of Object.entries(typed)) {
    const f = bodyEl.querySelector(`[data-field="${field}"]`);
    if (f) f.value = value;
  }
  bodyEl.scrollTop = top;
  if (keep) bodyEl.querySelector(`[data-field="${keep}"]`)?.focus();
}

function closeSheet() {
  ui.sheet = null;
  $('#sheet-root').innerHTML = '';
  document.body.classList.remove('sheet-open');
}

const maskKey = (k) => (k ? `${k.slice(0, 5)}…${k.slice(-4)}` : '');

function providerRow(p) {
  const conn = connection(p.id, settings);
  const key = settings.keys[p.id];
  const mk = conn ? modelKey(p.id, conn.via) : null;
  const models = mk ? ui.models[mk] : null;
  const current = conn ? modelFor(p.id, settings) : null;
  const options = (models?.length ? models.map((m) => m.id) : current ? [current] : []);
  if (current && !options.includes(current)) options.unshift(current);
  const m = ui.keyMsg[p.id];
  const status = !conn ? '<span class="status off">Not connected</span>'
    : conn.via === 'openrouter' ? '<span class="status via">Via OpenRouter</span>'
    : m && !m.ok ? '<span class="status bad">Check key</span>' : '<span class="status ok">Connected</span>';
  return `<div class="prov" style="--c:${p.color}">
    <div class="prov-head">${badge(p.id)}<div class="prov-name"><b>${esc(p.name)}</b> <small>${esc(p.company)}</small><div class="champ">${esc(p.champion)}</div></div>${status}</div>
    <div class="row">
      <input type="password" autocomplete="off" spellcheck="false" data-field="key-${p.id}" placeholder="${key ? 'Saved key ' + esc(maskKey(key)) + ' — paste to replace' : `Paste your ${esc(p.company)} API key`}">
      <button class="btn sm" data-act="save-key" data-id="${p.id}">Save</button>
      ${key ? `<button class="btn sm ghost" data-act="remove-key" data-id="${p.id}">Remove</button>` : ''}
    </div>
    ${conn ? `<div class="row wrap">
      <label class="field">Model <select data-act="model" data-id="${p.id}">${options.map((o) => `<option value="${esc(o)}"${o === current ? ' selected' : ''}>${esc(o.replace(p.orPrefix, ''))}</option>`).join('')}</select></label>
      <button class="btn sm ghost" data-act="load-models" data-id="${p.id}">${models ? 'Refresh list' : 'Load models'}</button>
      <label class="check-label"><input type="checkbox" data-act="bench" data-id="${p.id}"${settings.off[p.id] ? '' : ' checked'}> On the team</label>
    </div>` : ''}
    ${m ? `<div class="prov-msg ${m.ok ? 'ok' : 'bad'}">${esc(m.text)}</div>` : ''}
    <div class="links"><a href="${p.keyUrl}" target="_blank" rel="noopener noreferrer">Get a key ↗</a><a href="${p.usageUrl}" target="_blank" rel="noopener noreferrer">Usage &amp; limits ↗</a><a href="${p.productUrl}" target="_blank" rel="noopener noreferrer">Try ${esc(p.name)} ↗</a></div>
  </div>`;
}

function roleSelect(role) {
  const avail = available(settings);
  return `<label class="field">${ROLE_LABELS[role]} <select data-act="role" data-role="${role}">
    <option value="auto"${settings.roles[role] === 'auto' ? ' selected' : ''}>Auto (${avail.length ? esc(P[pick(role, avail, { roles: {} })]?.name || '—') : '—'})</option>
    ${avail.map((id) => `<option value="${id}"${settings.roles[role] === id ? ' selected' : ''}>${esc(P[id].name)}</option>`).join('')}
  </select></label>`;
}

// Privacy & deployment: Sealed mode, offline AIs on this computer, a company gateway, and a
// log of every outside request the app has made this session.
function privacySection() {
  const locked = !!DEPLOY;
  const net = networkSummary();
  const lm = ui.localModels || [];
  const gm = ui.gwModels || [];
  const seatSelect = (act, id, current, list, allowNone = true) => {
    const opts = [...new Set([current, ...list.map((m) => m.id)].filter(Boolean))];
    return `<select data-act="${act}" data-id="${id}">${allowNone ? `<option value="">— sits out —</option>` : ''}${opts.map((o) => `<option value="${esc(o)}"${o === current ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  };
  return `<section class="set">
    <h3>🔒 Privacy: where your data goes</h3>
    <p class="muted">Elite AI has no server. Requests go only to the AIs you connect, and in a Huddle the AIs talk to each other inside this app.${locked ? ' <b>These settings are managed by your company.</b>' : ''}</p>
    <label class="check-label"><input type="checkbox" data-act="sealed"${settings.sealed ? ' checked' : ''}${locked && DEPLOY.sealed ? ' disabled' : ''}> <span><b>Sealed mode</b> — the app may only talk to your connected AIs. No web search, no other sites, no price lookups. Anything else is blocked and logged.</span></label>
    <div class="netlog"><b>Outside requests this session:</b> ${net.length ? net.map((n) => `<span class="chip-plain">${esc(n.host)} · ${n.count}${n.blocked ? ` (${n.blocked} blocked)` : ''}</span>`).join('') : '<span class="muted">none yet</span>'} <button class="link" data-act="netlog">Full log</button></div>

    <h4>Offline: AIs on this computer</h4>
    <p class="muted small">OpenAI (gpt-oss), Google (Gemma) and DeepSeek publish open models you can run on your own machine with Ollama or LM Studio, so nothing leaves the device. Claude, and the newest ChatGPT, Gemini and Grok models, only run on their companies' servers, so they sit out in offline mode.</p>
    <label class="check-label"><input type="checkbox" data-act="local-on"${settings.local.on ? ' checked' : ''}> Use AIs on this computer only</label>
    <div class="row"><input type="text" data-field="local-url" data-act="local-url" value="${esc(settings.local.url || LOCAL_DEFAULT_URL)}" spellcheck="false" placeholder="${LOCAL_DEFAULT_URL}"><button class="btn sm" data-act="local-load">Find models</button></div>
    ${ui.privMsg?.local ? `<div class="prov-msg ${ui.privMsg.local.ok ? 'ok' : 'bad'}">${esc(ui.privMsg.local.text)}</div>` : ''}
    <div class="seat-grid">${Object.entries(LOCAL_FAMILIES).map(([id, fam]) => `<label class="field">${badge(id, 'sm')} ${esc(P[id].name)}'s seat ${seatSelect('local-model', id, settings.local.models[id] || '', lm.filter((m) => fam.match.test(m.id)).concat(lm.filter((m) => !fam.match.test(m.id))))}<small class="muted">${esc(fam.label)}</small></label>`).join('')}
      <label class="field">${badge('anthropic', 'sm')} Claude's seat <small class="muted">no open model — sits out offline</small></label></div>

    <h4>Company AI gateway (private network)</h4>
    <p class="muted small">For companies: send every AI through your own OpenAI-compatible gateway (for example LiteLLM or Portkey in front of AWS Bedrock, Azure OpenAI and Google Vertex) so traffic never leaves your network. Company deployments set this once for everyone; see ENTERPRISE.md.</p>
    <label class="check-label"><input type="checkbox" data-act="gw-on"${settings.gateway.on ? ' checked' : ''}${locked && DEPLOY.gateway?.url ? ' disabled' : ''}> Use our company gateway</label>
    <div class="row wrap"><input type="text" data-field="gw-url" data-act="gw-url" value="${esc(settings.gateway.url)}" spellcheck="false" placeholder="https://ai-gateway.yourcompany.com/v1"><input type="password" data-field="gw-key" data-act="gw-key" autocomplete="off" placeholder="${settings.gateway.key ? 'Gateway key saved — paste to replace' : 'Gateway key (if required)'}"><button class="btn sm" data-act="gw-load">Find models</button></div>
    ${ui.privMsg?.gw ? `<div class="prov-msg ${ui.privMsg.gw.ok ? 'ok' : 'bad'}">${esc(ui.privMsg.gw.text)}</div>` : ''}
    <div class="seat-grid">${PROVIDERS.map((p) => `<label class="field">${badge(p.id, 'sm')} ${esc(p.name)}'s seat ${gm.length ? seatSelect('gw-model', p.id, settings.gateway.models[p.id] || '', gm) : `<input type="text" data-act="gw-model" data-id="${p.id}" data-field="gw-model-${p.id}" value="${esc(settings.gateway.models[p.id] || '')}" placeholder="model name on your gateway" spellcheck="false">`}</label>`).join('')}</div>
  </section>`;
}

const GW_GUESS = { openai: /gpt|^o\d/i, anthropic: /claude/i, google: /gemini/i, xai: /grok/i, deepseek: /deepseek/i };

async function loadPrivateModels(kind) {
  const isLocal = kind === 'local';
  const url = ($(`[data-field="${isLocal ? 'local-url' : 'gw-url'}"]`)?.value || '').trim();
  if (!url) { toast('Enter the address first.'); return; }
  if (isLocal) settings.local.url = url; else settings.gateway.url = url;
  const keyInput = $('[data-field="gw-key"]')?.value.trim();
  if (!isLocal && keyInput) settings.gateway.key = keyInput;
  saveSettings();
  ui.privMsg = { ...(ui.privMsg || {}), [isLocal ? 'local' : 'gw']: { ok: true, text: 'Looking for models…' } };
  refreshSheet();
  try {
    const list = await listPrivateModels(url, isLocal ? '' : settings.gateway.key);
    if (isLocal) {
      ui.localModels = list;
      for (const [id, fam] of Object.entries(LOCAL_FAMILIES)) {
        if (!settings.local.models[id]) { const hit = list.find((m) => fam.match.test(m.id)); if (hit) settings.local.models[id] = hit.id; }
      }
    } else {
      ui.gwModels = list;
      for (const p of PROVIDERS) {
        if (!settings.gateway.models[p.id]) { const hit = list.find((m) => GW_GUESS[p.id].test(m.id)); if (hit) settings.gateway.models[p.id] = hit.id; }
      }
    }
    saveSettings();
    ui.privMsg[isLocal ? 'local' : 'gw'] = { ok: true, text: `Found ${list.length} model${list.length === 1 ? '' : 's'}. Matching ones were placed in their seats — change any seat below.` };
  } catch (e) {
    const blocked = e instanceof TypeError;
    ui.privMsg[isLocal ? 'local' : 'gw'] = { ok: false, text: blocked
      ? (isLocal ? 'Could not reach it. Is Ollama or LM Studio running? For the web version, start Ollama with OLLAMA_ORIGINS set to this site (see ENTERPRISE.md).' : 'Could not reach the gateway. On the public beta only known AI companies are reachable; deploy Elite AI inside your network with tools/configure.mjs to use a private gateway.')
      : e.message };
  }
  refreshSheet();
  renderComposer();
}

function netlogBody() {
  const rows = networkLog().filter((e) => !e.internal);
  return `<p class="muted">Every outside request Elite AI made this session (host and path only — never keys or content).${isSealed() ? ' Sealed mode is on: only your connected AIs are allowed.' : ''}</p>
  ${rows.length ? `<div class="table-wrap"><table class="matrix netlog-table"><thead><tr><th>Time</th><th>Where</th><th>What</th><th></th></tr></thead><tbody>${rows.map((e) => `<tr><td>${new Date(e.at).toLocaleTimeString()}</td><td>${esc(e.host)}</td><td>${esc(e.method)} ${esc(e.path)}</td><td>${e.allowed ? '✓' : '<span class="bad">blocked</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<p>No outside requests yet.</p>'}`;
}

function settingsBody() {
  const orKey = settings.keys.openrouter;
  const m = ui.keyMsg.openrouter;
  return `
  <section class="set">
    <h3>Connect your AIs</h3>
    <p class="muted">You bring your own AI accounts and pay each company directly — Elite AI never sees, stores or resells your keys. Keys are saved <b>only on this device</b>${isStandalone ? '' : ' in this browser'}; prompts go straight from here to each AI company.</p>
    <div class="prov or">
      <div class="prov-head"><span class="badge" style="--c:#e2b553">★</span><div class="prov-name"><b>Easiest: one key for all five</b><div class="champ">An OpenRouter key reaches every AI below, billed at each model's listed price plus OpenRouter's fee. Any company key you add directly takes priority.</div></div>${orKey ? '<span class="status ok">Connected</span>' : ''}</div>
      <div class="row">
        <input type="password" autocomplete="off" spellcheck="false" data-field="key-openrouter" placeholder="${orKey ? 'Saved key ' + esc(maskKey(orKey)) + ' — paste to replace' : 'Paste your OpenRouter API key'}">
        <button class="btn sm" data-act="save-key" data-id="openrouter">Save</button>
        ${orKey ? '<button class="btn sm ghost" data-act="remove-key" data-id="openrouter">Remove</button>' : ''}
      </div>
      ${m ? `<div class="prov-msg ${m.ok ? 'ok' : 'bad'}">${esc(m.text)}</div>` : ''}
      <div class="links"><a href="${OPENROUTER.keyUrl}" target="_blank" rel="noopener noreferrer">Get a key ↗</a><a href="${OPENROUTER.creditsUrl}" target="_blank" rel="noopener noreferrer">Credits &amp; limits ↗</a></div>
    </div>
    <h4>Or connect each AI company directly</h4>
    ${PROVIDERS.map(providerRow).join('')}
    <p class="muted small">Safety tip: give each key a monthly spending limit in that company's dashboard, and don't install Elite AI on a shared device.</p>
  </section>
  ${privacySection()}
  <section class="set">
    <h3>Team roles</h3>
    <p class="muted small">${settings.useAudit ? `“Auto” uses your Champion Audit from ${esc(new Date(settings.auditAt).toLocaleDateString())}.` : '“Auto” uses public reputation until you run a Champion Audit.'} <button class="link" data-act="audit">${settings.useAudit ? 'See audit' : 'Run a Champion Audit'}</button></p>
    <div class="row wrap">${roleSelect('plan')}${roleSelect('write')}${roleSelect('verify')}<label class="field">Huddle rounds <select data-act="hrounds">${[2, 3, 4].map((n) => `<option value="${n}"${Number(settings.huddleRounds || 3) === n ? ' selected' : ''}>${n}</option>`).join('')}</select></label></div>
    <label class="check-label"><input type="checkbox" data-act="osearch"${settings.openaiSearch !== false ? ' checked' : ''}> Let ChatGPT search the web on research and fact-check steps (it leads the search benchmarks; OpenAI bills searches separately)</label>
    <label class="field">Learning checks (blind A/B of the team vs one AI; each adds one AI call) <select data-act="lchecks">${[['some', `About 1 in ${Math.round(1 / BLIND_RATE)} team answers`], ['all', 'Every team answer (learns fastest)'], ['off', 'Off']].map(([v, t]) => `<option value="${v}"${(settings.learningChecks === true ? 'some' : settings.learningChecks === false ? 'off' : settings.learningChecks || 'some') === v ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
    <label class="check-label"><input type="checkbox" data-act="gsearch"${settings.geminiSearch ? ' checked' : ''}> Let Gemini search Google when it works (grounded answers with sources; Google may bill searches separately)</label>
  </section>
  <section class="set">
    <h3>Budget</h3>
    <div class="row wrap"><label class="field">Daily cap (USD, 0 = none) <input type="number" min="0" step="0.5" inputmode="decimal" data-act="cap" data-field="cap" value="${settings.dailyCap}"></label>
    <span class="muted">Today ≈${money(spentToday())}</span></div>
    <p class="muted small">Costs are estimates from each model's public list price. Your real bill is on each company's usage page.</p>
  </section>
  <section class="set">
    <h3>Install</h3>
    <p class="muted">${isStandalone ? 'Elite AI is installed on this device. ✓'
      : isIOS ? 'iPhone / iPad: open this page in Safari, tap <b>Share</b>, then <b>Add to Home Screen</b>. Keys you saved in Safari need to be added again inside the installed app.'
      : 'Desktop: click the install icon in Chrome or Edge’s address bar (or the Install button at the top), and Elite AI opens in its own window.'}</p>
    ${ui.installPrompt ? '<button class="btn gold" data-act="install">Install Elite AI</button>' : ''}
  </section>
  <section class="set">
    <h3>Your data</h3>
    <div class="row wrap">
      <button class="btn sm ghost" data-act="export">Export conversations</button>
      <button class="btn sm ghost" data-act="clear-threads">Delete all conversations</button>
      <button class="btn sm ghost" data-act="clear-keys">Remove all keys</button>
    </div>
  </section>
  <section class="set">
    <h3>About</h3>
    <p class="muted small">Built by Claude (Anthropic) with design reviews from ChatGPT (OpenAI) and Gemini (Google): ChatGPT shaped Team Replay, second opinions, cost caps, failure recovery, the trust test, the learning loop, tryouts and All 5 mode; Gemini shaped evidence-based verification, the three-step cap, fresh audit numbers, personal routing, upstream credit and the case for blind checks.</p>
    <p class="muted small">Elite AI ${VERSION}. Credits, timings, tokens and costs come from the app's own execution log, never from an AI describing itself. When AIs work together, your request — and teammates' work on it — is sent to each AI company involved, under that company's own terms and privacy policy.</p>
    <p class="muted small">Elite AI is an independent app and is not affiliated with, sponsored or endorsed by OpenAI, Anthropic, Google, xAI, DeepSeek or OpenRouter. Product names belong to their owners and are used only to identify each service.</p>
  </section>`;
}

function openSettings() {
  openSheet('Settings', settingsBody, { wide: true });
  for (const p of PROVIDERS) if (connection(p.id, settings)) ensureModels(p.id);
}

function teamBody() {
  const audited = settings.useAudit && settings.auditAt;
  return `<div class="audit-callout">
      <div><b>${audited ? `Roles use your audit from ${esc(new Date(settings.auditAt).toLocaleDateString())}` : `Roles follow public leaderboards (${esc(EVIDENCE.date)})`}</b>
      <p class="muted small">${audited ? 'Each role goes to the AI that scored best on your own keys.' : 'Run a Champion Audit to test every AI on the same tasks with your own keys and see who is actually best at each job.'}</p></div>
      <button class="btn sm gold" data-act="audit">${audited ? 'Audit again' : 'Run a Champion Audit'}</button>
    </div>
  <p class="muted">Your 👍/👎 and “best answer” picks are tallied here too, so you can see who earns their spot.</p>
  <div class="team-grid">${PROVIDERS.map((p) => {
    const conn = connection(p.id, settings);
    const s = scores[p.id] || {};
    const m = settings.useAudit ? settings.measured?.[p.id] : null;
    return `<div class="team-card" style="--c:${p.color}">
      <div class="prov-head">${badge(p.id)}<div class="prov-name"><b>${esc(p.name)}</b> <small>by ${esc(p.company)}</small></div>
        ${conn ? (settings.off[p.id] ? '<span class="status off">Benched</span>' : '<span class="status ok">On the team</span>') : '<span class="status off">Not connected</span>'}</div>
      <p><b>Championed for:</b> ${esc(p.champion)}</p>
      <p class="muted small">Evidence: ${esc(p.evidence)}</p>
      ${m?.best?.length ? `<p class="measured">★ <b>Measured best at:</b> ${esc(m.best.join(', '))}</p>` : ''}
      ${m?.strong?.length ? `<p class="measured">Also strong at: ${esc(m.strong.join(', '))}</p>` : ''}
      ${conn ? `<p class="muted small">Model: ${esc(modelFor(p.id, settings).replace(p.orPrefix, ''))}${conn.via === 'openrouter' ? ' (via OpenRouter)' : ''} · Live web: ${hasWeb(p.id, settings) ? 'yes' : 'no'}</p>` : ''}
      <p class="muted small">Your ratings: 👍 ${s.up || 0} · 👎 ${s.down || 0} · ★ best ${s.best || 0}</p>
      <a class="link" href="${p.productUrl}" target="_blank" rel="noopener noreferrer">Try ${esc(p.name)} from ${esc(p.company)} ↗</a>
    </div>`;
  }).join('')}</div>
  <details class="sources why-five"><summary>Why only five?</summary><div class="pad small">
    <p>Elite AI keeps only the AIs the evidence supports. Left out as of ${esc(EVIDENCE.date)}:</p>
    <ul>${RESERVES.map((p) => `<li><b>${esc(p.name)}</b>${p.company !== p.name ? ` (${esc(p.company)})` : ""} — ${esc(p.evidence)}</li>`).join('')}</ul>
    <p>They stay on the reserve bench and can be promoted back if a future review shows they've caught up.</p>
    <p class="muted">Sources: ${EVIDENCE.sources.map(([label, url]) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`).join(' · ')}</p>
  </div></details>`;
}

// ---- Your Elite Index ------------------------------------------------------------------

const CATEGORY_SKILL = { research: 'research', writing: 'writing', coding: 'coding', math: 'math', factcheck: 'factcheck', longdoc: 'longdoc', planning: 'planning', critique: 'critique', translation: 'translation' };

function indexBody() {
  const avail = available(settings);
  const { stats, total } = personalStats();
  const runs = loadRuns();
  const ranks = runs.length ? rankings(summarizeRuns(runs, settings)) : {};
  const cell = (pid, extra = '') => (pid ? `${chip(pid)}${extra ? `<small> ${extra}</small>` : ''}` : '<span class="muted">—</span>');
  return `<p class="lead-sm">Who does each job is decided by three layers of evidence. The first two anyone could copy. <b>The third is yours alone</b> — it grows every time an answer passes a check, you rate an answer, open a source, pick a winner, or take a blind check.</p>
  <div class="layers">
    <div><span>1</span><b>Public leaderboards</b><small>${esc(EVIDENCE.date)}</small></div>
    <div><span>2</span><b>Your Champion Audits</b><small>${runs.length} audit${runs.length === 1 ? '' : 's'}</small></div>
    <div><span>3</span><b>Your everyday results</b><small>${total} task${total === 1 ? '' : 's'} learned from</small></div>
  </div>
  <div class="table-wrap"><table class="matrix index"><thead><tr><th>Task type</th><th>1 · Public pick</th><th>2 · Your audit</th><th>3 · Your results</th><th>Blind checks: team vs one AI</th></tr></thead><tbody>${
    Object.entries(CATEGORIES).map(([cat, label]) => {
      const mine = rankedFor(cat, avail)[0];
      const audit = CATEGORY_SKILL[cat] ? ranks[CATEGORY_SKILL[cat]]?.[0] : null;
      const team = stats[cat]?.team;
      const votes = team ? team.better + team.same + team.worse : 0;
      return `<tr><td><b>${esc(label)}</b><small>${stats[cat]?.tasks || 0} tasks</small></td>
        <td>${cell(EVIDENCE.bestFor[cat])}</td>
        <td>${audit ? cell(audit.pid, audit.score.toFixed(1)) : cell(null)}</td>
        <td>${mine ? cell(mine.pid, `${Math.round(mine.score * 100)}% ±${Math.round(mine.spread * 100)} · ${Math.round(mine.n)} signals`) : `<span class="muted small">needs ${MIN_SIGNALS}+ signals</span>`}</td>
        <td>${votes ? `<span class="small">👍 ${team.better} · = ${team.same} · 👎 ${team.worse}</span>` : '<span class="muted">—</span>'}</td></tr>`;
    }).join('')}</tbody></table></div>
  <p class="muted small"><b>How scores work:</b> answers that pass an independent check count double and credit everyone who built them; your 👍/👎 and best-answer picks count once; opening a source credits the AI that found it; copying or sharing counts as engagement, not a vote. An AI needs ${MIN_SIGNALS}+ signals and a clear lead before the planner treats it as your favourite, and about 1 in 10 tasks gives another AI a tryout so a favourite can't lock in. If blind checks keep showing the team is no better than one AI for a task type, the planner keeps it to one AI and Elite AI suggests Direct mode to save time and money.</p>
  <p class="muted small">Private by design: this lives only on this device and stores no prompts or answers — just which AIs worked on what kind of task and how you rated them. Opt-in sharing to a community Elite Index is planned next; it is how Elite AI will get smarter for everyone.</p>
  <div class="row wrap"><button class="btn sm ghost" data-act="index-export">Export my data</button><button class="btn sm ghost" data-act="index-reset">Reset learning</button><button class="btn sm ghost" data-act="audit">Champion audit</button></div>`;
}

// ---- Champion Audit screens ---------------------------------------------------------------

const ROLE_NAMES = { plan: 'Planner', write: 'Final writer', verify: 'Verifier', challenge: 'Challenger', research: 'Researcher' };
const fmtScore = (x) => (x == null ? '—' : x.toFixed(1));
const heat = (x) => (x == null ? '' : `background:color-mix(in srgb, var(--gold) ${Math.round(Math.max(0, x) * 5.5)}%, var(--panel))`);

function auditBody() {
  const a = ui.audit;
  if (a.run && a.run.status === 'running') return auditRunning(a.run);
  const runs = loadRuns();
  if (a.view === 'results' && runs.length) return auditResults(runs);
  return auditSetup(runs);
}

function auditSetup(runs) {
  const avail = available(settings);
  const a = ui.audit;
  const est = avail.length > 1 ? estimateAudit(settings, avail, { full: a.full, teamCheck: a.team }) : null;
  const taskCount = TASKS.filter((t) => a.full || t.quick).length;
  return `<p class="lead-sm">Are we really giving each AI the job it does best? This audit gives every AI on your team the <b>same tasks</b> and measures who actually wins — on your own keys, with today's models.</p>
  <ul class="ticks">
    <li><b>Right-answer tasks are checked automatically</b> — math, code run against hidden tests, planted-error traps, questions about a long document.</li>
    <li><b>Open-ended tasks are graded blind</b> by the other AIs: answers are anonymous and shuffled, and no AI grades its own work.</li>
    <li><b>Speed and cost</b> are measured on every answer, and results add up across audits.</li>
    <li><b>Nothing changes until you approve</b> the recommendations.</li>
  </ul>
  <h4>What gets tested</h4>
  <div class="skill-list">${SKILLS.map((sk) => `<div><b>${esc(sk.label)}</b>${sk.role ? `<span class="tag">decides the ${ROLE_NAMES[sk.role]}</span>` : ''}<small>${esc(sk.what)}</small></div>`).join('')}</div>
  <h4>AIs in this audit</h4>
  <div class="credits">${avail.map((id) => chip(id, modelFor(id, settings).replace(P[id].orPrefix, ''))).join('') || '<span class="muted">None connected yet.</span>'}</div>
  ${avail.length < 2 ? '<p class="prov-msg bad">Connect at least two AIs to compare them.</p>' : ''}
  <div class="row wrap audit-opts">
    <label class="check-label"><input type="radio" name="audit-depth" data-act="audit-depth" value="quick"${a.full ? '' : ' checked'}> Quick — 1 task per skill</label>
    <label class="check-label"><input type="radio" name="audit-depth" data-act="audit-depth" value="full"${a.full ? ' checked' : ''}> Thorough — ${TASKS.length} tasks (more reliable)</label>
  </div>
  <label class="check-label"><input type="checkbox" data-act="audit-team"${a.team ? ' checked' : ''}> Also test the whole system: does the Elite Team beat the best single AI?</label>
  ${est ? `<p class="estimate">${taskCount} tasks · about ${est.calls} AI calls · roughly ${money(est.low)}–${money(est.high)} · about ${est.minutes}–${est.minutes * 2} min${est.unknown ? ' · some prices unknown' : ''}<br><small class="muted">Charged to your own AI accounts and counted toward today's spend (≈${money(spentToday())}${settings.dailyCap > 0 ? ` of $${settings.dailyCap}` : ''}). You can stop at any time.</small></p>` : ''}
  <div class="row wrap">
    <button class="btn gold" data-act="audit-run"${avail.length < 2 ? ' disabled' : ''}>Run the audit</button>
    ${runs.length ? `<button class="btn ghost" data-act="audit-view" data-view="results">See last results (${esc(new Date(runs[0].at).toLocaleDateString())})</button>` : ''}
  </div>`;
}

function auditRunning(run) {
  const pct = run.total ? Math.min(100, Math.round((run.done / run.total) * 100)) : 0;
  const icon = (ans) => (ans.status === 'working' ? '<span class="spin"></span>' : ans.status === 'error' ? '<span class="bad">!</span>' : ans.score != null ? fmtScore(ans.score) : ans.status === 'done' ? '✓' : '·');
  return `<div class="audit-progress"><div class="bar"><i style="width:${pct}%"></i></div>
    <div class="row wrap"><span>${run.done}/${run.total} calls · ${esc(run.phase || 'Working')} · ≈${money(run.cost)} so far</span><button class="btn sm ghost" data-act="audit-stop">Stop</button></div></div>
  <div class="table-wrap"><table class="matrix"><thead><tr><th>Task</th>${run.avail.map((id) => `<th>${badge(id, 'sm')}<span>${esc(P[id].name)}</span></th>`).join('')}</tr></thead>
  <tbody>${run.items.map((it) => `<tr><td><b>${esc(SKILL[it.skill].label)}</b><small>${esc(it.title)}</small></td>${run.avail.map((id) => `<td style="${heat(it.answers[id].score)}">${icon(it.answers[id])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
  ${run.team ? `<p class="muted small">Team vs. solo: ${run.team.tasks.length} task(s) in progress…</p>` : ''}
  <p class="muted small">You can close this window — the audit keeps running and results appear here when it's done.</p>`;
}

function auditResults(runs) {
  const avail = available(settings);
  const latest = runs[0];
  const agg = summarizeRuns(runs, settings);
  const ranks = rankings(agg);
  const cards = perAI(agg, avail.filter((id) => latest.avail.includes(id) || SKILLS.some((sk) => agg[sk.id]?.[id])));
  const rec = recommend(agg, settings, avail);
  const used = runs.filter((r) => r.items.some((it) => Object.entries(it.answers).some(([pid, x]) => x.score != null && modelFor(pid, settings) === r.models[pid]))).length;
  const cols = cards.map((c) => c.pid);
  const tv = latest.team;
  const applied = settings.useAudit;
  const teamLine = tv?.tasks?.length ? (() => {
    const done = tv.tasks.filter((t) => t.verdict);
    const w = done.filter((t) => t.verdict === 'team').length, l = done.filter((t) => t.verdict === 'solo').length;
    return `<div class="team-verdict ${w > l ? 'win' : l > w ? 'loss' : ''}"><b>${!done.length ? 'No verdict — the team or solo run failed.' : w > l ? `The Elite Team beat ${esc(P[tv.solo].name)} alone (${w}–${l})` : l > w ? `${esc(P[tv.solo].name)} alone beat the Elite Team (${l}–${w})` : `Tie between the Elite Team and ${esc(P[tv.solo].name)} alone`}</b>
      ${tv.tasks.map((t) => `<p class="small">“${esc(t.prompt.slice(0, 70))}…” — ${t.verdict ? `judges: ${t.votes.map((v) => `${esc(P[v.judge].name)} → ${v.winner}${v.why ? ` (${esc(v.why)})` : ''}`).join('; ')}` : esc(t.teamError || t.soloError || 'no result')}<br>
      <span class="muted">Team (${(t.teamAIs || []).map((id) => esc(P[id].name)).join(', ')}): ${secs(t.teamMs)}, ≈${money(t.teamCost)} · Solo: ${secs(t.soloMs)}, ≈${money(t.soloCost)}</span></p>`).join('')}
      <p class="muted small">${w > l ? 'Worth it: teamwork produced the better answer, at extra cost and time shown above.' : 'If the best single AI keeps winning, use Direct mode for everyday questions and save the team for big tasks.'}</p></div>`;
  })() : '';

  return `<p class="muted small">Latest audit ${esc(new Date(latest.at).toLocaleString())} · ${latest.avail.length} AIs · ${latest.items.length} tasks · ≈${money(latest.cost)}. Scores combine ${used} audit${used === 1 ? '' : 's'} (answers from models you no longer use are left out). Scale: 0–10.</p>
  <h3 class="audit-h">Who's best at what</h3>
  <div class="table-wrap"><table class="matrix results"><thead><tr><th>Skill</th>${cols.map((id) => `<th>${badge(id, 'sm')}<span>${esc(P[id].name)}</span></th>`).join('')}<th>Confidence</th></tr></thead>
  <tbody>${SKILLS.map((sk) => {
    const rows = ranks[sk.id];
    return `<tr><td><b>${esc(sk.label)}</b>${sk.role ? `<small>decides the ${ROLE_NAMES[sk.role]}</small>` : ''}</td>${cols.map((id) => {
      const r = rows.find((x) => x.pid === id);
      const star = r && isTop(rows, id);
      return `<td class="${star ? 'top' : ''}" style="${heat(r?.score)}">${r ? `${star ? '★ ' : ''}${fmtScore(r.score)}` : '—'}</td>`;
    }).join('')}<td><span class="conf ${rows.length > 1 ? confidence(rows) : 'low'}">${rows.length > 1 ? confidence(rows) : 'n/a'}</span></td></tr>`;
  }).join('')}</tbody></table></div>

  <h3 class="audit-h">Report cards</h3>
  <div class="report-grid">${cards.sort((x, y) => (y.overall ?? -1) - (x.overall ?? -1)).map((c) => `<div class="report" style="--c:${P[c.pid].color}">
    <div class="prov-head">${badge(c.pid)}<div class="prov-name"><b>${esc(P[c.pid].name)}</b><div class="champ">${esc(modelFor(c.pid, settings)?.replace(P[c.pid].orPrefix, '') || '')}</div></div><span class="big">${fmtScore(c.overall)}</span></div>
    <p class="small">${c.wins.length ? `★ Best at: ${esc(c.wins.join(', '))}` : '<span class="muted">No first places</span>'}</p>
    <p class="muted small">Avg ${c.ms ? secs(c.ms) : '—'} per answer · ≈${money(c.costPerTask)} per task</p>
    <p class="muted small">Everyday ratings: 👍 ${scores[c.pid]?.up || 0} · 👎 ${scores[c.pid]?.down || 0} · ★ ${scores[c.pid]?.best || 0}</p></div>`).join('')}</div>

  ${tv ? `<h3 class="audit-h">Is the team better than one AI?</h3>${teamLine}` : ''}

  <h3 class="audit-h">Recommended changes</h3>
  ${rec.changes.length ? `<ul class="changes">${rec.changes.map((c) => c.clear
      ? `<li>${chip(c.from)} → ${chip(c.to)} as <b>${ROLE_NAMES[c.role]}</b> <span class="muted small">(${esc(c.skill)}: ${fmtScore(c.fromScore)} → ${fmtScore(c.toScore)} · ${c.confidence} confidence)</span></li>`
      : `<li class="close">${chip(c.to)} edged out ${chip(c.from)} for <b>${ROLE_NAMES[c.role]}</b> <span class="muted small">(${esc(c.skill)}: ${fmtScore(c.toScore)} vs ${fmtScore(c.fromScore)}) — close call, so ${esc(P[c.from].name)} keeps the job until another audit confirms the gap</span></li>`).join('')}</ul>`
    : '<p class="small">✓ The current role assignments already match the measured winners.</p>'}
  <p class="muted small">Applying also tells the planner which AI measured best at each skill, so it can route specialist steps (code, math, documents, translation) by evidence. ${Object.values(rankings(agg)).some((rows) => rows.length > 1 && confidence(rows) === 'low') ? 'Some skills rest on only 1–2 tasks — run the audit again (or a thorough audit) before trusting close calls.' : ''}</p>
  <div class="row wrap">
    <button class="btn gold" data-act="audit-apply">${applied ? 'Re-apply latest results' : 'Apply audit results'}</button>
    ${applied ? '<button class="btn ghost" data-act="audit-revert">Go back to reputation defaults</button>' : ''}
    <button class="btn ghost" data-act="audit-view" data-view="setup">Run another audit</button>
  </div>
  ${applied ? `<p class="prov-msg ok">Audit results are in use (applied ${esc(new Date(settings.auditAt).toLocaleDateString())}).</p>` : ''}

  <h3 class="audit-h">Every answer and grade</h3>
  ${latest.items.map((it) => {
    const key = `au-${latest.id}-${it.task}`;
    return `<details class="sources" data-key="${key}"${ui.open.has(key) ? ' open' : ''}><summary>${esc(SKILL[it.skill].label)} — ${esc(it.title)}</summary><div class="audit-answers">${
      latest.avail.map((id) => {
        const x = it.answers[id];
        return `<div class="step ${x.status}"><div class="step-head">${chip(id)}<span class="st">${fmtScore(x.score)}</span></div>
          ${x.note ? `<div class="step-instr">Auto-check: ${esc(x.note)}</div>` : ''}
          ${(x.grades || []).map((g) => `<div class="step-instr">${esc(P[g.judge].name)} graded ${g.score}/10${g.why ? ` — ${esc(g.why)}` : ''}</div>`).join('')}
          ${x.error ? `<div class="err-line">${esc(x.error)}</div>` : ''}
          ${x.text ? `<details><summary>Show answer</summary><div class="md">${renderMarkdown(x.text)}</div></details>` : ''}</div>`;
      }).join('')}${(it.judgeErrors || []).map((e) => `<div class="err-line">Judge problem — ${esc(e)}</div>`).join('')}</div></details>`;
  }).join('')}`;
}

function refreshAuditSoon() {
  if (ui.audit.timer) return;
  ui.audit.timer = setTimeout(() => {
    ui.audit.timer = 0;
    if (ui.sheet?.body === auditBody) refreshSheet();
  }, 200);
}

async function startAudit() {
  const avail = available(settings);
  if (avail.length < 2 || ui.audit.controller) return;
  const ctrl = new AbortController();
  ui.audit.controller = ctrl;
  try {
    const run = await runAudit({
      settings, avail, full: ui.audit.full, teamCheck: ui.audit.team, signal: ctrl.signal,
      onUpdate: (r) => { ui.audit.run = r; refreshAuditSoon(); },
      spend: addSpend,
    });
    saveRun(run);
    ui.audit.view = 'results';
    toast('Champion Audit complete ✓', 3500);
  } catch (e) {
    if (e.name === 'AbortError') toast('Audit stopped — nothing was saved.');
    else toast('Audit failed: ' + e.message, 5000);
    ui.audit.view = loadRuns().length ? 'results' : 'setup';
  }
  ui.audit.run = null;
  ui.audit.controller = null;
  if (ui.sheet?.body === auditBody) refreshSheet();
  renderComposer();
}

function applyAudit() {
  const avail = available(settings);
  const rec = recommend(summarizeRuns(loadRuns(), settings), settings, avail);
  settings.routing = rec.routing;
  settings.measured = rec.measured;
  settings.useAudit = true;
  settings.auditAt = loadRuns()[0]?.at || Date.now();
  saveSettings();
  refreshSheet();
  renderComposer();
  toast('Applied — each role now goes to the measured winner.', 3500);
}

function openSecondOpinion(msgId) {
  const { msg } = findMsg(msgId);
  if (!msg) return;
  const author = msg.writer?.provider || msg.steps?.[msg.steps.length - 1]?.provider;
  const avail = available(settings).filter((id) => id !== author);
  const suggested = pick('verify', avail, settings);
  openSheet('Get a second opinion', `<p class="muted">Another AI checks this answer and flags anything it disagrees with.</p>
    <div class="pick-list">${avail.map((id) => `<button class="pick" data-act="run-second" data-mid="${msgId}" data-id="${id}">${badge(id)}<span><b>${esc(P[id].name)}${id === suggested ? ' <em class="gold">suggested</em>' : ''}</b><small>${esc(P[id].champion)}</small></span></button>`).join('')}</div>`);
}

function feedbackBody() {
  return `<p class="muted">Thanks for testing Elite AI! Tell us what worked, what broke, and what you wish it did. Then tap Share (or Copy) and send it back to whoever invited you.</p>
    <textarea class="fb" data-field="fb" rows="6" placeholder="What worked? What broke? What would make you use this every day?"></textarea>
    <div class="row wrap">${navigator.share ? '<button class="btn gold" data-act="fb-share">Share feedback</button>' : ''}<button class="btn ${navigator.share ? 'ghost' : 'gold'}" data-act="fb-copy">Copy feedback</button></div>
    <p class="muted small">Adds: app version, your device type, mode and which AIs are connected — never your keys or conversations.</p>`;
}

function feedbackText() {
  const note = $('[data-field="fb"]')?.value.trim() || '(no comments)';
  const avail = available(settings).map((id) => P[id].name + (connection(id, settings).via === 'openrouter' ? ' (OpenRouter)' : '')).join(', ') || 'none';
  return `Elite AI feedback\n\n${note}\n\n— Version ${VERSION} · ${isIOS ? 'iPhone/iPad' : /android/i.test(navigator.userAgent) ? 'Android' : 'Desktop'}${isStandalone ? ' (installed)' : ''} · Mode: ${MODES[settings.mode].label} · AIs: ${avail}`;
}

function welcome() {
  openSheet('Welcome to Elite AI', `<div class="welcome">
    <img src="icons/icon.svg" alt="" width="64" height="64">
    <p class="lead">One app where the world's best AIs work together — and each one gets credit for what it does best.</p>
    <ul class="ticks">
      <li><b>Elite Team</b> — a planner splits your task and sends each part to the right AI.</li>
      <li><b>Compare</b> and <b>Cross-check</b> — see answers side by side, or have AIs fact-check each other.</li>
      <li><b>Full transparency</b> — Team Replay shows who did what, how long it took and what it cost.</li>
      <li><b>Your accounts, your keys</b> — you pay each AI company directly; keys stay on this device.</li>
    </ul>
    <div class="row wrap center"><button class="btn gold" data-act="settings">Connect my AIs</button><button class="btn ghost" data-act="close-sheet">Look around first</button></div>
    <p class="muted small">Beta for friends &amp; family · Not affiliated with any AI company.</p>
  </div>`);
}

// ---- Keys & models -------------------------------------------------------------------

async function ensureModels(id, force = false) {
  const conn = connection(id, settings);
  if (!conn) return;
  const mk = modelKey(id, conn.via);
  if (ui.models[mk] && !force) return;
  try {
    const list = await listModels(id, settings);
    ui.models[mk] = list;
    if (!settings.models[mk] || force) {
      const best = autoPick(id, conn.via, list);
      if (best && !settings.models[mk]) { settings.models[mk] = best; saveSettings(); }
    }
    if (force) ui.keyMsg[id] = { ok: true, text: `${list.length} models available.` };
  } catch (e) {
    if (force || conn.via === 'direct') ui.keyMsg[id] = { ok: false, text: e.message };
  }
  refreshSheet();
}

async function saveKey(id) {
  const input = $(`[data-field="key-${id}"]`);
  const key = input?.value.trim().replace(/^Bearer\s+/i, '');
  if (!key) { toast('Paste a key first.'); return; }
  if (/\s/.test(key) || key.length < 12) { ui.keyMsg[id] = { ok: false, text: 'That doesn’t look like an API key.' }; refreshSheet(); return; }
  settings.keys[id] = key;
  // A new key means a new connection — let it pick a fresh default model.
  if (id !== 'openrouter') delete settings.models[modelKey(id, 'direct')];
  saveSettings();
  ui.keyMsg[id] = { ok: true, text: 'Saved — checking…' };
  refreshSheet();

  if (id === 'openrouter') {
    try {
      const r = await fetch(OPENROUTER.base + '/key', { headers: { Authorization: 'Bearer ' + key } });
      if (!r.ok) throw new Error(r.status === 401 ? 'OpenRouter rejected this key.' : 'OpenRouter error ' + r.status);
      const d = (await r.json()).data || {};
      ui.keyMsg.openrouter = { ok: true, text: `Connected ✓ — all five AIs are now reachable${d.limit != null ? ` · limit $${d.limit}` : ''}${d.usage != null ? ` · used $${Number(d.usage).toFixed(2)}` : ''}.` };
      for (const p of PROVIDERS) if (connection(p.id, settings)?.via === 'openrouter') ensureModels(p.id);
    } catch (e) {
      ui.keyMsg.openrouter = { ok: false, text: e.message };
    }
  } else if (P[id].staticModels) {
    ui.keyMsg[id] = { ok: true, text: 'Saved ✓ — it will be verified on first use.' };
  } else {
    const conn = connection(id, settings);
    try {
      const list = await listModels(id, settings);
      ui.models[modelKey(id, conn.via)] = list;
      const best = autoPick(id, conn.via, list);
      if (best) settings.models[modelKey(id, conn.via)] = best;
      saveSettings();
      ui.keyMsg[id] = { ok: true, text: `Connected ✓ — using ${best || modelFor(id, settings)}. ${list.length} models available.` };
    } catch (e) {
      ui.keyMsg[id] = { ok: false, text: e.message };
    }
  }
  refreshSheet();
  renderComposer();
  if (!thread()?.messages.length) renderFeed();
}

// ---- Events --------------------------------------------------------------------------

function autoGrow() {
  const el = $('#input');
  // Empty box: back to one line (Chrome measures the placeholder, which can wrap when narrow).
  if (!el.value) { el.style.height = ''; el.style.overflowY = 'hidden'; return; }
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  el.style.overflowY = el.scrollHeight > 200 ? 'auto' : 'hidden';
}

function newThread() {
  currentId = null;
  closeDrawer();
  renderAll();
  scrollToBottom();
  if (!isTouch) $('#input').focus();
}

const openDrawer = () => document.body.classList.add('drawer-open');
const closeDrawer = () => document.body.classList.remove('drawer-open');

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function copy(text, label = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(label); } catch { toast('Copy failed — select the text instead.'); }
}

function accepted(msg) {
  if (msg.accepted) return;
  msg.accepted = true;
  const author = msg.writer?.provider || (msg.steps || []).find((s) => s.status === 'done' && !s.replacedBy)?.provider;
  if (author) signal(msg.id, author, 'accept', 1);
  saveThreads();
}

function plainCredits(msg) {
  return credits(msg).map(([id, roles]) => `${P[id].name} (${roles.join(' + ')})`).join(', ');
}

const actions = {
  'close-sheet': (el, e) => { if (e.target === el || el.tagName === 'BUTTON') closeSheet(); },
  settings: () => { closeDrawer(); openSettings(); },
  team: () => openSheet('Meet the team', teamBody, { wide: true }),
  audit: () => {
    closeDrawer();
    if (!ui.audit.run) ui.audit.view = loadRuns().length ? 'results' : 'setup';
    openSheet('Champion audit', auditBody, { wide: true });
  },
  'audit-run': () => startAudit(),
  'audit-stop': () => ui.audit.controller?.abort(),
  'audit-view': (el) => { ui.audit.view = el.dataset.view; refreshSheet(); $('.sheet-body').scrollTop = 0; },
  'audit-apply': () => applyAudit(),
  'audit-revert': () => {
    settings.useAudit = false;
    saveSettings(); refreshSheet(); renderComposer();
    toast('Back to reputation-based roles. Your audit results are kept.');
  },
  feedback: () => { closeDrawer(); openSheet('Send feedback', feedbackBody); },
  example: (el) => { $('#input').value = el.textContent; autoGrow(); send(el.textContent); },
  'ios-tip-done': () => { store.write('iosTipDone', true); renderFeed(); },
  'toggle-ai': (el) => {
    const id = el.dataset.id;
    settings.off[id] = !settings.off[id];
    if (!available(settings).length) { settings.off[id] = false; toast('Keep at least one AI on the team.'); }
    saveSettings();
    renderComposer();
  },
  'pick-direct': (el) => { settings.directProvider = el.dataset.id; saveSettings(); renderComposer(); },
  'open-thread': (el) => { currentId = el.dataset.tid; closeDrawer(); renderAll(); scrollToBottom(); },
  'del-thread': (el) => {
    const i = threads.findIndex((t) => t.id === el.dataset.tid);
    if (i < 0) return;
    const [gone] = threads.splice(i, 1);
    if (currentId === gone.id) currentId = null;
    saveThreads();
    renderAll();
    undoToast('Conversation deleted', () => { threads.push(gone); saveThreads(); renderAll(); });
  },
  'new-thread': () => newThread(),
  copy: (el) => { const { msg } = findMsg(el.dataset.mid); if (msg) accepted(msg); if (msg) copy(msg.content + (credits(msg).length ? `\n\n— Elite AI · ${plainCredits(msg)}` : '')); },
  'copy-step': (el) => { const { msg } = findMsg(el.dataset.mid); const s = msg?.steps.find((x) => x.id === el.dataset.sid); if (s) copy(s.output); },
  share: async (el) => {
    const { msg } = findMsg(el.dataset.mid);
    if (!msg) return;
    accepted(msg);
    try { await navigator.share({ title: 'Elite AI answer', text: msg.content + `\n\n— Elite AI · ${plainCredits(msg)}` }); } catch { /* cancelled */ }
  },
  second: (el) => openSecondOpinion(el.dataset.mid),
  redo: (el) => followUp(el.dataset.mid, (ctx) => redoStep(ctx, el.dataset.sid, el.dataset.id)),
  'run-second': (el) => { closeSheet(); followUp(el.dataset.mid, (ctx) => secondOpinion(ctx, el.dataset.id)); },
  merge: (el) => followUp(el.dataset.mid, (ctx) => mergeCompare(ctx)),
  best: (el) => {
    const { msg } = findMsg(el.dataset.mid);
    if (!msg) return;
    const prev = msg.steps.find((s) => s.id === msg.best);
    if (prev) { scores[prev.provider] = { ...scores[prev.provider], best: Math.max(0, (scores[prev.provider]?.best || 0) - 1) }; signal(msg.id, prev.provider, 'best', -1); }
    const s = msg.steps.find((x) => x.id === el.dataset.sid);
    if (msg.best === s.id) msg.best = null;
    else { msg.best = s.id; scores[s.provider] = { ...scores[s.provider], best: (scores[s.provider]?.best || 0) + 1 }; signal(msg.id, s.provider, 'best', 1); }
    saveScores(); saveThreads(); scheduleMsg(msg);
  },
  'team-fb': (el) => {
    const { msg } = findMsg(el.dataset.mid);
    if (!msg) return;
    msg.feedback = msg.feedback === el.dataset.v ? null : el.dataset.v;
    teamFeedback(msg.id, el.dataset.v);
    saveThreads();
    scheduleMsg(msg);
  },
  'blind-vote': (el) => {
    const { msg } = findMsg(el.dataset.mid);
    if (!msg?.blind) return;
    msg.blind.verdict = el.dataset.v;
    blindResult(msg.id, el.dataset.v, msg.blind.provider);
    saveThreads();
    scheduleMsg(msg);
  },
  src: (el) => {
    const { msg } = findMsg(el.dataset.mid);
    if (!msg || !el.dataset.pid) return;
    msg.clicked ||= [];
    if (msg.clicked.includes(el.href)) return;
    msg.clicked.push(el.href);
    signal(msg.id, el.dataset.pid, 'source', 1);
    saveThreads();
  },
  netlog: () => openSheet('Network activity', netlogBody, { wide: true }),
  'local-load': () => loadPrivateModels('local'),
  'gw-load': () => loadPrivateModels('gw'),
  'all-five': () => {
    settings.allFive = !settings.allFive;
    saveSettings();
    renderComposer();
    toast(settings.allFive ? 'All five AIs will contribute on every task — slower and costs more.' : 'Back to evidence-based routing: only the AIs a task needs.', 3500);
  },
  'elite-index': () => { closeDrawer(); openSheet('Your Elite Index', indexBody, { wide: true }); },
  'index-export': () => download(`elite-ai-index-${today()}.json`, JSON.stringify(exportOutcomes(), null, 2)),
  'index-reset': (el) => {
    if (el.dataset.armed !== '1') { el.dataset.armed = '1'; el.textContent = 'Tap again to reset'; return; }
    resetOutcomes(); refreshSheet(); toast('Learning history reset.');
  },
  rate: (el) => {
    const { msg } = findMsg(el.dataset.mid);
    const s = msg && allCalls(msg).find((x) => x.id === el.dataset.sid);
    if (!s) return;
    const v = el.dataset.v;
    const sc = (scores[s.provider] ||= {});
    if (s.rating) { sc[s.rating] = Math.max(0, (sc[s.rating] || 0) - 1); signal(msg.id, s.provider, s.rating, -1); }
    s.rating = s.rating === v ? null : v;
    if (s.rating) { sc[s.rating] = (sc[s.rating] || 0) + 1; signal(msg.id, s.provider, s.rating, 1); }
    saveScores(); saveThreads(); scheduleMsg(msg);
  },
  'save-key': (el) => saveKey(el.dataset.id),
  'remove-key': (el) => {
    delete settings.keys[el.dataset.id];
    delete ui.keyMsg[el.dataset.id];
    saveSettings(); refreshSheet(); renderComposer(); renderFeed();
  },
  'load-models': (el) => ensureModels(el.dataset.id, true),
  install: async () => {
    if (!ui.installPrompt) return;
    ui.installPrompt.prompt();
    await ui.installPrompt.userChoice.catch(() => null);
    ui.installPrompt = null;
    renderComposer(); refreshSheet();
  },
  export: () => download(`elite-ai-conversations-${today()}.json`, JSON.stringify(threads, null, 2)),
  'clear-threads': (el) => {
    if (el.dataset.armed !== '1') { el.dataset.armed = '1'; el.textContent = 'Tap again to delete all'; return; }
    threads = []; currentId = null; saveThreads(); renderAll(); refreshSheet(); toast('All conversations deleted.');
  },
  'clear-keys': (el) => {
    if (el.dataset.armed !== '1') { el.dataset.armed = '1'; el.textContent = 'Tap again to remove all keys'; return; }
    settings.keys = {}; settings.models = {}; ui.keyMsg = {}; ui.models = {};
    saveSettings(); refreshSheet(); renderAll(); toast('All keys removed from this device.');
  },
  'fb-share': async () => { try { await navigator.share({ title: 'Elite AI feedback', text: feedbackText() }); } catch { /* cancelled */ } },
  'fb-copy': () => copy(feedbackText(), 'Feedback copied — paste it into a text or email.'),
};

function undoToast(text, undo) {
  const t = $('#toast');
  t.innerHTML = `${esc(text)} <button class="link" id="undo-btn">Undo</button>`;
  t.classList.add('show');
  $('#undo-btn').onclick = () => { undo(); t.classList.remove('show'); };
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 5000);
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = actions[el.dataset.act];
  if (!fn) return;
  if (el.tagName === 'A') { fn(el, e); return; }
  if (el.dataset.act !== 'close-sheet') e.preventDefault();
  fn(el, e);
});

document.addEventListener('change', (e) => {
  const el = e.target;
  const act = el.dataset.act;
  if (act === 'model') {
    const conn = connection(el.dataset.id, settings);
    settings.models[modelKey(el.dataset.id, conn.via)] = el.value;
    saveSettings();
  } else if (act === 'bench') {
    settings.off[el.dataset.id] = !el.checked;
    saveSettings(); renderComposer(); refreshSheet();
  } else if (act === 'role') {
    settings.roles[el.dataset.role] = el.value;
    saveSettings(); renderComposer();
  } else if (act === 'sealed') {
    settings.sealed = el.checked;
    saveSettings(); renderAll(); refreshSheet();
    toast(el.checked ? 'Sealed: the app can only reach your connected AIs.' : 'Sealed mode off.');
  } else if (act === 'local-on') {
    settings.local.on = el.checked;
    saveSettings(); renderAll(); refreshSheet();
    if (el.checked && !Object.values(settings.local.models).some(Boolean)) toast('Click "Find models" to fill the seats from your local AI.', 3500);
  } else if (act === 'gw-on') {
    settings.gateway.on = el.checked;
    saveSettings(); renderAll(); refreshSheet();
  } else if (act === 'local-url') {
    settings.local.url = el.value.trim(); saveSettings();
  } else if (act === 'gw-url') {
    settings.gateway.url = el.value.trim(); saveSettings();
  } else if (act === 'gw-key') {
    if (el.value.trim()) { settings.gateway.key = el.value.trim(); saveSettings(); }
  } else if (act === 'local-model' || act === 'gw-model') {
    const bag = act === 'local-model' ? settings.local.models : settings.gateway.models;
    if (el.value.trim()) bag[el.dataset.id] = el.value.trim(); else delete bag[el.dataset.id];
    saveSettings(); renderComposer();
  } else if (act === 'hrounds') {
    settings.huddleRounds = Number(el.value) || 3; saveSettings(); renderComposer();
  } else if (act === 'lchecks') {
    settings.learningChecks = el.value;
    saveSettings();
  } else if (act === 'osearch') {
    settings.openaiSearch = el.checked;
    saveSettings();
  } else if (act === 'gsearch') {
    settings.geminiSearch = el.checked;
    saveSettings();
  } else if (act === 'audit-depth') {
    ui.audit.full = el.value === 'full';
    refreshSheet();
  } else if (act === 'audit-team') {
    ui.audit.team = el.checked;
    refreshSheet();
  } else if (act === 'cap') {
    settings.dailyCap = Math.max(0, Number(el.value) || 0);
    saveSettings(); renderComposer();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (ui.sheet) closeSheet(); else closeDrawer(); }
  if (e.key === 'Enter' && e.target.matches('.prov input[type=password]')) {
    e.preventDefault();
    saveKey(e.target.dataset.field.replace('key-', ''));
  }
});

// Remember which collapsible sections are open across live re-renders.
document.addEventListener('toggle', (e) => {
  const key = e.target.dataset?.key;
  if (!key) return;
  if (e.target.open) ui.open.add(key); else ui.open.delete(key);
}, true);

function init() {
  document.querySelectorAll('.modes button').forEach((b) => b.addEventListener('click', () => {
    settings.mode = b.dataset.mode;
    saveSettings();
    renderModes();
    renderComposer();
    $('#mode-hint').textContent = MODES[settings.mode].hint;
  }));
  $('#mode-hint').textContent = MODES[settings.mode].hint;
  $('#btn-threads').addEventListener('click', () => (document.body.classList.contains('drawer-open') ? closeDrawer() : openDrawer()));
  $('#drawer-scrim').addEventListener('click', closeDrawer);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#install-btn').addEventListener('click', () => actions.install());

  const input = $('#input');
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !isTouch && !e.isComposing) {
      e.preventDefault();
      send(input.value);
    }
  });
  $('#composer-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (ui.controller) ui.controller.abort();
    else send(input.value);
  });

  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    ui.installPrompt = e;
    renderComposer();
    refreshSheet();
  });
  addEventListener('appinstalled', () => { ui.installPrompt = null; renderComposer(); toast('Elite AI installed ✓'); });

  renderAll();
  scrollToBottom();
  if (!isSealed()) loadPrices();
  // Pick a default model for any connection that doesn't have one yet (lists are free to fetch).
  for (const p of PROVIDERS) {
    const conn = connection(p.id, settings);
    if (conn && !conn.model && !settings.models[modelKey(p.id, conn.via)]) ensureModels(p.id);
  }

  if (!settings.welcomed) {
    settings.welcomed = true;
    saveSettings();
    welcome();
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
  }
}

init();
