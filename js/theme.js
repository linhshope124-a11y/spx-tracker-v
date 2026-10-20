import { STORAGE_KEYS } from './config.js';

export function initTheme() {
  let saved = 'light';
  try { saved = localStorage.getItem(STORAGE_KEYS.theme) || 'light'; } catch {}
  document.documentElement.setAttribute('data-theme', saved === 'dark' ? 'dark' : 'light');
}

export function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'light';
  const next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem(STORAGE_KEYS.theme, next); }
  catch (e) { console.warn('[Theme] Không lưu được tùy chọn giao diện:', e); }
}
