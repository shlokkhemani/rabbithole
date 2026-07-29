# Nora Design System

This document defines Nora's visual vocabulary, interaction behavior,
accessibility requirements, and review standard for the VS Code webview and
self-contained snapshots.

## Scope

- Nora UI runs in a VS Code webview and uses VS Code theme variables where the
  host exposes them.
- Snapshots remain self-contained, inert, and offline-capable.
- `src/core/html/tokens.js` is the runtime token payload. Product chrome should
  consume those named tokens rather than inventing local scales.
- Vendored KaTeX, Highlight.js, Mermaid, PDF.js, and DOMPurify styles are
  outside this design system except where Nora wraps them in product chrome.
- Product-owned SVG icons and brand marks live in `src/core/html/icons.js`.

## Token Rules

- Base UI text is `14px/1.55`.
- The compact label ladder is `10/11/12/13/14/17px`.
- Control heights are `24/28/36/44px`; controls in the same tier use the same
  used height.
- Icon-only action controls use `28px`; compact icon controls use `24px`.
- Standard radii are `4px` inline, `6px` controls, `8px` larger controls,
  `10px` cards, `12px` anchored popovers, and `16px` conversational surfaces.
- Hover color transitions use the fast token. Surface entrance and dismissal use
  the surface transition token.
- Elevation has card, popover, and modal levels only.
- The keyboard focus ring is the accent ring with the configured offset.
  Pointer focus must not summon the keyboard ring.
- Layer token names and order are normative.
- Document rhythm uses the `--doc-*` token subsystem and may scale with Reader
  and Canvas zoom. Chrome spacing tokens must not be used as document rhythm.

Structural literals such as `0`, `1px`, `100%`, intrinsic dimensions, and
feature-specific aspect ratios are allowed. Any other non-token visual value
must be a local optical correction with an inline comment that includes the word
`optical` and names the surface it serves.

## Layout and Surfaces

- Reader mode prioritizes long-form reading, selected-text origins, branch
  navigation, search, and follow-up entry.
- Canvas mode prioritizes spatial navigation, panning, zooming, card movement,
  resizing, collapse, and branch relationships.
- Do not put a page section inside a decorative card. Cards are for repeated
  nodes, modals, and framed tools.
- Anchored popovers, selection prompts, menus, and palette surfaces use the
  shared measure-then-clamp anchoring engine. Guessing fixed proxy bounds is not
  acceptable.
- Every transient surface closes with Escape and outside click where applicable.
  Closing restores focus to the trigger that opened it.
- Dialogs trap focus, provide a visible title, and release focus predictably.
- Toolbar groups are ordered by task: navigation, view, layout, source/actions,
  activity. Hide unavailable groups rather than showing disabled dead controls.

## Product Behavior

- `Ask Nora` is transient and scoped to the selected node, selected text, PDF
  region, or whole canvas. It must not become a persistent chat surface.
- Run status is visible and accessible for `pending`, `running`, `complete`,
  `cancelled`, `failed`, and recovered interrupted material.
- Run Details show technical transcript/provenance as an inspection view, not as
  a second composer.
- Streaming follows the tail only while the user remains near the tail. Scroll,
  pointer, or keyboard input disengages automatic following.
- Partial cancelled or failed content remains selectable and exportable.
- Repository evidence and attachment provenance should be visible where it helps
  trust the result, without exposing local cache paths or credentials.
- Empty and error states explain what happened and what action is available next.

## Accessibility

- All controls have programmatic labels.
- Icon-only buttons use accessible names and hover/focus descriptions when the
  icon is not universally obvious.
- Keyboard operation must cover Reader/Canvas switching, Ask Nora, search,
  selection prompts, branch navigation, popovers, dialogs, Run Details, and
  export actions.
- `:focus-visible` is required for keyboard rings.
- Reduced-motion preference disables non-essential transitions through tokens.
- Light and dark modes use the same semantic token names.

## Review Standard

A UI change is unfinished until it has:

- Real Chromium review through the webview or webview harness.
- Keyboard-only review.
- Screen-reader role/name sanity review for changed controls.
- Light and dark theme review.
- Designed loading, empty, failure, cancellation, and recovery states.
- No overlapping text, clipped labels, layout shifts from dynamic labels, or
  accidental token-scale forks.

Behavior changes require a deliberate design-system update when they establish a
new reusable rule. Existing component code does not override this document by
accident.
