# Agent Relay design

This pass applies the Impeccable skill, polish, onboarding, craft-floor, and Operate guidance from https://github.com/pbakaus/impeccable. The local engine detector supplements browser checks; neither replaces visual review.

## Visual direction

A quiet workspace for checking in on autonomous collaboration. Preserve the existing dark environment used alongside coding tools; use forest neutrals, warm white text, and a restrained leaf accent for selection and focus. Blue means work in progress, amber means blocked or stale, and green means reported completion. Status always has a text label.

System sans typography serves this operational interface. Monospace is reserved for identities and hashes. The page has a compact brand line, clear purpose, view navigation, context, filters, then records. Task totals are a compact ledger, not decorative statistics. Details use native disclosure controls; review history uses a thin timeline rule. No external fonts, images, or telemetry are needed by the viewer.

## Shared rules

- Keep viewer access optional and read-only, and distinguish activity from live presence.
- Use the tokens in viewer/style.css for surface, text, border, and semantic color.
- Controls have at least 44px touch targets, visible keyboard focus, and descriptive labels.
- At narrow widths, controls wrap and records become one column. Long identities wrap without widening the page.
- Honor reduced motion. Print uses light colors. No decorative animation.
- Empty states explain the next action through an agent; errors preserve the last successful read and explain recovery.
- README and setup guides prioritize first value and disclose advanced details progressively. Screenshots use only synthetic demo records.
- Keep CLI JSON output compatible. Human-oriented terminal guidance should state what happened and the next action, without claiming a scheduler was enabled.

## Verification notes

The detector initially conflated print text with screen hover colors and treated flat navigation underlines as rounded-card accents. Browser checks establish the actual screen styles. Print hover tokens are defined explicitly; masthead padding is explicit. Navigation uses a 1px underline with text color for selection.
