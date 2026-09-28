import { STORAGE_KEYS } from './config.js';

export const state = {
  appData: { delivery: [], pickup: [], return: [] },
  vndRate: 1000,
  rankBonus: 0,
  rankName: 'none',
  activeTab: 'overview',
  histFilter: 'all',
  overviewFilter: 'all',
  periodFilter: 'all',
  lastOcrImageDataUrl: '',
  isOcrScan: false
};

export function loadState() {
  let d = JSON.parse(localStorage.getItem(STORAGE_KEYS.records));
  if (!d || (!d.delivery && !d.pickup)) {
    d = JSON.parse(localStorage.getItem(STORAGE_KEYS.vault)) || { delivery: [], pickup: [], return: [] };
  }
  if (!d.delivery) d.delivery = [];
  if (!d.pickup)   d.pickup   = [];
  if (!d.return)   d.return   = [];
  state.appData   = d;
  state.vndRate   = parseFloat(localStorage.getItem(STORAGE_KEYS.rate)) || 1000;
  state.rankBonus = parseFloat(localStorage.getItem(STORAGE_KEYS.rank)) || 0;
  state.rankName  = localStorage.getItem(STORAGE_KEYS.rankName) || 'none';
}

export function persistData() {
  localStorage.setItem(STORAGE_KEYS.records, JSON.stringify(state.appData));
  const total = state.appData.delivery.length + state.appData.pickup.length + state.appData.return.length;
  if (total > 0) localStorage.setItem(STORAGE_KEYS.vault, JSON.stringify(state.appData));
}

export function persistSettings() {
  localStorage.setItem(STORAGE_KEYS.rate,     state.vndRate);
  localStorage.setItem(STORAGE_KEYS.rank,     state.rankBonus);
  localStorage.setItem(STORAGE_KEYS.rankName, state.rankName);
}