// TIA tester page. Settings come from the page URL (shareable), then localStorage, then defaults.
// Requests to TIA go through the tester server's /probe (see server.mjs).

const SETTINGS_KEY = 'tia-tester:settings';
const QUESTIONS_KEY = 'tia-tester:questions';
const DEFAULTS = {
  url: '',
  employee_id: '',
  employee_name: '',
  api_base: '',
  mode: 'loader',
  mock: false,
  insecure: true,
};
const FRAME_SIZES = {
  widget: [420, 580],
  phone: [390, 760],
  tall: [420, 820],
};

const $ = (selector) => document.querySelector(selector);
const form = $('#target-form');
let settings = readSettings();
let questions = [];
let results = [];
let isRunning = false;

// ---------------------------------------------------------------- helpers
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in node && typeof value !== 'string') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

function readStored(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: settings still work for this visit.
  }
}

function readSettings() {
  const fromUrl = Object.fromEntries(new URLSearchParams(location.search));
  const base = { ...DEFAULTS, ...(readStored(SETTINGS_KEY) ?? {}) };
  if (Object.keys(fromUrl).length === 0) return base;
  return {
    ...base,
    ...fromUrl,
    mock: fromUrl.mock === '1' || (fromUrl.mock === undefined && base.mock),
    insecure: fromUrl.insecure === undefined ? base.insecure : fromUrl.insecure !== '0',
  };
}

function shareUrl() {
  const params = new URLSearchParams();
  for (const key of ['url', 'employee_id', 'employee_name', 'api_base', 'mode']) {
    if (settings[key]) params.set(key, settings[key]);
  }
  if (settings.mock) params.set('mock', '1');
  if (!settings.insecure) params.set('insecure', '0');
  return `${location.origin}${location.pathname}?${params}`;
}

const trimSlash = (url) => String(url || '').replace(/\/+$/, '');
const apiBase = () => trimSlash(settings.api_base || settings.url);

async function probe(baseUrl, path, { method = 'GET', body } = {}) {
  try {
    const res = await fetch('/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, path, method, body, insecure: settings.insecure }),
    });
    return await res.json();
  } catch (error) {
    return { ok: false, error: `Tester server unreachable: ${error.message}` };
  }
}

function chat(message, conversationId = null) {
  return probe(apiBase(), '/api/v1/tia/chat', {
    method: 'POST',
    body: {
      message,
      employee_id: settings.employee_id,
      conversation_id: conversationId,
      language: $('#language').value,
      channel: 'widget',
    },
  });
}

function errorText(result) {
  if (result.error) return result.error;
  const detail = result.body?.detail;
  if (Array.isArray(detail)) return detail.map((item) => item.msg).join('; ');
  if (detail) return String(detail);
  return `HTTP ${result.status}`;
}

const badge = (state) =>
  el(
    'span',
    { className: `badge badge--${state}`, 'aria-label': state },
    { pass: '✓', warn: '!', fail: '✕', pending: '•', idle: '–' }[state],
  );

// ---------------------------------------------------------------- settings form
function fillForm() {
  for (const [key, value] of Object.entries(settings)) {
    const field = form.elements[key];
    if (!field) continue;
    if (field instanceof RadioNodeList) field.value = value;
    else if (field.type === 'checkbox') field.checked = Boolean(value);
    else field.value = value;
  }
  $('#open-target').href = settings.url || '#';
}

function readForm() {
  const data = new FormData(form);
  return {
    url: trimSlash(data.get('url')),
    employee_id: String(data.get('employee_id') || '').trim(),
    employee_name: String(data.get('employee_name') || '').trim(),
    api_base: trimSlash(data.get('api_base')),
    mode: data.get('mode') || 'loader',
    mock: data.get('mock') === 'on',
    insecure: data.get('insecure') === 'on',
  };
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  settings = readForm();
  store(SETTINGS_KEY, settings);
  history.replaceState(null, '', shareUrl());
  fillForm();
  runChecks();
  loadWidget();
});

$('#copy-link').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(shareUrl());
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Copy failed';
  }
  setTimeout(() => (button.textContent = 'Copy share link'), 1500);
});

