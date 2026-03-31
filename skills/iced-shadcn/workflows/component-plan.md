# Component Planning Workflow

Use when planning new components, deciding foundation-vs-leaf, or implementing component families.

## Steps

1. **Classify the target by family**
   - menu: context menu, dropdown menu, select, combobox, menubar, navigation menu
   - overlay: popover, hover card, tooltip, dialog, drawer, sheet
   - selection/input: checkbox, radio, switch, toggle, input, textarea, combobox
   - display/data: badge, card, separator, table, accordion, tabs, carousel

2. **Study the reference sources**
   - shadcn Base UI docs for the target component — behavior, examples, states, interactions
   - ctx7 Iced 0.14 docs when work touches `iced::advanced` (custom Widget, Overlay trait, overlay::Group)
   - [iced-shadcn reference crate](https://github.com/FerrisMind/shadcn-rs/tree/master/crates/iced-shadcn) for architecture patterns — use `agent-browser` to fetch the specific component files you need
   - Local widget and showcase code in your project

3. **Map reference examples to local implementation**
   Build a reference mapping table before coding:
   | Base UI example/section | Local equivalent | Status | Notes |
   | --- | --- | --- | --- |
   Use `Matched`, `Planned`, or `Excluded (reason)` for Status.
   Preserve the reference heading names and order in this table. Do not collapse named examples into generic buckets like `Variants` or `States` unless the deviation is explicitly justified.

4. **Decompose the family**
   - Shared primitives (overlay positioning, menu rendering, state management)
   - Thin wrapper components (e.g., context menu wraps menu primitives + popup host)
   - Viewer/demo pages
   - Validation/tests
   - Issue tree (foundation blocks leaves)

5. **Choose foundation-first vs leaf-first**
   - If 2+ components depend on the same primitive → foundation issue first
   - If the work is isolated with no downstream consumers → proceed as leaf

6. **Implement**
   - Reusable behavior in widget modules
   - Demo-only state in showcase/preview modules
   - Pages only compose real widget capabilities via shared helpers
   - Follow builder pattern: constructor → chained modifiers → `Into<Element>`
   - Use project tokens for all dimensions, not hardcoded values
   - When a component has meaningful subparts or variant-specific chrome, define semantic component tokens/roles up front
   - If the component's motion pattern is reusable, extract it into a shared primitive
   - If the Base UI page exposes named examples, mirror those headings in the viewer page

7. **Run parity audit**
   Execute [parity-audit](parity-audit.md) workflow before closure

8. **Update issue structure**
   - Family bundle tracks rollout
   - Foundation issue blocks dependent leaf issues
   - Leaves stay focused on wrapper/page parity, not shared primitives
