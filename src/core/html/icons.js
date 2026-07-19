/**
 * Canonical Rabbithole icon repository.
 *
 * Keep product-owned SVG geometry here. Consumers choose an icon by name and
 * may only override its rendered size; the viewBox and drawing attributes stay
 * consistent everywhere. The returned markup is trusted, static application
 * chrome and is safe to inline in live pages and self-contained snapshots.
 */

const BUNNY_SHAPES = `
  <ellipse cx="30" cy="17" rx="4.6" ry="12.5" transform="rotate(20 30 17)"></ellipse>
  <ellipse cx="21.5" cy="15.5" rx="4.6" ry="13" transform="rotate(3 21.5 15.5)"></ellipse>
  <circle cx="21" cy="33" r="9.5"></circle>
  <ellipse cx="36" cy="45" rx="17" ry="13.5"></ellipse>
  <circle cx="52.5" cy="49" r="5"></circle>`;

const STROKE_16 = 'viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"';

const ICON_DEFINITIONS = Object.freeze({
  bunny: { size: null, attrs: 'viewBox="0 0 64 64" fill="currentColor"', body: BUNNY_SHAPES },
  rail: { size: 16, attrs: STROKE_16, body: '<rect x="2.5" y="2.75" width="11" height="10.5" rx="1.6"/><path d="M6.25 2.75v10.5"/>' },
  new: { size: 16, attrs: STROKE_16, body: '<path d="M9.75 3.25H4.5c-.7 0-1.25.55-1.25 1.25v7c0 .7.55 1.25 1.25 1.25h7c.7 0 1.25-.55 1.25-1.25V6.25"/><path d="m7.25 9.25.35-1.7 4.55-4.55a.85.85 0 0 1 1.2 1.2L8.8 8.75z"/>' },
  "zoom-out": { size: 16, attrs: STROKE_16, body: '<path d="M4 8h8"/>' },
  "zoom-in": { size: 16, attrs: STROKE_16, body: '<path d="M8 4v8M4 8h8"/>' },
  frame: { size: 16, attrs: STROKE_16, body: '<path d="M5.8 3.25H3.25V5.8"/><path d="M10.2 3.25h2.55V5.8"/><path d="M12.75 10.2v2.55H10.2"/><path d="M5.8 12.75H3.25V10.2"/>' },
  tidy: { size: 16, attrs: STROKE_16, body: '<rect x="6.25" y="2.5" width="3.5" height="2.75" rx="0.7"/><rect x="2.75" y="10.75" width="3.5" height="2.75" rx="0.7"/><rect x="9.75" y="10.75" width="3.5" height="2.75" rx="0.7"/><path d="M8 5.25v2.25"/><path d="M4.5 7.5h7"/><path d="M4.5 7.5v3.25"/><path d="M11.5 7.5v3.25"/>' },
  share: { size: 16, attrs: STROKE_16, body: '<path d="M5 11 11.25 4.75"/><path d="M7.5 4.75h3.75V8.5"/>' },
  theme: { size: 16, attrs: 'viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.5" fill="none"', body: '<circle cx="8" cy="8" r="5.25"/><path d="M8 2.75a5.25 5.25 0 0 0 0 10.5z" fill="currentColor" stroke="none"/>' },
  settings: { size: 16, attrs: 'viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"', body: '<g transform="translate(12 12) scale(0.78) translate(-12 -12)"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></g>' },
  send: { size: 14, attrs: 'viewBox="0 0 16 16" fill="none"', body: '<path d="M8 12.8V3.6M8 3.6 3.9 7.7M8 3.6l4.1 4.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' },
  search: { size: 14, attrs: 'viewBox="0 0 16 16" fill="none"', body: '<circle cx="7" cy="7" r="4.6" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5 14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' },
  expand: { size: 16, attrs: STROKE_16, body: '<path d="M9.25 3.75h3v3"/><path d="M12.25 3.75 8.75 7.25"/><path d="M6.75 12.25h-3v-3"/><path d="M3.75 12.25l3.5-3.5"/>' },
  collapse: { size: 16, attrs: STROKE_16, body: '<path d="M3 8h10"/>' },
  restore: { size: 16, attrs: STROKE_16, body: '<path d="M3 8h10M8 3v10"/>' },
  "area-select": { size: 16, attrs: 'viewBox="0 0 16 16"', body: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2.6 2.1"/>' },
  "file-text": { size: 16, attrs: 'viewBox="0 0 16 16"', body: '<path d="M4 2.5h5l3 3v8H4z" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/><path d="M9 2.5v3h3M6 8h4M6 10.5h4" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>' },
  question: { size: 18, attrs: 'viewBox="0 0 18 18" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"', body: '<path d="M5.25 6.6A3.75 3.75 0 0 1 9 3a3.5 3.5 0 0 1 3.75 3.35c0 2.25-2.35 2.65-3.2 4.05-.25.4-.3.75-.3 1.1"/><path d="M9.25 14.5h.01"/>' },
  file: { size: 18, attrs: 'viewBox="0 0 18 18" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"', body: '<path d="M5 2.75h5l3 3v9.5H5z"/><path d="M10 2.75v3h3"/><path d="M7.25 9h3.5M7.25 11.75h3.5"/>' },
  paste: { size: 18, attrs: 'viewBox="0 0 18 18" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"', body: '<path d="M6.25 4.25H5A1.75 1.75 0 0 0 3.25 6v8.25C3.25 15.2 4.05 16 5 16h8c.95 0 1.75-.8 1.75-1.75V6c0-.95-.8-1.75-1.75-1.75h-1.25"/><rect x="6.25" y="2.25" width="5.5" height="3.5" rx="1.25"/><path d="M9 8.25v4.25m-1.75-1.75L9 12.5l1.75-1.75"/>' },
  link: { size: 18, attrs: 'viewBox="0 0 18 18" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"', body: '<path d="m7.15 10.85 3.7-3.7"/><path d="M6.05 12.95 4.9 14.1a2.85 2.85 0 0 1-4-4L3.8 7.2a2.85 2.85 0 0 1 4 0" transform="translate(2 0)"/><path d="m9.95 5.05 1.15-1.15a2.85 2.85 0 0 1 4 4l-2.9 2.9a2.85 2.85 0 0 1-4 0"/>' },
  plus: { size: 14, attrs: 'viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none"', body: '<path d="M8 3.25v9.5"/><path d="M3.25 8h9.5"/>' },
  delete: { size: 16, attrs: STROKE_16, body: '<path d="M3.25 4.5h9.5"/><path d="M6.25 2.75h3.5"/><path d="M4.75 4.5l.6 8h5.3l.6-8"/>' },
  eye: { size: 14, attrs: 'viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"', body: '<path d="M1.9 8S4.2 3.8 8 3.8 14.1 8 14.1 8 11.8 12.2 8 12.2 1.9 8 1.9 8Z"/><circle cx="8" cy="8" r="1.9"/>' },
  "eye-off": { size: 14, attrs: 'viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"', body: '<path d="M1.9 8S4.2 3.8 8 3.8 14.1 8 14.1 8 11.8 12.2 8 12.2 1.9 8 1.9 8Z"/><circle cx="8" cy="8" r="1.9"/><path d="m3.2 2.6 9.6 10.8"/>' },
  chevron: { size: 12, attrs: 'viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"', body: '<path d="m4.5 6.5 3.5 3.5 3.5-3.5"/>' },
  info: { size: 13, attrs: 'viewBox="0 0 16 16" fill="none"', body: '<circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.35"/><path d="M8 7.15v4" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/><circle cx="8" cy="4.7" r=".75" fill="currentColor"/>' },
});

/** @param {keyof typeof ICON_DEFINITIONS} name @param {{ size?: number }=} options */
export function iconSvg(name, options = {}) {
  const definition = ICON_DEFINITIONS[name];
  if (!definition) throw new Error(`Unknown Rabbithole icon: ${name}`);
  const size = options.size ?? definition.size;
  if (size !== null && (!Number.isFinite(size) || size <= 0)) throw new Error("Icon size must be a positive number");
  const dimensions = size === null ? "" : ` width="${size}" height="${size}"`;
  return `<svg${dimensions} ${definition.attrs} focusable="false" aria-hidden="true">${definition.body}</svg>`;
}

export const BUNNY_MARK_SHAPES = BUNNY_SHAPES;
export const BUNNY_MARK_SVG = iconSvg("bunny");

export function faviconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1a1918"/><g fill="#efece5">${BUNNY_SHAPES}</g></svg>`;
}
