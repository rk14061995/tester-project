// TIA tester page. Settings come from the page URL (shareable), then localStorage, then defaults.
// Requests to TIA go through the tester server's /probe (see server.mjs).

const SETTINGS_KEY = 'tia-tester:settings';
const QUESTIONS_KEY = 'tia-tester:questions'; // pre-roles format, migrated on load
const SUITE_KEY = 'tia-tester:suite';
const ROLE_KEY = 'tia-tester:role';
const DEFAULTS = {
  url: '',
  employee_id: '',
  employee_name: '',
  api_base: '',
  mode: 'loader',
  mock: false,
  insecure: true,
  role_employees: {}, // role id -> employee id to run that role's questions as
};
const FRAME_SIZES = {
  widget: [420, 580],
  phone: [390, 760],
  tall: [420, 820],
};

const $ = (selector) => document.querySelector(selector);
const form = $('#target-form');
let settings = readSettings();
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
  const roleEmployees = { ...(base.role_employees ?? {}) };
  for (const [key, value] of Object.entries(fromUrl)) {
    if (key.startsWith('as_') && value) roleEmployees[key.slice(3)] = value;
    if (key.startsWith('as_')) delete fromUrl[key];
  }
  return {
    ...base,
    ...fromUrl,
    role_employees: roleEmployees,
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
  for (const [role, employeeId] of Object.entries(settings.role_employees ?? {})) {
    if (employeeId) params.set(`as_${role}`, employeeId);
  }
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

function chat(message, conversationId = null, employeeId = settings.employee_id) {
  return probe(apiBase(), '/api/v1/tia/chat', {
    method: 'POST',
    body: {
      message,
      employee_id: employeeId,
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
    role_employees: settings.role_employees ?? {},
  };
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  settings = readForm();
  store(SETTINGS_KEY, settings);
  history.replaceState(null, '', shareUrl());
  fillForm();
  renderRoleBar();
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
// Default questions come from questions.json, grouped by role. The browser keeps only what the
// user changed: added questions, removed defaults and unticked questions, so later edits to
// questions.json still show up.
const INTENTS = [
  'GET_MY_PROFILE', 'GET_MY_ATTENDANCE', 'GET_MY_DOCUMENTS', 'GET_MANAGER', 'GET_TEAMMATES',
  'GET_DIRECT_REPORTS', 'GET_INDIRECT_REPORTS', 'GET_ORG_CHART', 'GET_EMPLOYEE_DIRECTORY',
  'GET_LEAVE_BALANCE', 'GET_LEAVE_STATUS', 'GET_LEAVE_APPROVER', 'GET_LEAVE_HISTORY', 'GET_TEAM_LEAVE',
  'GET_LEAVE_DASHBOARD', 'GET_ATTENDANCE_REPORT', 'SEARCH_POLICY', 'GET_HOLIDAYS', 'GET_GOALS',
  'GET_SKILLS', 'FIND_EMPLOYEES_BY_SKILL', 'GET_ATTRITION_TREND', 'GET_HEADCOUNT', 'APPLY_LEAVE',
  'APPROVE_LEAVE', 'NAVIGATION', 'CHECK_ACCESS', 'GENERAL_HR',
];
const CARDS = [
  'summary_card', 'profile_card', 'data_table', 'employee_table', 'org_chart', 'bar_chart',
  'leave_dashboard', 'team_attendance', 'skill_chips', 'action', 'access_restricted',
];

let roles = [];
let activeRole = null;
let suiteState = { custom: [], removed: [], unselected: [] };
const results = new Map(); // question key -> result
const chatLog = []; // { kind: 'divider', text } | { kind: 'turn', key, role, question, result }

const questionKey = (roleId, question) => `${roleId}\u0001${question}`;
const roleById = (roleId) => roles.find((role) => role.id === roleId);
const roleEmployee = (roleId) => settings.role_employees?.[roleId] || settings.employee_id;

async function loadSuite() {
  try {
    const data = await (await fetch('/questions.json')).json();
    roles = data.roles ?? [];
  } catch {
    roles = [];
  }
  const saved = readStored(SUITE_KEY);
  if (saved && typeof saved === 'object') {
    suiteState = {
      custom: Array.isArray(saved.custom) ? saved.custom : [],
      removed: Array.isArray(saved.removed) ? saved.removed : [],
      unselected: Array.isArray(saved.unselected) ? saved.unselected : [],
    };
  }
  // Questions added before roles existed: keep the ones that aren't defaults, as Employee questions.
  const legacy = readStored(QUESTIONS_KEY);
  if (Array.isArray(legacy) && roles.length) {
    const defaults = new Set(roles.flatMap((role) => role.questions.map((item) => item.question)));
    for (const item of legacy) {
      if (!item?.question || defaults.has(item.question)) continue;
      suiteState.custom.push({ role: roles[0].id, question: item.question, expectPresentation: item.expectPresentation });
    }
    try {
      localStorage.removeItem(QUESTIONS_KEY);
    } catch {
      // ignore
    }
    saveSuite();
  }
  activeRole = roles.find((role) => role.id === readStored(ROLE_KEY))?.id ?? roles[0]?.id ?? null;
}

function saveSuite() {
  store(SUITE_KEY, suiteState);
}

function questionsFor(roleId) {
  const role = roleById(roleId);
  if (!role) return [];
  const removed = new Set(suiteState.removed);
  const unselected = new Set(suiteState.unselected);
  const items = [
    ...role.questions.map((item) => ({ ...item, custom: false })),
    ...suiteState.custom.filter((item) => item.role === roleId).map((item) => ({ ...item, custom: true })),
  ];
  return items
    .map((item) => ({ ...item, role: roleId, key: questionKey(roleId, item.question) }))
    .filter((item) => item.custom || !removed.has(item.key))
    .map((item) => ({ ...item, selected: !unselected.has(item.key) }));
}

function setSelected(key, selected) {
  suiteState.unselected = suiteState.unselected.filter((other) => other !== key);
  if (!selected) suiteState.unselected.push(key);
  saveSuite();
}

function removeQuestion(item) {
  if (item.custom) {
    suiteState.custom = suiteState.custom.filter((other) => questionKey(other.role, other.question) !== item.key);
  } else {
    suiteState.removed.push(item.key);
  }
  results.delete(item.key);
  saveSuite();
  renderSuite();
}

function restoreDefaults() {
  const prefix = `${activeRole}\u0001`;
  suiteState.removed = suiteState.removed.filter((key) => !key.startsWith(prefix));
  saveSuite();
  renderSuite();
}

// ------------------------------------------------ rendering
function renderRoleTabs() {
  $('#role-tabs').replaceChildren(
    ...roles.map((role) => {
      const items = questionsFor(role.id);
      const done = items.map((item) => results.get(item.key)).filter((r) => r && r.state !== 'pending');
      const failed = done.filter((r) => r.state === 'fail').length;
      return el(
        'button',
        {
          type: 'button',
          role: 'tab',
          className: 'role-tab',
          'aria-selected': String(role.id === activeRole),
          onClick: () => {
            activeRole = role.id;
            store(ROLE_KEY, activeRole);
            renderSuite();
          },
        },
        role.label,
        el('span', { className: `role-tab__count${failed ? ' role-tab__count--fail' : ''}` },
          done.length ? `${done.length - failed}/${done.length}` : items.length),
      );
    }),
  );
  $('#add-role').replaceChildren(
    ...roles.map((role) => el('option', { value: role.id, selected: role.id === activeRole }, role.label)),
  );
}

function renderRoleBar() {
  const role = roleById(activeRole);
  const removedHere = suiteState.removed.filter((key) => key.startsWith(`${activeRole}\u0001`)).length;
  $('#role-description').replaceChildren(
    role?.description ?? '',
    ...(removedHere > 0
      ? [' ', el('button', { type: 'button', className: 'link-button', onClick: restoreDefaults },
          `Restore ${removedHere} removed`)]
      : []),
  );
  const input = $('#role-employee');
  if (document.activeElement !== input) input.value = settings.role_employees?.[activeRole] ?? '';
  input.placeholder = settings.employee_id ? `${settings.employee_id} (target)` : 'Target employee';
  const selected = questionsFor(activeRole).filter((item) => item.selected).length;
  const button = $('#run-role');
  button.textContent = isRunning ? 'Stop' : `Run ${role?.label ?? ''} questions (${selected})`;
  button.disabled = !isRunning && selected === 0;
  $('#run-all-roles').disabled = isRunning;
}

function expectationTags(item) {
  return [
    item.expectIntent && el('span', { className: 'tag' }, `→ ${item.expectIntent}`),
    item.expectPresentation && el('span', { className: 'tag' }, `card ${item.expectPresentation}`),
    item.expectAuth === 'DENY' && el('span', { className: 'tag tag--amber' }, 'should be denied'),
    item.custom && el('span', { className: 'tag tag--blue' }, 'added'),
  ];
}

function renderSuite() {
  renderRoleTabs();
  renderRoleBar();
  const list = $('#suite');
  const items = questionsFor(activeRole);
  if (items.length === 0) {
    list.replaceChildren(el('li', { className: 'empty' }, 'No questions for this role. Add one above.'));
    renderSummary();
    return;
  }
  list.replaceChildren(
    ...items.map((item) => {
      const result = results.get(item.key);
      return el(
        'li',
        { className: 'suite-row' },
        el('input', {
          type: 'checkbox',
          checked: item.selected,
          'aria-label': `Include “${item.question}”`,
          disabled: isRunning,
          onChange: (event) => {
            setSelected(item.key, event.target.checked);
            renderRoleBar();
          },
        }),
        badge(result?.state ?? 'idle'),
        el(
          'div',
          {},
          el(
            'button',
            {
              type: 'button',
              className: 'suite-row__question',
              title: result ? 'Show the answer in the chat' : undefined,
              onClick: () => result && showInChat(item.key),
            },
            item.question,
          ),
          el('div', { className: 'suite-row__meta' }, ...expectationTags(item)),
          result?.state === 'pending' && el('p', { className: 'check-row__detail' }, 'Asking…'),
          (result?.error || result?.note) &&
            el('p', { className: `check-row__detail${result.state === 'fail' ? ' text-red' : ''}` },
              result.error || result.note),
        ),
        el('span', { className: 'suite-row__ms' }, result?.ms != null ? `${result.ms} ms` : ''),
        el(
          'button',
          {
            type: 'button',
            className: 'icon-button icon-button--run',
            'aria-label': `Run “${item.question}”`,
            title: 'Run this question',
            disabled: isRunning,
            onClick: () => runQueue([item], { label: `${roleById(item.role)?.label}: one question` }),
          },
          '▶',
        ),
        el(
          'button',
          {
            type: 'button',
            className: 'icon-button',
            'aria-label': `Remove “${item.question}”`,
            title: item.custom ? 'Delete' : 'Remove (can be restored)',
            disabled: isRunning,
            onClick: () => removeQuestion(item),
          },
          '×',
        ),
      );
    }),
  );
  renderSummary();
}

function renderSummary() {
  const done = questionsFor(activeRole)
    .map((item) => results.get(item.key))
    .filter((result) => result && result.state !== 'pending');
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

// ------------------------------------------------ grading
const isDenied = (reply) =>
  reply.authorization === 'DENY' || reply.presentation?.type === 'access_restricted';

function grade(result, item) {
  if (!result.ok) return { state: 'fail', ms: result.ms, error: errorText(result) };
  const reply = result.body ?? {};
  if (!reply.answer && !reply.presentation) {
    return { state: 'fail', ms: result.ms, reply, error: 'Answered without text or card' };
  }
  const problems = [];
  const warnings = [];
  if (item.expectAuth === 'DENY') {
    if (!isDenied(reply)) problems.push(`Should be denied for this role, but TIA answered (${reply.authorization ?? 'no authorization'}).`);
  } else if (isDenied(reply)) {
    warnings.push('Authorization denied.');
  }
  if (item.expectIntent && reply.intent !== item.expectIntent) {
    warnings.push(`Expected intent ${item.expectIntent}, got ${reply.intent ?? 'none'}.`);
  }
  if (item.expectPresentation && item.expectAuth !== 'DENY' && reply.presentation?.type !== item.expectPresentation) {
    warnings.push(`Expected a ${item.expectPresentation} card, got ${reply.presentation?.type ?? 'none'}.`);
  }
  const state = problems.length ? 'fail' : warnings.length ? 'warn' : 'pass';
  return { state, ms: result.ms, reply, note: [...problems, ...warnings].join(' ') };
}

// ------------------------------------------------ running
async function runQueue(items, { label } = {}) {
  if (isRunning) return;
  if (!settings.url || !settings.employee_id) {
    alert('Apply a TIA URL and employee ID first.');
    return;
  }
  items = items.filter(Boolean);
  if (items.length === 0) return;
  isRunning = true;
  $('#export-results').disabled = true;
  showTab('chat');
  const shareConversation = $('#same-conversation').checked;
  const conversations = new Map(); // role -> conversation id
  let lastRole = null;
  for (const item of items) results.set(item.key, { state: 'pending' });
  renderSuite();

  for (const item of items) {
    if (!isRunning) {
      results.delete(item.key);
      continue;
    }
    if (item.role !== lastRole) {
      lastRole = item.role;
      const count = items.filter((other) => other.role === item.role).length;
      pushDivider(`${label ?? roleById(item.role)?.label} · ${count} question${count === 1 ? '' : 's'} as ${roleEmployee(item.role)}`);
    }
    const turn = pushTurn(item);
    const response = await chat(
      item.question,
      shareConversation ? conversations.get(item.role) ?? null : null,
      roleEmployee(item.role),
    );
    if (shareConversation && response.body?.conversation_id) conversations.set(item.role, response.body.conversation_id);
    const result = { ...grade(response, item), employeeId: roleEmployee(item.role), ranAt: new Date().toISOString() };
    results.set(item.key, result);
    turn.result = result;
    renderChat();
    renderSuite();
  }

  isRunning = false;
  $('#export-results').disabled = results.size === 0;
  renderSuite();
  renderChat(); // shows "Save to role" on typed questions now the run is over
}

function runActiveRole() {
  if (isRunning) {
    isRunning = false; // the loop stops after the question in flight
    return;
  }
  runQueue(questionsFor(activeRole).filter((item) => item.selected));
}

function runAllRoles() {
  runQueue(roles.flatMap((role) => questionsFor(role.id).filter((item) => item.selected)));
}

$('#run-role').addEventListener('click', runActiveRole);
$('#run-all-roles').addEventListener('click', runAllRoles);

$('#select-all').addEventListener('click', () => {
  const keys = new Set(questionsFor(activeRole).map((item) => item.key));
  suiteState.unselected = suiteState.unselected.filter((key) => !keys.has(key));
  saveSuite();
  renderSuite();
});

$('#select-none').addEventListener('click', () => {
  for (const item of questionsFor(activeRole)) if (item.selected) suiteState.unselected.push(item.key);
  saveSuite();
  renderSuite();
});

$('#role-employee').addEventListener('change', (event) => {
  const value = event.target.value.trim();
  settings.role_employees = { ...(settings.role_employees ?? {}), [activeRole]: value || undefined };
  if (!value) delete settings.role_employees[activeRole];
  store(SETTINGS_KEY, settings);
  history.replaceState(null, '', shareUrl());
  renderRoleBar();
});

function addQuestion({ role, question, expectIntent, expectPresentation, expectAuth }) {
  const key = questionKey(role, question);
  if (questionsFor(role).some((item) => item.key === key)) return false;
  suiteState.removed = suiteState.removed.filter((other) => other !== key);
  if (!roleById(role).questions.some((item) => item.question === question)) {
    suiteState.custom.push({ role, question, expectIntent, expectPresentation, expectAuth });
  }
  saveSuite();
  return true;
}

$('#add-question').addEventListener('submit', (event) => {
  event.preventDefault();
  const formEl = event.currentTarget;
  const data = new FormData(formEl);
  const question = String(data.get('question') || '').trim();
  const role = String(data.get('role') || activeRole);
  if (!question || !roleById(role)) return;
  const added = addQuestion({
    role,
    question,
    expectIntent: String(data.get('intent') || '').trim().toUpperCase() || undefined,
    expectPresentation: String(data.get('expect') || '').trim() || undefined,
    expectAuth: data.get('deny') === 'on' ? 'DENY' : undefined,
  });
  if (!added) {
    alert(`“${question}” is already in ${roleById(role).label}.`);
    return;
  }
  activeRole = role;
  store(ROLE_KEY, activeRole);
  renderSuite();
  formEl.reset();
  $('#add-role').value = role;
});

$('#export-results').addEventListener('click', () => {
  const report = {
    target: { url: settings.url, apiBase: apiBase(), employeeId: settings.employee_id },
    ranAt: new Date().toISOString(),
    roles: roles.map((role) => ({
      role: role.id,
      label: role.label,
      employeeId: roleEmployee(role.id),
      results: questionsFor(role.id)
        .filter((item) => results.get(item.key)?.state && results.get(item.key).state !== 'pending')
        .map((item) => ({
          question: item.question,
          expectIntent: item.expectIntent,
          expectPresentation: item.expectPresentation,
          expectAuth: item.expectAuth,
          ...results.get(item.key),
        })),
    })).filter((role) => role.results.length),
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const link = el('a', {
    href: URL.createObjectURL(blob),
    download: `tia-test-${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}.json`,
  });
  link.click();
  URL.revokeObjectURL(link.href);
});

// ---------------------------------------------------------------- chat screen
function pushDivider(text) {
  chatLog.push({ kind: 'divider', text });
  renderChat();
}

function pushTurn(item) {
  const turn = {
    kind: 'turn',
    id: `turn-${chatLog.length}`,
    key: item.key,
    role: item.role,
    question: item.question,
    item,
    result: { state: 'pending' },
  };
  chatLog.push(turn);
  renderChat();
  return turn;
}

function renderTurn(turn) {
  const { result, item } = turn;
  const roleLabel = roleById(turn.role)?.label ?? turn.role;
  const saved = turn.role && questionsFor(turn.role).some((other) => other.key === turn.key);
  const user = el(
    'div',
    { className: 'bubble bubble--user' },
    el('p', {}, turn.question),
    el(
      'div',
      { className: 'bubble__foot' },
      el('span', {}, roleLabel),
      !saved &&
        !isRunning &&
        el(
          'button',
          {
            type: 'button',
            className: 'link-button link-button--light',
            onClick: () => {
              addQuestion({ role: turn.role, question: turn.question });
              renderSuite();
              renderChat();
            },
          },
          `Save to ${roleLabel}`,
        ),
    ),
  );

  let body;
  if (result.state === 'pending') {
    body = el('div', { className: 'bubble bubble--tia bubble--typing' }, el('span'), el('span'), el('span'));
  } else if (!result.reply) {
    body = el(
      'div',
      { className: 'bubble bubble--tia bubble--error' },
      el('div', { className: 'bubble__head' }, badge(result.state), el('strong', {}, 'Request failed')),
      el('p', {}, result.error),
    );
  } else {
    const reply = result.reply;
    const ui = reply.presentation;
    const tags = [
      reply.intent &&
        el('span', { className: `tag ${item?.expectIntent && item.expectIntent !== reply.intent ? 'tag--red' : 'tag--blue'}` }, reply.intent),
      reply.authorization &&
        el('span', { className: `tag${isDenied(reply) ? ' tag--amber' : ''}` }, reply.authorization),
      el(
        'span',
        { className: `tag${item?.expectPresentation && item.expectAuth !== 'DENY' && ui?.type !== item.expectPresentation ? ' tag--red' : ''}` },
        ui ? `card: ${ui.type}${ui.title ? ` · ${ui.title}` : ''}` : 'no card',
      ),
      reply.agent && el('span', { className: 'tag' }, reply.agent),
      ...(reply.tools_used ?? []).map((tool) => el('span', { className: 'tag' }, tool)),
      reply.from_cache && el('span', { className: 'tag' }, 'cached'),
      result.ms != null && el('span', { className: 'tag' }, `${result.ms} ms`),
    ];
    body = el(
      'div',
      { className: `bubble bubble--tia bubble--${result.state}` },
      el('div', { className: 'bubble__head' }, badge(result.state), el('strong', {}, 'TIA')),
      el('p', { className: 'bubble__answer' }, reply.answer || '(no answer text)'),
      result.note && el('p', { className: 'bubble__note' }, result.note),
      el('div', { className: 'suite-row__meta' }, ...tags),
      el('details', {}, el('summary', {}, 'Raw response'), el('pre', {}, JSON.stringify(reply, null, 2))),
    );
  }
  return el('div', { className: 'turn', id: turn.id }, user, body);
}

function renderChat() {
  const log = $('#chat-log');
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  if (chatLog.length === 0) {
    log.replaceChildren(el('p', { className: 'empty' }, 'Run a role or a question and the answers appear here.'));
    return;
  }
  log.replaceChildren(
    ...chatLog.map((entry) =>
      entry.kind === 'divider' ? el('p', { className: 'chat__divider' }, entry.text) : renderTurn(entry),
    ),
  );
  if (nearBottom || isRunning) log.scrollTop = log.scrollHeight;
}

function showInChat(key) {
  showTab('chat');
  const turn = chatLog.findLast((entry) => entry.kind === 'turn' && entry.key === key);
  const node = turn && document.getElementById(turn.id);
  if (!node) return;
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  node.classList.remove('turn--flash');
  void node.offsetWidth; // restart the animation
  node.classList.add('turn--flash');
}

$('#chat-composer').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = event.currentTarget.elements.message;
  const question = input.value.trim();
  if (!question || isRunning) return;
  input.value = '';
  const existing = questionsFor(activeRole).find((item) => item.question === question);
  runQueue([existing ?? { role: activeRole, question, key: questionKey(activeRole, question) }], {
    label: `${roleById(activeRole)?.label}: typed question`,
  });
});

$('#clear-chat').addEventListener('click', () => {
  if (isRunning) return;
  chatLog.length = 0;
  renderChat();
});

function showTab(name) {
  const chatTab = name === 'chat';
  $('#tab-chat').setAttribute('aria-selected', String(chatTab));
  $('#tab-widget').setAttribute('aria-selected', String(!chatTab));
  $('#chat-panel').hidden = !chatTab;
  $('#widget-panel').hidden = chatTab;
  $('#chat-actions').hidden = !chatTab;
  $('#widget-actions').hidden = chatTab;
}

$('#tab-chat').addEventListener('click', () => showTab('chat'));
$('#tab-widget').addEventListener('click', () => showTab('widget'));

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
$('#intent-options').replaceChildren(...INTENTS.map((value) => el('option', { value })));
$('#card-options').replaceChildren(...CARDS.map((value) => el('option', { value })));
await loadSuite();
renderSuite();
if (settings.url && settings.employee_id) {
  runChecks();
  loadWidget();
}
