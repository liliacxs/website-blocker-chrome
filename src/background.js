// FocusGuard service worker. It may be suspended at any time, so it holds NO state in memory:
// every handler loads state from chrome.storage.local, reconciles, and saves.
import { loadState, saveState } from './lib/storage.js';
import { matchRestricted, normalizeDomain } from './lib/domain.js';
import { settleTracking, projectState } from './lib/usage.js';
import { evaluate, nextWakeTime } from './lib/engine.js';
import { proposeChange, cancelPending, applyDuePending, startFocus, expireFocus } from './lib/changes.js';
import { currentTimezone } from './lib/timeutil.js';

const CHECKPOINT_ALARM = 'checkpoint';
const BOUNDARY_ALARM = 'boundary';
const BLOCKED_PAGE = 'src/pages/blocked.html';

const blockedUrl = (domain) => chrome.runtime.getURL(`${BLOCKED_PAGE}?d=${encodeURIComponent(domain)}`);

// ---- Serialisation: one reconcile at a time, so usage is never double counted ----------------

let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

/** The focused window's active tab, if it shows a restricted domain. */
async function detectTarget(domains) {
  try {
    const w = await chrome.windows.getLastFocused({ populate: true });
    if (!w?.focused || w.state === 'minimized') return null;
    const tab = w.tabs?.find((t) => t.active);
    return tab?.url ? matchRestricted(tab.url, domains) : null;
  } catch {
    return null;
  }
}

async function syncRules(blocked, domains) {
  const desired = blocked
    ? domains.map((d, i) => ({
        id: i + 1,
        priority: 1,
        action: { type: 'redirect', redirect: { extensionPath: `/${BLOCKED_PAGE}?d=${encodeURIComponent(d)}` } },
        condition: { requestDomains: [d], resourceTypes: ['main_frame'] },
      }))
    : [];
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const sig = (rules) => rules.map((r) => `${r.id}:${r.condition.requestDomains?.[0]}`).join('|');
  if (sig(existing) === sig(desired)) return;
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: desired,
  });
}

/** DNR only affects new requests, so already-open tabs must be pushed to the blocking page. */
async function redirectOpenTabs(domains) {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(
    tabs.map(async (tab) => {
      const d = tab.url && matchRestricted(tab.url, domains);
      if (d) await chrome.tabs.update(tab.id, { url: blockedUrl(d) }).catch(() => {});
    }),
  );
}

async function scheduleAlarms(state, now, tracking) {
  if (!(await chrome.alarms.get(CHECKPOINT_ALARM))) chrome.alarms.create(CHECKPOINT_ALARM, { periodInMinutes: 0.5 });
  const when = nextWakeTime(state, now, tracking);
  chrome.alarms.create(BOUNDARY_ALARM, { when: Math.max(when, now + 1000) + 250 });
}

/**
 * The one pipeline every trigger goes through:
 * settle usage -> apply due cooldown changes / expire focus -> optional mutation ->
 * evaluate -> (re)start tracking -> persist -> sync DNR rules -> redirect open tabs -> alarms.
 */
function reconcile(mutator) {
  return serial(async () => {
    const now = Date.now();
    const state = await loadState();
    settleTracking(state, now);
    state.settings.timezone = currentTimezone();
    applyDuePending(state, now);
    expireFocus(state, now);

    let result;
    try {
      result = mutator ? mutator(state, now) : undefined;
    } catch (err) {
      result = { error: err.message };
    }

    const ev = evaluate(state, now);
    if (!ev.blocked) {
      const domain = await detectTarget(state.restrictedDomains);
      if (domain) state.tracking = { domain, since: now };
    }
    await saveState(state);

    await syncRules(ev.blocked, state.restrictedDomains);
    if (ev.blocked) await redirectOpenTabs(state.restrictedDomains);
    await scheduleAlarms(state, now, !!state.tracking);
    chrome.action.setBadgeBackgroundColor({ color: '#b3261e' });
    chrome.action.setBadgeText({ text: ev.blocked ? 'ON' : '' });
    return result;
  });
}

// ---- Event wiring (all event-driven; every handler just reconciles) -------------------------

const tick = () => reconcile().catch((e) => console.error('reconcile failed', e));

chrome.runtime.onInstalled.addListener(tick);
chrome.runtime.onStartup.addListener(tick);
chrome.alarms.onAlarm.addListener(tick);
chrome.tabs.onActivated.addListener(tick);
chrome.tabs.onRemoved.addListener(tick);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url || info.status) tick();
});
chrome.windows.onFocusChanged.addListener(tick);
chrome.windows.onRemoved.addListener(tick);

// Fast path for navigations: if currently blocked, send the tab to the blocking page without
// waiting for a full reconcile (also covers redirects and SPA history changes that DNR misses).
async function guardNavigation(details) {
  if (details.frameId !== 0) return;
  const state = await loadState();
  const domain = matchRestricted(details.url, state.restrictedDomains);
  if (domain && evaluate(state, Date.now()).blocked) {
    await chrome.tabs.update(details.tabId, { url: blockedUrl(domain) }).catch(() => {});
  }
}
chrome.webNavigation.onBeforeNavigate.addListener(guardNavigation);
chrome.webNavigation.onCommitted.addListener(guardNavigation);
chrome.webNavigation.onHistoryStateUpdated.addListener(guardNavigation);

// Service worker (re)start: recompute everything, recreate alarms and DNR rules.
tick();

// ---- Messaging with extension pages ----------------------------------------------------------

async function buildView() {
  const now = Date.now();
  const state = await loadState();
  const s = projectState(state, now);
  const f = s.focusSession;
  const focusActive = f.active && f.endTimestamp > now;
  return {
    now,
    settings: s.settings,
    restrictedDomains: s.restrictedDomains,
    schedules: s.schedules,
    pendingChanges: s.pendingChanges,
    focus: focusActive ? f : { active: false },
    focusHistory: s.focusHistory.slice(-20).reverse(),
    usage: s.dailyUsage,
    history: s.history.slice(-30),
    evaluation: evaluate(state, now),
  };
}

const handlers = {
  getView: () => buildView(),

  request: async ({ change, dryRun }) => {
    if (dryRun) {
      const state = await loadState();
      try {
        return { ...proposeChange(state, change, Date.now(), { dryRun: true }), cooldownMinutes: state.settings.cooldownMinutes };
      } catch (e) {
        return { error: e.message };
      }
    }
    return reconcile((state, now) => proposeChange(state, change, now));
  },

  cancelPending: ({ id }) => reconcile((state) => ({ cancelled: cancelPending(state, id) })),

  startFocus: ({ minutes }) => reconcile((state, now) => startFocus(state, minutes, now)),

  // Blocking page loaded: count the event and return what it needs to render.
  blockShown: async ({ domain }) => {
    const { domain: d } = normalizeDomain(domain ?? '');
    await reconcile((state) => {
      if (d && state.restrictedDomains.includes(d)) state.dailyUsage.blocks += 1;
    });
    return buildView();
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !handlers[msg?.type]) return false;
  Promise.resolve(handlers[msg.type](msg))
    .then((r) => sendResponse(r ?? {}))
    .catch((e) => sendResponse({ error: e.message }));
  return true;
});
