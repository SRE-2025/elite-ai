// Every AI Elite AI works with, what each is championed for, and how to talk to it.
// Calls go straight from this device to each AI company — keys never pass through an Elite AI server.

import { store } from './store.js';

// "champion" is what the planner reads when it assigns work, so it follows public evidence,
// not marketing. Last reviewed against the leaderboards in EVIDENCE.sources on EVIDENCE.date;
// a Champion Audit on the user's own keys can override it.
export const EVIDENCE = {
  date: 'October 20, 2026',
  note: 'Leaderboards mostly test models at maximum effort settings, which can differ from everyday API defaults.',
  // Public-evidence pick per task type (the starting point before audits and personal results).
  bestFor: { research: 'openai', writing: 'anthropic', coding: 'anthropic', math: 'google', factcheck: 'google', longdoc: 'anthropic', planning: 'anthropic', critique: 'google', translation: 'google', general: 'anthropic' },
  sources: [
    ['LMArena (text, WebDev, Search, Agent arenas)', 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset'],
    ['Artificial Analysis (intelligence, long context, hallucination, cost)', 'https://artificialanalysis.ai/leaderboards/models'],
    ['LiveBench', 'https://livebench.ai'],
    ['OpenRouter model catalog (prices)', 'https://openrouter.ai/models'],
  ],
};

const ALL_PROVIDERS = [
  {
    id: 'openai', name: 'ChatGPT', company: 'OpenAI', color: '#19c37d', mark: 'GP',
    champion: 'Live web research (with web search), plus best-value all-round work',
    evidence: 'GPT-6.1 Sol: #2 on Search Arena with style control (#8 raw, #5 on search factuality); an OpenAI model is #1 in all three views (Oct 13). Lowest cost per task among the top models (Artificial Analysis).',
    api: 'openai', base: 'https://api.openai.com/v1', orPrefix: 'openai/', orFallback: 'gpt-6.1-sol',
    fallbackModel: 'gpt-6.1-sol',
    prefer: [/^gpt-\d+(\.\d+)?-sol$/, /^gpt-\d+(\.\d+)?$/, /^gpt-\d+(\.\d+)?-terra$/, /^gpt-\d/],
    exclude: /(audio|realtime|tts|transcribe|whisper|embed|image|dall-e|moderation|search|computer|codex|babbage|davinci|instruct|oss|sora|batch)/i,
    keyUrl: 'https://platform.openai.com/api-keys', usageUrl: 'https://platform.openai.com/usage', productUrl: 'https://chatgpt.com',
  },
  {
    id: 'anthropic', name: 'Claude', company: 'Anthropic', color: '#e0805f', mark: 'Cl',
    champion: 'Coding, writing, planning and long-document analysis',
    evidence: 'Claude Opus 5.5: #1 WebDev Arena, #1 creative writing, #1 Agent Arena steerability, #1 long-context reasoning (AA-LCR). Sonnet ranks far lower on writing, so Opus is the default.',
    api: 'anthropic', base: 'https://api.anthropic.com/v1', orPrefix: 'anthropic/', orFallback: 'claude-opus-5.5',
    fallbackModel: 'claude-opus-5-5',
    prefer: [/opus/, /sonnet/, /haiku/],
    keyUrl: 'https://console.anthropic.com/settings/keys', usageUrl: 'https://console.anthropic.com/settings/usage', productUrl: 'https://claude.ai',
  },
  {
    id: 'google', name: 'Gemini', company: 'Google', color: '#5b8def', mark: 'Ge',
    champion: 'Fact-checking (lowest hallucination rate), math & reasoning, multilingual and translation, precise instruction following',
    evidence: 'Gemini 4 Argon: lowest hallucination rate measured (15%, AA-Omniscience); #1 Arena math, instruction following and non-English. Newer model with fewer votes, so ranks may move.',
    api: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta', orPrefix: 'google/', orFallback: 'gemini-4-argon',
    fallbackModel: 'gemini-4-argon',
    prefer: [/^gemini-\d+(\.\d+)?-(argon|pro)$/, /^gemini-\d+(\.\d+)?-(argon|pro)/, /^gemini-\d+(\.\d+)?-flash$/, /^gemini-/],
    exclude: /(image|banana|lyria|veo|imagen|embed|aqa|tts|audio|live|gemma|learnlm|robotics|computer|nano)/i,
    keyUrl: 'https://aistudio.google.com/app/apikey', usageUrl: 'https://aistudio.google.com/', productUrl: 'https://gemini.google.com',
  },
  {
    id: 'perplexity', name: 'Perplexity', company: 'Perplexity', color: '#2cc4d6', mark: 'Px', reserve: true,
    champion: 'Quick web lookups with citations (backup researcher)',
    evidence: 'Sonar Pro dates from March 2025 and ranks #37–39 of 42 on Search Arena (Oct 13), so ChatGPT with web search now leads research.',
    api: 'openai', base: 'https://api.perplexity.ai', orPrefix: 'perplexity/', orFallback: 'sonar-pro',
    fallbackModel: 'sonar-pro',
    staticModels: ['sonar-pro', 'sonar', 'sonar-reasoning-pro', 'sonar-deep-research'],
    prefer: [/^sonar-pro$/, /^sonar$/],
    keyUrl: 'https://www.perplexity.ai/settings/api', usageUrl: 'https://www.perplexity.ai/settings/api', productUrl: 'https://www.perplexity.ai',
  },
  {
    id: 'xai', name: 'Grok', company: 'xAI', color: '#c9ced8', mark: 'Gk',
    champion: 'Candid alternative perspectives, with a low hallucination rate',
    evidence: 'Grok 4.7: second-lowest hallucination rate (29%, AA-Omniscience). No public benchmark yet measures critique, so it is not the default Challenger.',
    api: 'openai', base: 'https://api.x.ai/v1', orPrefix: 'x-ai/', orFallback: 'grok-4.7',
    fallbackModel: 'grok-4.7',
    prefer: [/^grok-\d+([.-]\d+)?$/, /^grok-\d/, /^grok/],
    exclude: /(image|imagine|vision|video|embed|build|code|multi-agent)/i,
    keyUrl: 'https://console.x.ai', usageUrl: 'https://console.x.ai', productUrl: 'https://grok.com',
  },
  {
    id: 'mistral', name: 'Mistral', company: 'Mistral AI', color: '#ff7a33', mark: 'Mi', reserve: true,
    champion: 'Low-cost drafting from an EU-based AI company',
    evidence: 'Mistral Large 4 trails the other models on recent public leaderboards, including non-English (#108 on Arena).',
    api: 'openai', base: 'https://api.mistral.ai/v1', orPrefix: 'mistralai/', orFallback: 'mistral-large-4-0',
    fallbackModel: 'mistral-large-latest',
    prefer: [/^mistral-large-latest$/, /^mistral-large/, /^mistral-medium-latest$/, /^mistral-medium/],
    exclude: /(embed|ocr|moderation|voxtral|transcribe)/i,
    keyUrl: 'https://console.mistral.ai/api-keys', usageUrl: 'https://console.mistral.ai/usage', productUrl: 'https://chat.mistral.ai',
  },
  {
    id: 'deepseek', name: 'DeepSeek', company: 'DeepSeek', color: '#6f86ff', mark: 'DS',
    champion: 'Fastest, lowest-cost drafts for math and code. Not for factual claims (very high hallucination rate).',
    evidence: 'DeepSeek V4.1 Flash: about 209 tokens/s at very low cost; hallucination rate 94–97% (AA-Omniscience).',
    api: 'openai', base: 'https://api.deepseek.com', orPrefix: 'deepseek/', orFallback: 'deepseek-v4-pro-0813',
    fallbackModel: 'deepseek-chat',
    prefer: [/^deepseek-chat$/, /-pro(-\d{4})?$/, /flash(-\d{4})?$/, /^deepseek/],
    exclude: /(vision|ocr|prover)/i,
    keyUrl: 'https://platform.deepseek.com/api_keys', usageUrl: 'https://platform.deepseek.com/usage', productUrl: 'https://chat.deepseek.com',
  },
];

// The Elite 5: only the AIs the evidence supports are on the team. Reserves keep their adapters
// (and old conversations keep their credits) so a future review can promote them back.
export const PROVIDERS = ALL_PROVIDERS.filter((p) => !p.reserve);
export const RESERVES = ALL_PROVIDERS.filter((p) => p.reserve);
export const P = Object.fromEntries(ALL_PROVIDERS.map((p) => [p.id, p]));

export const OPENROUTER = {
  name: 'OpenRouter',
  base: 'https://openrouter.ai/api/v1',
  keyUrl: 'https://openrouter.ai/settings/keys',
  creditsUrl: 'https://openrouter.ai/settings/credits',
};

// ---- Connections -------------------------------------------------------------

// A provider's own key wins; otherwise an OpenRouter key can reach it.
export function connection(id, settings) {
  const keys = settings.keys || {};
  if (keys[id]) return { via: 'direct', key: keys[id] };
  if (keys.openrouter) return { via: 'openrouter', key: keys.openrouter };
  return null;
}

export const isOn = (id, settings) => !!connection(id, settings) && !settings.off?.[id];
export const available = (settings) => PROVIDERS.filter((p) => isOn(p.id, settings)).map((p) => p.id);

export const modelKey = (id, via) => `${id}:${via}`;

// Which AIs can look things up live. Perplexity always searches; ChatGPT uses OpenAI's web search
// tool (or OpenRouter's web plugin) and Gemini uses Google Search grounding, each when switched on.
// Everyone else answers from training data.
export function hasWeb(id, settings) {
  if (id === 'perplexity') return true;
  if (id === 'openai') return settings.openaiSearch !== false;
  if (id === 'google') return !!settings.geminiSearch;
  return false;
}

export function modelFor(id, settings) {
  const conn = connection(id, settings);
  if (!conn) return null;
  const saved = settings.models?.[modelKey(id, conn.via)];
  if (saved) return saved;
  return conn.via === 'openrouter' ? P[id].orPrefix + P[id].orFallback : P[id].fallbackModel;
}

const anthropicHeaders = (key) => ({
  'content-type': 'application/json',
  'x-api-key': key,
  'anthropic-version': '2023-06-01',
  'anthropic-dangerous-direct-browser-access': 'true',
});

// ---- Model lists ---------------------------------------------------------------

let catalogPromise = null;
// OpenRouter's public catalog (no key needed): model ids + prices across every company.
export function openRouterCatalog() {
  catalogPromise ||= fetch(OPENROUTER.base + '/models')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('catalog ' + r.status))))
    .then((j) => j.data || [])
    .catch((e) => { catalogPromise = null; throw e; });
  return catalogPromise;
}

