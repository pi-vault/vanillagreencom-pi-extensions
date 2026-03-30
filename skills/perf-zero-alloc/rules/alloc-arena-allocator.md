---
title: Arena Allocator Guidance
impact: MEDIUM
impactDescription: Premature arena adoption adds viral lifetime complexity without measurable benefit
tags: allocation, arena, bumpalo, hot-path
---

## Arena Allocator Guidance

**Impact: MEDIUM (premature arena adoption adds viral lifetime complexity without measurable benefit)**

Arena allocators (e.g., bumpalo) are conditional — use only where profiling confirms allocator cost is a meaningful contributor to tail latency.

**When to consider**:
- Parsing or deserialization phases with many short-lived allocations
- Temporary scratch space in request-processing pipelines
- Phases where `dhat`/`heaptrack` shows allocation overhead in P99.9

**When NOT to use**:
- Hot paths already designed for zero allocation — arenas add no value
- Startup or configuration code — not latency-sensitive
- Anywhere the "viral lifetimes" cost (see `pit-arena-viral-lifetimes`) exceeds the allocation savings

**If justified**: Use per-thread `Bump` arenas with phase-oriented reset — allocate, use, then `arena.reset()` at phase boundaries. Confine arena references to a single processing phase and copy out owned data before crossing module boundaries.

**Before adopting**: Profile with `dhat` or `heaptrack` to confirm allocator cost. Arena integration adds lifetime complexity that is expensive to remove later.
