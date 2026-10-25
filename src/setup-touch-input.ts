// Native text entry supplies the phone keyboard while the CRT remains the menu.
import { isTouchInputActive } from './store-touch';
import type { SetupScreen } from './store-setup-screens';

export function syncSetupTouchInput(screen: SetupScreen | null, change: (value: string) => void): void {
  const field = screen?.kind === 'home' && screen.row === 1
    ? { key: 'address', label: 'Server address', value: screen.address, type: 'url' }
    : screen?.kind === 'manual-auth' && screen.row < 2
      ? screen.row === 0
        ? { key: 'username', label: 'Member name', value: screen.username, type: 'text' }
        : { key: 'password', label: 'Password', value: screen.password, type: 'password' }
      : null;
  let box = document.getElementById('setup-touch-field');
  if (!field || !isTouchInputActive()) { box?.remove(); return; }
  if (!box) {
    box = document.createElement('label');
    box.id = 'setup-touch-field';
    box.style.cssText = 'position:fixed;left:max(16px, env(safe-area-inset-left));right:max(16px, env(safe-area-inset-right));top:max(12px, env(safe-area-inset-top));z-index:1300;padding:8px;background:#101010;color:#fff;font:16px sans-serif;border:1px solid #d5ad36;border-radius:8px;touch-action:manipulation';
    const title = document.createElement('span');
    const input = document.createElement('input');
    input.id = 'setup-touch-input';
    input.style.cssText = 'box-sizing:border-box;display:block;width:100%;min-height:44px;margin-top:5px;font:16px sans-serif;color:#fff;background:#202020;border:1px solid #aaa;padding:8px';
    input.autocapitalize = 'off'; input.spellcheck = false;
    input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    box.append(title, input); document.body.appendChild(box);
  }
  const input = box.querySelector('input')!;
  box.querySelector('span')!.textContent = field.label;
  input.type = field.type;
  input.autocomplete = field.key === 'password' ? 'current-password' : field.key === 'username' ? 'username' : 'off';
  input.setAttribute('aria-label', field.label);
  if (input.dataset.field !== field.key || document.activeElement !== input) input.value = field.value;
  input.dataset.field = field.key;
  input.oninput = () => change(input.value);
}