const baseName = (p, via) => (m) => (via === 'openrouter' ? m.id.slice(p.orPrefix.length) : m.id);
const newestFirst = (name) => (a, b) => (b.created || 0) - (a.created || 0) || name(b).localeCompare(name(a), undefined, { numeric: true });

export async function listModels(id, settings) {
  const p = P[id];
  const conn = connection(id, settings);
  if (!conn) throw new Error(`Add a key for ${p.name} first.`);
  const name = baseName(p, conn.via);
  let list;

  if (conn.via === 'openrouter') {
    const all = await openRouterCatalog();
    list = all.filter((m) => m.id.startsWith(p.orPrefix) && !m.id.includes(':')).map((m) => ({ id: m.id, created: m.created }));
  } else if (p.staticModels) {
    list = p.staticModels.map((m) => ({ id: m }));
  } else {
    let url = p.base + '/models';
    let headers = { Authorization: 'Bearer ' + conn.key };
    if (p.api === 'anthropic') { url += '?limit=100'; headers = anthropicHeaders(conn.key); }
    if (p.api === 'gemini') { url += '?pageSize=1000'; headers = { 'x-goog-api-key': conn.key }; }
    const res = await fetch(url, { headers });
    if (!res.ok) throw await apiError(res, p.name);
    const j = await res.json();
    if (p.api === 'gemini') {
      list = (j.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => ({ id: m.name.replace(/^models\//, '') }));
    } else {
      list = (j.data || []).map((m) => ({
        id: m.id,
        created: typeof m.created_at === 'string' ? Date.parse(m.created_at) / 1000 : m.created,
      }));
    }
  }
  return list.filter((m) => !p.exclude || !p.exclude.test(name(m))).sort(newestFirst(name));
}

// Picks a strong, sensibly priced default: the newest model in the provider's preferred family.
export function autoPick(id, via, list) {
  const p = P[id];
  const name = baseName(p, via);
  for (const re of p.prefer) {
    const hit = list.filter((m) => re.test(name(m)));
    if (hit.length) return hit.sort(newestFirst(name))[0].id;
  }
  return list[0]?.id || null;
}

// ---- Prices (estimates, from OpenRouter's public catalog) -----------------------

let prices = store.read('prices', null);

export async function loadPrices() {
  if (prices && Date.now() - prices.at < 12 * 3600e3) return;
  try {
    const all = await openRouterCatalog();
    const map = {};
    for (const m of all) {
      if (!m.id.includes(':') && PROVIDERS.some((p) => m.id.startsWith(p.orPrefix))) {
        map[m.id] = [Number(m.pricing?.prompt) || 0, Number(m.pricing?.completion) || 0];
      }
    }
    prices = { at: Date.now(), map };
    store.write('prices', prices);
  } catch { /* offline — costs show as unknown */ }
}

function catalogIds(p, model) {
  const m = model.replace(/^models\//, '');
  const noDate = m.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, '');
  const dotted = noDate.replace(/(\d)-(\d)(?!\d)/g, '$1.$2');
  return [...new Set([m, noDate, dotted])].map((x) => p.orPrefix + x);
}

function priceFor(id, model, via) {
  if (!prices || !model) return null;
  const ids = via === 'openrouter' ? [model] : catalogIds(P[id], model);
  for (const c of ids) if (prices.map[c]) return prices.map[c];
  return null;
}

// [input $/token, output $/token] for the model this AI currently uses, or null if unknown.
export function priceOf(id, settings) {
  const conn = connection(id, settings);
  return conn ? priceFor(id, modelFor(id, settings), conn.via) : null;
}

export function estimateCost(id, model, via, usage) {
  const pr = usage ? priceFor(id, model, via) : null;
  return pr ? (usage.in || 0) * pr[0] + (usage.out || 0) * pr[1] : null;
}

// ---- Errors ----------------------------------------------------------------------

async function apiError(res, name) {
  let detail = '';
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t);
      const e = Array.isArray(j) ? j[0]?.error : j.error;
      detail = e?.message || (typeof e === 'string' ? e : '') || j.message || j.detail || t;
    } catch { detail = t; }
  } catch { /* no body */ }
  detail = String(typeof detail === 'string' ? detail : JSON.stringify(detail)).replace(/\s+/g, ' ').slice(0, 240);
  const badKey = /api[ -_]?key|unauthori[sz]ed|authentication|permission denied/i.test(detail) && res.status < 500;
  const hint = badKey ? 'The key was rejected — check it in Settings.' : {
    400: 'The request was refused.',
    401: 'The key was rejected — check it in Settings.',
    402: 'Out of credits — add billing with this AI company.',
    403: 'The key isn’t allowed to do this — check its permissions.',
    404: 'Model not found — pick another model in Settings.',
    429: 'Rate or spending limit reached — wait a moment or check billing.',
  }[res.status] || '';
  const err = new Error(`${name}: ${hint || 'Error ' + res.status}${detail ? ` (${detail})` : ''}`);
  err.status = res.status;
  return err;
}

// ---- Chat ------------------------------------------------------------------------

async function readSSE(res, onData) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      onData(j);
    }
  }
}