// ---------------------------------------------------------------- deployment checks
const CHECKS = [
  {
    title: 'Health',
    async run() {
      const result = await probe(apiBase(), '/health');
      if (!result.ok) return { state: 'fail', detail: errorText(result), ms: result.ms };
      const health = result.body ?? {};
      const off = Object.entries(health.phases ?? {})
        .filter(([, on]) => !on)
        .map(([phase]) => phase);
      const parts = [
        health.environment,
        [health.ai_provider, health.model].filter(Boolean).join(' · '),
        health.auth_mode && `auth: ${health.auth_mode}`,
        health.default_tenant && `tenant: ${health.default_tenant}`,
      ].filter(Boolean);
      if (off.length) parts.push(`phases off: ${off.join(', ')}`);
      return {
        state: health.status === 'ok' && off.length === 0 ? 'pass' : 'warn',
        detail: parts.join(' — ') || 'OK',
        ms: result.ms,
      };
    },
  },
  {
    title: 'Widget page',
    async run() {
      const path = `/widget/${encodeURIComponent(settings.employee_id)}`;
      const result = await probe(settings.url, path);
      if (!result.ok) return { state: 'fail', detail: errorText(result), ms: result.ms };
      const isApp = String(result.text ?? '').includes('id="root"');
      const xfo = result.headers?.['x-frame-options'];
      const csp = result.headers?.['content-security-policy'] ?? '';
      const blocksFrames = Boolean(xfo) || /frame-ancestors\s+'none'/.test(csp);
      if (!isApp) return { state: 'fail', detail: 'Page is not the TIA widget app', ms: result.ms };
      return {
        state: blocksFrames ? 'warn' : 'pass',
        detail: blocksFrames
          ? `Served, but may block embedding (${xfo ? `X-Frame-Options: ${xfo}` : 'CSP frame-ancestors'})`
          : `Served (${result.bytes} bytes), embeddable`,
        ms: result.ms,
      };
    },
  },
  {
    title: 'Widget loader script',
    async run() {
      const result = await probe(settings.url, '/widget-loader.js');
      if (!result.ok) return { state: 'fail', detail: errorText(result), ms: result.ms };
      const isScript = /javascript/.test(result.headers?.['content-type'] ?? '');
      return {
        state: isScript ? 'pass' : 'warn',
        detail: isScript
          ? `Served (${result.bytes} bytes)`
          : `Served as ${result.headers?.['content-type'] || 'unknown type'}`,
        ms: result.ms,
      };
    },
  },
  {
    title: 'Chat API',
    async run() {
      const result = await chat('Hello');
      if (!result.ok) return { state: 'fail', detail: errorText(result), ms: result.ms };
      const reply = result.body ?? {};
      if (!reply.answer) return { state: 'fail', detail: 'Answered without text', ms: result.ms };
      return {
        state: reply.authorization === 'DENY' ? 'warn' : 'pass',
        detail: `${reply.intent ?? 'no intent'} · ${reply.authorization ?? '—'} · “${reply.answer.slice(0, 90)}”`,
        ms: result.ms,
      };
    },
  },
];

async function runChecks() {
  if (!settings.url || !settings.employee_id) return;
  const list = $('#checks');
  const status = $('#target-status');
  status.dataset.state = 'busy';
  status.textContent = 'Checking…';
  const rows = CHECKS.map((check) => {
    const row = el(
      'li',
      { className: 'check-row' },
      badge('pending'),
      el(
        'div',
        {},
        el('p', { className: 'check-row__title' }, check.title),
        el('p', { className: 'check-row__detail' }, 'Running…'),
      ),
      el('span', { className: 'check-row__ms' }, ''),
    );
    return row;
  });
  list.replaceChildren(...rows);

  const outcomes = await Promise.all(
    CHECKS.map(async (check, index) => {
      const outcome = await check.run().catch((error) => ({ state: 'fail', detail: error.message }));
      const row = rows[index];
      row.firstChild.replaceWith(badge(outcome.state));
      row.querySelector('.check-row__detail').textContent = outcome.detail;
      row.querySelector('.check-row__ms').textContent = outcome.ms != null ? `${outcome.ms} ms` : '';
      return outcome.state;
    }),
  );

  const worst = outcomes.includes('fail') ? 'fail' : outcomes.includes('warn') ? 'warn' : 'ok';
  status.dataset.state = worst;
  status.textContent = { ok: 'All checks passed', warn: 'Passed with warnings', fail: 'Checks failed' }[
    worst
  ];
}

$('#run-checks').addEventListener('click', runChecks);

// ---------------------------------------------------------------- question suite
async function loadQuestions() {
  const saved = readStored(QUESTIONS_KEY);
  if (Array.isArray(saved) && saved.length) return saved;
  try {
    const data = await (await fetch('/questions.json')).json();
    return data.questions.map((item) => ({ ...item, selected: true }));
  } catch {
    return [];
  }
}

function saveQuestions() {
  store(
    QUESTIONS_KEY,
    questions.map(({ question, expectPresentation, selected }) => ({
      question,
      expectPresentation,
      selected,
    })),
  );
}

