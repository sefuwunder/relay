/* Relay — postmodern icon set: bold geometric shapes in 2–3 flat tones.
   Tone 1 is currentColor (ink — inherits the surrounding text color, so icons
   tint with their context). Tone 2 is an accent class (.a blue, .g green,
   .p purple, .o orange, .sa blue stroke). Tone 3 is .w white, used sparingly
   for cutout details. */
"use strict";

const ICONS = {
  convo:
    '<rect x="2" y="3" width="14" height="10" rx="3" fill="currentColor"/>' +
    '<path d="M4 12.5V18l5-5.5z" fill="currentColor"/>' +
    '<rect x="5" y="6" width="8" height="2.2" rx="1.1" class="a"/>' +
    '<rect x="5" y="9.4" width="5" height="2.2" rx="1.1" class="a" opacity=".55"/>' +
    '<circle cx="17" cy="16" r="5" class="a"/>' +
    '<path d="M14.6 20.2l-1.1 2.8 3.6-1.8z" class="a"/>',
  people:
    '<circle cx="16.5" cy="7" r="3.4" class="a"/>' +
    '<path d="M11 20c0-3.6 2.5-6 5.5-6s5.5 2.4 5.5 6v.5H11z" class="a"/>' +
    '<circle cx="8" cy="8.5" r="4.2" fill="currentColor"/>' +
    '<path d="M1.5 21c0-4.2 2.9-7 6.5-7s6.5 2.8 6.5 7v.5h-13z" fill="currentColor"/>',
  sliders:
    '<rect x="3" y="4.8" width="18" height="2.4" rx="1.2" fill="currentColor"/>' +
    '<rect x="3" y="10.8" width="18" height="2.4" rx="1.2" fill="currentColor"/>' +
    '<rect x="3" y="16.8" width="18" height="2.4" rx="1.2" fill="currentColor"/>' +
    '<circle cx="15.5" cy="6" r="3.4" class="a"/>' +
    '<circle cx="8.5" cy="12" r="3.4" class="a"/>' +
    '<circle cx="16.5" cy="18" r="3.4" class="a"/>',
  email:
    '<rect x="2" y="5" width="20" height="14" rx="2.5" fill="currentColor"/>' +
    '<path d="M3.5 7.5L12 14l8.5-6.5" fill="none" class="sa" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  sms:
    '<rect x="2" y="4" width="20" height="13" rx="4.5" fill="currentColor"/>' +
    '<path d="M7 17v4.5L11.5 17z" fill="currentColor"/>' +
    '<circle cx="8" cy="10.5" r="1.6" class="w"/><circle cx="12" cy="10.5" r="1.6" class="w"/><circle cx="16" cy="10.5" r="1.6" class="w"/>',
  matrix:
    '<path d="M12 2l8.7 5v10L12 22l-8.7-5V7z" fill="currentColor"/>' +
    '<circle cx="12" cy="9" r="1.8" class="w"/><circle cx="9" cy="14.5" r="1.8" class="w"/><circle cx="15" cy="14.5" r="1.8" class="w"/>',
  search:
    '<circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2.6"/>' +
    '<path d="M15.8 15.8L21 21" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
  plus:
    '<rect x="10.8" y="4" width="2.4" height="16" rx="1.2" fill="currentColor"/>' +
    '<rect x="4" y="10.8" width="16" height="2.4" rx="1.2" fill="currentColor"/>',
  back:
    '<path d="M10.5 5L4 12l6.5 7" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M4.5 12h15" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/>',
  send:
    '<path d="M21 3L3.5 11.5 11 14z" class="a"/>' +
    '<path d="M21 3l-10 11 3.5 7z" fill="currentColor"/>',
  reply:
    '<path d="M20 6.5h-9a5 5 0 0 0-5 5V18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>' +
    '<path d="M10.5 13.5L6 18l4.5 4.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
  retry:
    '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>' +
    '<path d="M19.8 2.8v5h-5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
  close:
    '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/>',
  check:
    '<path d="M4.5 12.5l5.5 5.5L19.5 6.5" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>',
  box:
    '<rect x="4" y="9" width="16" height="11" rx="1.5" fill="currentColor"/>' +
    '<rect x="2.5" y="4.5" width="19" height="4.5" rx="1.5" fill="currentColor"/>' +
    '<rect x="10.8" y="4.5" width="2.4" height="15.5" class="a"/>',
  tray:
    '<path d="M4 13.5V19a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>' +
    '<path d="M12 3v10.5" fill="none" class="sa" stroke-width="2.6" stroke-linecap="round"/>' +
    '<path d="M7.5 10L12 14.5 16.5 10" fill="none" class="sa" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
  card:
    '<rect x="3" y="6" width="18" height="12" rx="2.5" fill="currentColor"/>' +
    '<rect x="6" y="9.8" width="9" height="2.2" rx="1.1" class="w"/>' +
    '<rect x="6" y="13.6" width="6" height="2.2" rx="1.1" class="w" opacity=".65"/>',
  globe:
    '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.4"/>' +
    '<ellipse cx="12" cy="12" rx="4.2" ry="9" fill="none" class="sa" stroke-width="2"/>' +
    '<path d="M3.2 12h17.6" class="sa" stroke-width="2" stroke-linecap="round"/>',
  clock:
    '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.4"/>' +
    '<path d="M12 7v5.5l4 2.5" fill="none" class="sa" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  warn:
    '<path d="M12 3.5L22 20H2z" class="o" stroke-linejoin="round"/>' +
    '<rect x="11" y="9" width="2" height="6" rx="1" class="w"/>' +
    '<circle cx="12" cy="17.2" r="1.4" class="w"/>',
  burst:
    '<g stroke="currentColor" stroke-width="2.4" stroke-linecap="round">' +
    '<line x1="12" y1="5.5" x2="12" y2="2"/><line x1="16.6" y1="7.4" x2="19" y2="5"/>' +
    '<line x1="18.5" y1="12" x2="22" y2="12"/><line x1="16.6" y1="16.6" x2="19" y2="19"/>' +
    '<line x1="12" y1="18.5" x2="12" y2="22"/><line x1="7.4" y1="16.6" x2="5" y2="19"/>' +
    '<line x1="5.5" y1="12" x2="2" y2="12"/><line x1="7.4" y1="7.4" x2="5" y2="5"/></g>' +
    '<circle cx="12" cy="12" r="3.6" class="a"/>',
};

/** Inline SVG icon. `size` is an extra class (e.g. "big"). Decorative: hidden from AT. */
function icon(name, size) {
  return `<span class="ic${size ? " " + size : ""}" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false">${ICONS[name] || ""}</svg></span>`;
}
