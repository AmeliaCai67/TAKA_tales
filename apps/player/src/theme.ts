import { t } from './i18n';
export const THEMES = ['dark-ocean', 'v5-paper', 'dark-ink', 'dark-forest'] as const;
export const PICKER_CHEVRON = '<svg class="picker-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>';
type Theme = typeof THEMES[number];
const KEY = 'taka_theme';
let controlId = 0;
function enhanceSelect(select: HTMLSelectElement): void {
    if (select.matches('[data-theme-select]') || select.closest('.theme-picker')) return;
    const picker = document.createElement('div');
    picker.className = 'theme-picker select-picker';
    const id = 'select-menu-' + ++controlId;
    picker.innerHTML = `<button type="button" class="theme-trigger" aria-haspopup="listbox" aria-expanded="false" aria-controls="${id}"><span class="select-label"></span>${PICKER_CHEVRON}</button><div class="theme-menu" id="${id}" role="listbox" hidden></div>`;
    select.before(picker); picker.appendChild(select);
    select.dataset.pickerSelect = ''; select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
    const sync = () => {
        picker.querySelector('.select-label')!.textContent = select.selectedOptions[0]?.textContent || '';
        const menu = picker.querySelector('.theme-menu')!; menu.replaceChildren();
        [...select.options].forEach(option => {
            const button = document.createElement('button'); button.type = 'button'; button.tabIndex = -1;
            button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(option.selected));
            button.dataset.selectOption = option.value; button.disabled = option.disabled;
            button.innerHTML = '<span class="picker-check" aria-hidden="true">✓</span><span></span>';
            button.lastElementChild!.textContent = option.textContent; menu.appendChild(button);
        });
        picker.querySelector<HTMLButtonElement>('.theme-trigger')!.disabled = select.disabled;
    };
    select.addEventListener('change', sync);
    select.addEventListener('picker-sync', sync);
    new MutationObserver(sync).observe(select, {subtree:true, childList:true, characterData:true, attributes:true});
    sync();
}
function valid(v: unknown): v is Theme { return THEMES.includes(v as Theme); }
function fitPicker(picker: HTMLElement): void {
    const menu = picker.querySelector<HTMLElement>('.theme-menu')!;
    const trigger = picker.querySelector<HTMLElement>('.theme-trigger')!;
    menu.style.top = ''; menu.style.bottom = ''; menu.style.maxHeight = '';
    const clip = picker.closest('#settings-panel')?.getBoundingClientRect();
    const viewport = window.visualViewport;
    const top = Math.max(viewport?.offsetTop || 0, clip?.top || 0) + 12;
    const bottom = Math.min((viewport?.offsetTop || 0) + (viewport?.height || innerHeight), clip?.bottom ?? innerHeight) - 12;
    const r = trigger.getBoundingClientRect();
    const below = Math.max(0, bottom - r.bottom - 8), above = Math.max(0, r.top - top - 8);
    const up = menu.scrollHeight > below && above > below;
    if (up) { menu.style.top = 'auto'; menu.style.bottom = 'calc(100% + 8px)'; }
    menu.style.maxHeight = `${up ? above : below}px`;
}
function setTheme(theme: Theme): void {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(KEY, theme); } catch { /* presentation still works */ }
    document.querySelectorAll<HTMLSelectElement>('[data-theme-select]').forEach(select => select.value = theme);
    document.querySelectorAll<HTMLElement>('[data-theme-label]').forEach(label => { label.dataset.i18n = 'shell.' + theme; label.textContent = t('shell.' + theme); });
    document.querySelectorAll<HTMLElement>('[data-theme-option]').forEach(option => option.setAttribute('aria-selected', String(option.dataset.themeOption === theme)));
}
function closePickers(restore = false): void {
    document.querySelectorAll<HTMLElement>('.theme-picker.is-open').forEach(picker => {
        picker.classList.remove('is-open');
        picker.closest('.cover-header')?.classList.remove('picker-open');
        picker.querySelector<HTMLElement>('.theme-menu')!.hidden = true;
        const trigger = picker.querySelector<HTMLButtonElement>('.theme-trigger')!;
        trigger.setAttribute('aria-expanded', 'false');
        if (restore) trigger.focus();
    });
}
export function initTheme(): void {
    const scan = () => document.querySelectorAll<HTMLSelectElement>('select').forEach(enhanceSelect);
    scan();
    new MutationObserver(scan).observe(document.body, {childList:true, subtree:true});
    let saved: string | null = null;
    try { saved = localStorage.getItem(KEY); } catch { /* unavailable storage: default */ }
    if (saved === 'forest-light') saved = 'dark-forest';
    document.documentElement.dataset.theme = valid(saved) ? saved : 'dark-ocean';
    document.addEventListener('change', e => {
        const select = e.target as HTMLSelectElement;
        if (select.matches('[data-theme-select]') && valid(select.value)) setTheme(select.value);
    });
    document.addEventListener('click', e => {
        const target = e.target as Element;
        const selectOption = target.closest<HTMLElement>('[data-select-option]');
        if (selectOption) {
            e.preventDefault();
            const select = selectOption.closest('.select-picker')!.querySelector<HTMLSelectElement>('select')!;
            select.value = selectOption.dataset.selectOption!; select.dispatchEvent(new Event('change', {bubbles:true}));
            closePickers(true); return;
        }
        const option = target.closest<HTMLElement>('[data-theme-option]');
        if (option && valid(option.dataset.themeOption)) { setTheme(option.dataset.themeOption); closePickers(true); return; }
        const trigger = target.closest<HTMLButtonElement>('.theme-trigger');
        if (!trigger) return;
        e.preventDefault();
        const picker = trigger.closest<HTMLElement>('.theme-picker')!;
        picker.querySelector('select[data-picker-select]')?.dispatchEvent(new Event('picker-sync'));
        const wasOpen = picker.classList.contains('is-open');
        closePickers();
        if (wasOpen) return;
        picker.classList.add('is-open');
        picker.closest('.cover-header')?.classList.add('picker-open');
        picker.querySelector<HTMLElement>('.theme-menu')!.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        fitPicker(picker);
        const selected = picker.querySelector<HTMLElement>('[aria-selected="true"]');
        selected?.focus({preventScroll:true});
        const menu = picker.querySelector<HTMLElement>('.theme-menu')!;
        if (selected) menu.scrollTop = Math.max(0, selected.offsetTop + selected.offsetHeight - menu.clientHeight);
    }, true); // Modal contents stop bubbling; selectors must also work inside them.
    document.addEventListener('pointerdown', e => {
        if (!(e.target as Element).closest('.theme-picker')) closePickers();
    });
    const refit = () => document.querySelectorAll<HTMLElement>('.theme-picker.is-open').forEach(fitPicker);
    window.addEventListener('resize', refit);
    window.visualViewport?.addEventListener('resize', refit);
    document.addEventListener('keydown', e => {
        const picker = (e.target as Element).closest<HTMLElement>('.theme-picker');
        if (!picker) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePickers(true); return; }
        if (e.key === 'Tab') { closePickers(true); return; }
        if (!['ArrowDown','ArrowUp','Home','End'].includes(e.key)) return;
        e.preventDefault();
        const options = [...picker.querySelectorAll<HTMLButtonElement>('[data-theme-option], [data-select-option]:not(:disabled)')];
        if (!picker.classList.contains('is-open')) { picker.querySelector<HTMLButtonElement>('.theme-trigger')!.click(); return; }
        const i = options.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        options[next]?.focus();
    }, true); // Escape closes the picker before the surrounding drawer handles it.
}
export function themeControl(): string {
    const theme = document.documentElement.dataset.theme as Theme || 'dark-ocean';
    const id = 'theme-menu-' + ++controlId;
    return `<div class="shell-theme"><span data-i18n="shell.theme">${t('shell.theme')}</span><div class="theme-picker">
        <button type="button" class="theme-trigger" aria-haspopup="listbox" aria-expanded="false" aria-controls="${id}" title="${t('shell.theme')}"><span data-theme-label data-i18n="shell.${theme}">${t('shell.' + theme)}</span>${PICKER_CHEVRON}</button>
        <div class="theme-menu" id="${id}" role="listbox" aria-label="${t('shell.theme')}" hidden>${THEMES.map(value => `<button type="button" role="option" tabindex="-1" data-theme-option="${value}" aria-selected="${value === theme}"><span class="picker-check" aria-hidden="true">✓</span><span data-i18n="shell.${value}">${t('shell.' + value)}</span></button>`).join('')}</div>
        <select data-theme-select aria-hidden="true" tabindex="-1">${THEMES.map(value => `<option value="${value}"${value === theme ? ' selected' : ''}>${t('shell.' + value)}</option>`).join('')}</select>
    </div></div>`;
}