function renderSuite() {
  const list = $('#suite');
  if (questions.length === 0) {
    list.replaceChildren(el('li', { className: 'empty' }, 'No questions. Add one above.'));
    return;
  }
  list.replaceChildren(
    ...questions.map((item, index) => {
      const result = results[index];
      return el(
        'li',
        { className: 'suite-row' },
        el('input', {
          type: 'checkbox',
          checked: item.selected !== false,
          'aria-label': `Include “${item.question}”`,
          disabled: isRunning,
          onChange: (event) => {
            item.selected = event.target.checked;
            saveQuestions();
          },
        }),
        badge(result?.state ?? 'idle'),
        el(
          'div',
          {},
          el('p', { className: 'suite-row__question' }, item.question),
          item.expectPresentation &&
            !result &&
            el('div', { className: 'suite-row__meta' }, el('span', { className: 'tag' }, `expects ${item.expectPresentation}`)),
          result && renderResult(result, item),
        ),
        el('span', { className: 'suite-row__ms' }, result?.ms != null ? `${result.ms} ms` : ''),
        el(
          'button',
          {
            type: 'button',
            className: 'icon-button',
            'aria-label': `Remove “${item.question}”`,
            title: 'Remove',
            disabled: isRunning,
            onClick: () => {
              questions.splice(index, 1);
              results.splice(index, 1);
              saveQuestions();
              renderSuite();
            },
          },
          '×',
        ),
      );
    }),
  );
}

function renderResult(result, item) {
  if (result.state === 'pending') {
    return el('p', { className: 'suite-row__answer' }, 'Asking…');
  }
  if (result.error) {
    return el('p', { className: 'suite-row__answer' }, el('span', { className: 'tag tag--red' }, result.error));
  }
  const reply = result.reply;
  const ui = reply.presentation;
  const tags = [
    reply.intent && el('span', { className: 'tag tag--blue' }, reply.intent),
    reply.agent && el('span', { className: 'tag' }, reply.agent),
    reply.authorization &&
      el('span', { className: `tag${reply.authorization === 'DENY' ? ' tag--red' : ''}` }, reply.authorization),
    reply.status && el('span', { className: 'tag' }, `status: ${reply.status}`),
    el(
      'span',
      { className: `tag${item.expectPresentation && ui?.type !== item.expectPresentation ? ' tag--red' : ''}` },
      ui ? `card: ${ui.type}${ui.title ? ` · ${ui.title}` : ''}` : 'no card',
    ),
    ...(reply.tools_used ?? []).map((tool) => el('span', { className: 'tag' }, tool)),
    reply.from_cache && el('span', { className: 'tag' }, 'cached'),
  ];
  return el(
    'div',
    {},
    el('p', { className: 'suite-row__answer' }, reply.answer || '(no answer text)'),
    el('div', { className: 'suite-row__meta' }, ...tags),
    result.note && el('p', { className: 'check-row__detail' }, result.note),
    el('details', {}, el('summary', {}, 'Raw response'), el('pre', {}, JSON.stringify(reply, null, 2))),
  );
}

function grade(result, item) {
  if (!result.ok) return { state: 'fail', ms: result.ms, error: errorText(result) };
  const reply = result.body ?? {};
  if (!reply.answer && !reply.presentation) {
    return { state: 'fail', ms: result.ms, reply, error: 'Answered without text or card' };
  }
  const notes = [];
  if (item.expectPresentation && reply.presentation?.type !== item.expectPresentation) {
    notes.push(`Expected a ${item.expectPresentation} card, got ${reply.presentation?.type ?? 'none'}.`);
  }
  if (reply.authorization === 'DENY') notes.push('Authorization denied.');
  return { state: notes.length ? 'warn' : 'pass', ms: result.ms, reply, note: notes.join(' ') };
}

function renderSummary() {
  const done = results.filter((result) => result && result.state !== 'pending');
  const summary = $('#suite-summary');
  summary.hidden = done.length === 0;
  if (done.length === 0) return;
  const count = (state) => done.filter((result) => result.state === state).length;
  const times = done.map((result) => result.ms).filter((ms) => ms != null).sort((a, b) => a - b);
  const avg = times.length ? Math.round(times.reduce((sum, ms) => sum + ms, 0) / times.length) : 0;
  const p95 = times.length ? times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)] : 0;
  summary.replaceChildren(
    el('span', {}, el('strong', {}, count('pass')), ' passed'),
    el('span', {}, el('strong', {}, count('warn')), ' warnings'),
    el('span', {}, el('strong', {}, count('fail')), ' failed'),
    el('span', {}, 'avg ', el('strong', {}, `${avg} ms`)),
    el('span', {}, 'p95 ', el('strong', {}, `${p95} ms`)),
  );
}

