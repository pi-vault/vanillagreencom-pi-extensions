# Parity Audit Workflow

Post-implementation audit for leaf components. Run after implementation to verify Base UI parity before closure.

## Steps

1. **Capture the reference**
   - Open shadcn Base UI docs page for the target component using `agent-browser` skill or other web browsing tools
   - Switch to **Base UI** tab if present; record `Base UI tab confirmed` with screenshot evidence
   - Record the exact example heading set and order from the reference page before comparing local output
   - Capture interactive states: open/close, disabled, variants, keyboard behavior

2. **Capture local implementation**
   - Widget behavior implementation
   - Viewer/showcase page composition
   - Demo/preview state
   - Test coverage
   - Use screenshot tools for visual comparison when needed

3. **Build gap checklist** (per `references/checklist.md`)
   - Compare every reference heading against the local page 1:1
   - Treat extra local sections as findings unless the mapping table explicitly marks them `Adapted` or `Excluded`

4. **Record interaction proof** for behavioral components (per `references/checklist.md` § Deliverables)
   - Include full-row trigger hit-target coverage and vertical alignment checks when the component exposes a disclosure/control row

5. **Update issues** per `references/issue-guidance.md`

6. **Closure gate** — per `references/checklist.md` § Deliverables. Do not mark Done until post-implementation audit is recorded.