function addCitation(out, url, title) {
  if (!url || !/^https?:\/\//.test(url) || out.citations.some((c) => c.url === url)) return;
  out.citations.push({ url, title: title || '' });
}

function takeExtras(j, out, delta) {
  const u = j.usage;
  if (u) {
    out.usage.in = u.prompt_tokens ?? u.input_tokens ?? out.usage.in;
    out.usage.out = u.completion_tokens ?? u.output_tokens ?? out.usage.out;
    if (typeof u.cost === 'number') out.reportedCost = u.cost;
  }
  for (const c of j.citations || []) addCitation(out, typeof c === 'string' ? c : c.url, c.title);
  for (const s of j.search_results || []) addCitation(out, s.url, s.title);
  const notes = delta?.annotations || j.choices?.[0]?.message?.annotations || [];
  for (const a of notes) if (a.url_citation) addCitation(out, a.url_citation.url, a.url_citation.title);
}

const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((x) => (x.type === 'text' || !x.type ? x.text || '' : '')).join('') : '');

async function openaiCompat({ url, key, model, system, messages, emit, out, signal, headers = {}, includeUsage, name, extra }) {
  const body = { model, messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages], stream: true, ...extra };
  if (includeUsage) body.stream_options = { include_usage: true };
  const init = () => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, ...headers },
    body: JSON.stringify(body),
    signal,
  });
  const res = await fetch(url, init());
  if (!res.ok) {
    const err = await apiError(res, name);
    // Some models only stream for verified organizations — fall back to a single response.
    if (res.status === 400 && /stream|verif/i.test(err.message)) {
      delete body.stream;
      delete body.stream_options;
      const again = await fetch(url, init());
      if (!again.ok) throw await apiError(again, name);
      const j = await again.json();
      emit(textOf(j.choices?.[0]?.message?.content));
      takeExtras(j, out);
      return;
    }
    throw err;
  }
  await readSSE(res, (j) => {
    if (j.error) throw new Error(`${name}: ${j.error.message || 'stream error'}`);
    const delta = j.choices?.[0]?.delta;
    if (delta?.content) emit(textOf(delta.content));
    takeExtras(j, out, delta);
  });
}

