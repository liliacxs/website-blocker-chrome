// chrome.storage.local persistence (the only module besides background.js touching Chrome APIs).
import { migrate } from './state.js';

const KEY = 'state';

export async function loadState() {
  const r = await chrome.storage.local.get(KEY);
  return migrate(r[KEY], Date.now());
}

export async function saveState(state) {
  await chrome.storage.local.set({ [KEY]: state });
}
