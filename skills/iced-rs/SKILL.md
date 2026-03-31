---
name: iced-rs
description: Iced 0.14 UI patterns, framework constraints, and development practices for reactive applications. Use when implementing Iced views, widgets, layouts, pane_grid, Canvas, or subscriptions.
license: MIT
user-invocable: true
metadata:
  author: vanillagreen
  version: "1.0.0"
---

# Iced 0.14 Patterns

> **Note**: `README.md` in this directory is for human setup/configuration only — not for AI agents. Follow this file (`SKILL.md`) as the authoritative skill definition.

Patterns for building Iced 0.14 applications with Elm-style state management, prioritized by impact.

## When to Apply

Reference these guidelines when:
- Implementing or modifying Iced views, widgets, or layouts
- Working with pane_grid, Canvas, Shader, or Subscription
- Choosing between normal widgets, `Canvas`/`Shader`, and `iced::advanced` for a new surface
- Building custom themes or styling components
- Debugging interaction issues (drag/drop, overlays, event routing)
- Reviewing UI code for framework constraint violations

## Nomenclature

App > Window > Shell > Zone > TitleBar > Panel > Canvas > Overlay

## Dev Tools

| Tool | Purpose | Install |
|------|---------|---------|
| `cargo-hot` | Live UI patching without restart | `cargo install cargo-hot` |
| `comet` | Iced debugger: frame metrics, widget tree, message inspector | `cargo install --locked --git https://github.com/iced-rs/comet.git` |

## Rule Categories by Priority

| Priority | Category | Impact | Prefix |
|----------|----------|--------|--------|
| 1 | Framework Constraints | CRITICAL | `hr-` |
| 2 | Development Practices | HIGH | `dev-` |
| 3 | Cache & Multi-Window | HIGH | `cache-` |
| 4 | Elm Architecture | MEDIUM | `elm-` |
| 5 | Interaction | MEDIUM | `interaction-` |

## Quick Reference

### 1. Framework Constraints (CRITICAL)

- `hr-widget-tree-consistency` - Keep widget structure stable across interaction states; toggle behavior, not wrappers
- `hr-view-is-pure` - Keep `view()` a pure projection of state; mutate only in `update()`
- `hr-scroll-state` - `scrollable` events do not report initial layout; capture initial size explicitly before relying on scroll updates
- `hr-animation-invalidation` - Animated geometry changes require both `request_redraw` and `invalidate_layout`; paint-only changes need just redraw; extract shared motion primitives when 2+ components share behavior
- `hr-minimum-pane-size` - `PaneGrid::min_size` is shared across panes; handle per-pane minimums in pane content/layout
- `hr-overlay-state-isolation` - Overlay layers must not affect the base layer's widget structure
- `hr-pick-area-geometry` - TitleBar content must use `Shrink` width so pick area is not consumed
- `hr-single-message` - Each widget interaction produces exactly one message; use state machines for composites
- `hr-titlebar-event-ordering` - Title bar processes before body in `pane_grid::Content::update`; do not clear state unconditionally in body-exit handlers

### 2. Development Practices (HIGH)

- `dev-validate-api` - Verify API against docs; Iced 0.14 has breaking changes from 0.13
- `dev-surface-selection` - Use normal widgets for standard UI, `Canvas`/`Shader` for custom visuals, and `iced::advanced` only for new control behavior
- `dev-reactive-discipline` - Never redraw from view(), invalidate caches explicitly, batch ~16ms
- `dev-instrument-budgets` - iced::debug::time on every function with a performance budget
- `dev-no-redundant-subscriptions` - Extend existing event listeners before adding new ones
- `dev-press-and-hold` - button fires on release; use mouse_area for true mouse-down
- `dev-smoke-test` - Run app after UI changes; clippy misses runtime panics

### 3. Cache & Multi-Window (HIGH)

- `cache-trace-staleness` - Enumerate every mutation path that can stale cached state
- `cache-extend-event-paths` - Extend existing global event path over parallel subscriptions
- `cache-regression-tests` - Test each non-obvious invalidation or source-window gate

### 4. Elm Architecture (MEDIUM)

- `elm-state-in-root` - Message enum and State struct stay in root module
- `elm-extraction` - Extract feature-gated, cohesive, or >30-line State subsets to modules

### 5. Interaction (MEDIUM)

- `interaction-overlay-starvation` - Cursor overlays starve underlying drag targets
- `interaction-pane-drag-feedback` - Keep pane_grid drag feedback inside pane subtree; compact previews must reuse existing shell
- `interaction-split-ownership` - When `mouse_area` handles semantics and `button` handles visuals, flag the split and verify hit areas match
- `interaction-overlay-invalidation` - Built-in First for overlays; custom overlays must call `shell.invalidate_layout()` on visibility transitions and maintain the custom widget contract

## How to Use

Read individual rule files for detailed explanations and code examples:

```
rules/hr-widget-tree-consistency.md
rules/dev-reactive-discipline.md
```

Each rule file contains:
- Brief explanation of why it matters
- Incorrect code example with explanation
- Correct code example with explanation

The `hr-` prefix is historical. Reserve it for broad Iced constraints, not app-specific pane-grid or overlay workflows.

## Resources

**For ANY Iced documentation lookup — research, implementation, or verification — use `find-docs` skill with ctx7 CLI first.** Iced 0.14 has significant API changes. Never assume — always verify.

Documentation lookup order: local skill files → ctx7 CLI → web fallback.

### ctx7 CLI

| Library | ctx7 ID | Use For |
|---------|---------|---------|
| Iced 0.14 | `/websites/rs_iced_iced` | Widgets, Theme, Canvas, Shader, Subscription, pane_grid |
| tokio | `/websites/rs_tokio` | Async runtime, channels, streams |
| wgpu | `/websites/rs_wgpu` | GPU rendering, shader pipelines |

### Web

| Source | URL | Use For |
|--------|-----|---------|
| Iced API docs | `https://docs.iced.rs/iced/` | API reference (tracks master — may serve unreleased APIs) |
| Iced GitHub | `https://github.com/iced-rs/iced` | Examples, issues, PRs |
| Iced Docs Repo | `https://github.com/iced-rs/docs` | Guides, tutorials |
| Iced examples | `https://github.com/iced-rs/iced/tree/master/examples` | Reference implementations |

## Full Compiled Document

For the complete guide with all rules expanded, plus chart rendering, subscriptions, theming, API reference, widget catalog, and shell chrome patterns: `AGENTS.md`