// OpenAI's Responses API with the web search tool — used only for steps that need current facts.
function takeResponse(r, emit, out) {
  for (const item of r?.output || []) {
    for (const c of item.content || []) {
      if (c.type !== 'output_text') continue;
      if (emit) emit(c.text);
      for (const a of c.annotations || []) if (a.type === 'url_citation') addCitation(out, a.url, a.title);
    }
  }
  if (r?.usage) {
    out.usage.in = r.usage.input_tokens ?? out.usage.in;
    out.usage.out = r.usage.output_tokens ?? out.usage.out;
  }
}

async function openaiWebSearch({ key, model, system, messages, emit, out, signal }) {
  const url = P.openai.base + '/responses';
  const body = { model, input: messages.map((m) => ({ role: m.role, content: m.content })), tools: [{ type: 'web_search' }], stream: true };
  if (system) body.instructions = system;
  const init = () => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify(body),
    signal,
  });
  let res = await fetch(url, init());
  if (!res.ok && res.status === 400) {
    const err = await apiError(res, 'ChatGPT');
    if (/stream|verif/i.test(err.message)) {
      delete body.stream; // unverified organizations can't stream some models
      res = await fetch(url, init());
      if (!res.ok) throw await apiError(res, 'ChatGPT');
      takeResponse(await res.json(), emit, out);
      return;
    }
    if (!/web_search|tool/i.test(err.message)) throw err;
    body.tools = [{ type: 'web_search_preview' }]; // older name for the same tool
    res = await fetch(url, init());
  }
  if (!res.ok) throw await apiError(res, 'ChatGPT');
  await readSSE(res, (j) => {
    if (j.type === 'response.output_text.delta') emit(j.delta);
    else if (j.type === 'response.output_text.annotation.added') addCitation(out, j.annotation?.url, j.annotation?.title);
    else if (j.type === 'response.completed') takeResponse(j.response, null, out);
    else if (j.type === 'error' || j.type === 'response.failed') {
      throw new Error('ChatGPT: ' + (j.error?.message || j.message || j.response?.error?.message || 'web search failed'));
    }
  });
}

