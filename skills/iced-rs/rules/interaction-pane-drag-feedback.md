---
title: Keep PaneGrid Drag Feedback Internal
impact: MEDIUM
impactDescription: Native Dropped events never arrive
tags: pane_grid, drag, overlay, opaque
---

## Keep PaneGrid Drag Feedback Internal

**Impact: MEDIUM (native Dropped events never arrive)**

If pane dragging uses `pane_grid.on_drag(...)`, keep feedback inside the picked pane subtree or `pane_grid::Style`. `mouse_area`/`opaque` pane-drag overlays are rebuild-sensitive and can prevent native `Dropped` events from arriving.

Compact drag previews are safe only when they reuse the same TitleBar/body shell and swap leaf styling or content in place — do not build a separate overlay widget for the preview. Passive cursor indicators (e.g., a cursor icon change) are fine; `mouse_area`/`opaque` pane-drag overlays that capture input are not. Drop-zone highlight state is rebuild-sensitive and must live inside the pane subtree or be driven by `pane_grid::Style`.
