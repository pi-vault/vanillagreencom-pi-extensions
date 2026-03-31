# Component Parity Checklist

## Reference Capture

1. Open the shadcn Base UI docs page for the target component using `agent-browser` skill or other relevant web browsing tools.
2. If a `Base UI` tab exists, switch to it before evaluating behavior.
3. Record `Base UI tab confirmed` in review notes with screenshot evidence.
4. Capture:
   - interactive snapshot
   - full-page screenshot
   - extra screenshots for interaction-dependent states when needed
5. Interact with examples that prove behavior differences:
   - single vs multiple open
   - collapsible vs forced-open
   - disabled items
   - card/border/surface variants
   - RTL/direction if the component has meaningful directional behavior

## Local Capture

Review:

- Widget implementation source
- Showcase/viewer page composition
- Preview/demo state
- Test files

Capture a local viewer screenshot when layout, density, or interaction framing matters.

## Comparison Rubric

Build the checklist under these headings. Every parity review must explicitly sign off on all three surfaces: widget behavior, viewer-page parity, and validation evidence.

Before implementation, create a **reference mapping table**:

| Reference example/section | Local example/section | Status | Notes |
| --- | --- | --- | --- |

Use `Matched`, `Excluded`, or `Planned` for `Status`. Do not collapse multiple reference sections into one local section without noting that explicitly.

Also capture the exact reference heading set and compare 1:1 against the local page:

| Reference heading | Local heading | Status | Evidence |
| --- | --- | --- | --- |

Use `Matched`, `Excluded (reason)`, `Adapted (reason)`, or `Missing`. Extra local headings count as deviations too.

1. Widget behavior
- open/close modes
- transition behavior and motion timing when the reference animates
- disabled behavior
- keyboard/focus behavior
- icon/indicator behavior
- hit target coverage and interaction affordances match the reference for the relevant control surface
- justified gaps caused by Iced or product constraints

2. Styling and polish
- border/card/surface variants
- spacing and density
- iconography and affordances
- trigger/disclosure affordances
- vertical centering of trigger text and indicator
- title/body type hierarchy and body spacing
- unwanted full-perimeter borders, trigger-body separators, or focus outlines
- hover/focus/disabled/open visual states

3. Viewer page parity
- missing examples
- inconsistent page structure
- exact reference heading set vs local heading set
- oversized empty regions
- missing state/variant demos
- missing RTL/direction demos where relevant
- reference section mismatch: local section set vs reference section set
- generic replacement sections (`Variants`, `States`, `Surface Variants`) used where the reference page has concrete example headings

4. Validation
- widget tests
- showcase/preview state coverage
- end-to-end mapping for every surfaced variant: `widget API → preview state → viewer page → tests`
- semantic token/role coverage for component-specific subparts

## Exclusions

Do not scope the following into parity work unless they expose real runtime behavior:

- installation instructions
- CLI snippets
- copy buttons
- docs-site navigation
- code-example blocks as documentation artifacts

## Deliverables

Every parity review should produce:

- a concise findings summary
- a concrete implementation checklist
- a comment on the original component issue
- a follow-up issue when the original issue is already complete or the new work is materially separate

Behavioral components also require an **interaction proof** section before closure:

| Interaction | Reference observed | Local observed | Status | Evidence |
| --- | --- | --- | --- | --- |

Examples:
- right click opens menu
- outside click dismisses
- submenu opens/closes correctly
- disabled rows stay visible but non-interactive
- checkbox/radio rows preserve state
- relevant hit targets and directional variants match reference

After implementation, rerun the parity audit and update the issue with:
- what now matches
- what remains intentionally different
- why those differences are justified

Do not mark a parity issue Done until that post-implementation audit is recorded.