async function anthropicChat({ key, model, system, messages, emit, out, signal, maxTokens }) {
  const body = { model, max_tokens: maxTokens, messages, stream: true };
  if (system) body.system = system;
  const res = await fetch(P.anthropic.base + '/messages', {
    method: 'POST', headers: anthropicHeaders(key), body: JSON.stringify(body), signal,
  });
  if (!res.ok) throw await apiError(res, 'Claude');
  await readSSE(res, (j) => {
    if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') emit(j.delta.text);
    else if (j.type === 'message_start') out.usage.in = j.message?.usage?.input_tokens || 0;
    else if (j.type === 'message_delta' && j.usage) out.usage.out = j.usage.output_tokens || out.usage.out;
    else if (j.type === 'error') throw new Error('Claude: ' + (j.error?.message || 'stream error'));
  });
}

async function geminiChat({ key, model, system, messages, emit, out, signal, search }) {
  const url = `${P.google.base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const body = { contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })) };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (search) body.tools = [{ google_search: {} }];
  const init = () => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal,
  });
  let res = await fetch(url, init());
  if (!res.ok && search && res.status === 400) {
    delete body.tools; // model without Google Search grounding — answer without it
    res = await fetch(url, init());
  }
  if (!res.ok) throw await apiError(res, 'Gemini');
  await readSSE(res, (j) => {
    if (j.error) throw new Error('Gemini: ' + (j.error.message || 'stream error'));
    const c = j.candidates?.[0];
    for (const part of c?.content?.parts || []) if (part.text && !part.thought) emit(part.text);
    for (const g of c?.groundingMetadata?.groundingChunks || []) addCitation(out, g.web?.uri, g.web?.title);
    const u = j.usageMetadata;
    if (u) {
      out.usage.in = u.promptTokenCount || out.usage.in;
      out.usage.out = (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) || out.usage.out;
    }
  });
}

/**
 * Send one conversation to one AI and stream the reply.
 * Returns { text, usage:{in,out}, citations:[{url,title}], model, via, ms, cost }.
 */
export async function chat(id, settings, { system = '', messages, onToken, signal, maxTokens = 8000, search = false }) {
  const p = P[id];
  const conn = connection(id, settings);
  if (!conn) throw new Error(`${p.name} isn’t connected — add a key in Settings.`);
  const model = modelFor(id, settings);
  const t0 = performance.now();
  const out = { text: '', usage: { in: 0, out: 0 }, citations: [], model, via: conn.via, provider: id };
  const emit = (t) => {
    if (!t) return;
    out.text += t;
    onToken?.(t, out.text);
  };
  const args = { key: conn.key, model, system, messages, emit, out, signal, maxTokens, search };

  const send = async () => {
  if (conn.via === 'openrouter') {
    await openaiCompat({
      ...args,
      url: OPENROUTER.base + '/chat/completions',
      headers: { 'HTTP-Referer': location.origin, 'X-Title': 'Elite AI' },
      includeUsage: true,
      name: `${p.name} (via OpenRouter)`,
      // OpenRouter's web plugin gives search to models that don't search on their own.
      extra: search && id !== 'perplexity' ? { plugins: [{ id: 'web' }] } : undefined,
    });
  } else if (id === 'openai' && search) {
    try {
      await openaiWebSearch(args);
    } catch (e) {
      // If web search isn't available on this key, still answer — and say it wasn't live.
      if (e.name === 'AbortError' || out.text) throw e;
      out.note = 'Web search unavailable (' + e.message.slice(0, 120) + ') — answered without it.';
      await openaiCompat({ ...args, url: p.base + '/chat/completions', includeUsage: true, name: p.name });
    }
  } else if (p.api === 'anthropic') {
    await anthropicChat(args);
  } else if (p.api === 'gemini') {
    await geminiChat({ ...args, search: search && hasWeb(id, settings) });
  } else {
    await openaiCompat({ ...args, url: p.base + '/chat/completions', includeUsage: id === 'openai', name: p.name });
  }
  };

  // One automatic retry for brief overloads (rate limits, server errors, dropped connections),
  // but never once an answer has started streaming, and never for a rejected key.
  for (let attempt = 0; ; attempt++) {
    try {
      await send();
      break;
    } catch (e) {
      const transient = e.status === 429 || e.status >= 500 || e instanceof TypeError;
      if (attempt >= 1 || out.text || e.name === 'AbortError' || !transient) throw e;
      out.retried = true;
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 1500);
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
      });
    }
  }

  out.ms = Math.round(performance.now() - t0);
  out.cost = out.reportedCost ?? estimateCost(id, model, conn.via, out.usage);
  if (!out.text.trim()) throw new Error(`${p.name} returned an empty answer.`);
  return out;
}