async function runSuite() {
  if (isRunning) {
    isRunning = false;
    return;
  }
  if (!settings.url || !settings.employee_id) {
    alert('Apply a TIA URL and employee ID first.');
    return;
  }
  isRunning = true;
  results = questions.map(() => null);
  $('#run-suite').textContent = 'Stop';
  $('#export-results').disabled = true;
  const shareConversation = $('#same-conversation').checked;
  let conversationId = null;

  for (const [index, item] of questions.entries()) {
    if (!isRunning) break;
    if (item.selected === false) continue;
    results[index] = { state: 'pending' };
    renderSuite();
    const response = await chat(item.question, shareConversation ? conversationId : null);
    if (shareConversation) conversationId = response.body?.conversation_id ?? conversationId;
    results[index] = grade(response, item);
    renderSuite();
    renderSummary();
  }

  isRunning = false;
  $('#run-suite').textContent = 'Run selected';
  $('#export-results').disabled = !results.some(Boolean);
  renderSuite();
}

$('#run-suite').addEventListener('click', runSuite);

$('#add-question').addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const question = String(data.get('question') || '').trim();
  if (!question) return;
  const expect = String(data.get('expect') || '').trim();
  questions.push({ question, expectPresentation: expect || undefined, selected: true });
  results.push(null);
  saveQuestions();
  renderSuite();
  event.currentTarget.reset();
});

$('#export-results').addEventListener('click', () => {
  const report = {
    target: { url: settings.url, apiBase: apiBase(), employeeId: settings.employee_id },
    ranAt: new Date().toISOString(),
    results: questions
      .map((item, index) => ({ question: item.question, expect: item.expectPresentation, ...results[index] }))
      .filter((row) => row.state),
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const link = el('a', {
    href: URL.createObjectURL(blob),
    download: `tia-test-${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}.json`,
  });
  link.click();
  URL.revokeObjectURL(link.href);
});

// ---------------------------------------------------------------- live widget
function removeLoaderWidget() {
  document.querySelectorAll('[data-tia-widget], script[data-tia-tester]').forEach((node) => node.remove());
}

function loadWidget() {
  const stage = $('#preview-stage');
  const hint = $('#preview-hint');
  removeLoaderWidget();
  if (!settings.url || !settings.employee_id) return;

  const selfSigned = settings.insecure && settings.url.startsWith('https://');
  hint.textContent = selfSigned
    ? 'Blank widget? Open the TIA URL once in this browser and accept its certificate, then reload.'
    : '';

  if (settings.mode === 'iframe') {
    const params = new URLSearchParams({ host_origin: location.origin });
    if (settings.api_base) params.set('api_base', settings.api_base);
    if (settings.employee_name) params.set('employee_name', settings.employee_name);
    if (settings.mock) params.set('mock_actions', '1');
    const [width, height] = FRAME_SIZES[$('#frame-size').value] ?? FRAME_SIZES.widget;
    stage.replaceChildren(
      el('iframe', {
        title: 'TIA widget preview',
        src: `${settings.url}/widget/${encodeURIComponent(settings.employee_id)}?${params}`,
        width,
        height,
        allow: 'microphone; geolocation',
      }),
    );
    return;
  }

  // As on the Tapplent portal: the loader adds its launcher to this page's bottom-right corner.
  // No cache-busting query: the loader builds the widget URL from its own src, query included.
  const script = el('script', {
    src: `${settings.url}/widget-loader.js`,
    'data-tia-tester': '',
    'data-employee-id': settings.employee_id,
    'data-employee-name': settings.employee_name || undefined,
    'data-api-base': settings.api_base || undefined,
  });
  script.addEventListener('error', () => {
    stage.replaceChildren(
      el('p', { className: 'loader-note' }, el('strong', {}, 'Loader failed to load'), 'Check the URL and certificate.'),
    );
  });
  stage.replaceChildren(
    el(
      'div',
      { className: 'loader-note' },
      el('strong', {}, 'Embedded with widget-loader.js'),
      'The TIA launcher sits in the bottom-right corner of this page, as on the Tapplent portal.',
      el('br'),
      el('br'),
      el(
        'button',
        {
          type: 'button',
          className: 'button button--primary',
          onClick: () => document.querySelector('[data-tia-widget="button"]')?.click(),
        },
        'Open the widget',
      ),
    ),
  );
  document.body.append(script);
}

$('#reload-widget').addEventListener('click', loadWidget);
$('#frame-size').addEventListener('change', () => settings.mode === 'iframe' && loadWidget());

// ---------------------------------------------------------------- start
fillForm();
questions = await loadQuestions();
results = questions.map(() => null);
renderSuite();
if (settings.url && settings.employee_id) {
  runChecks();
  loadWidget();
}
