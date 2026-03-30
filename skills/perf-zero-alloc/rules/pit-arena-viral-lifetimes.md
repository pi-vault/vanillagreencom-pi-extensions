---
title: Arena Viral Lifetimes
impact: HIGH
impactDescription: Arena lifetime parameters spread through all consumers, making refactoring expensive
tags: pitfall, arena, lifetime, bumpalo
---

## Arena Viral Lifetimes

**Impact: HIGH (arena lifetime parameters spread through all consumers, making refactoring expensive)**

Arena-allocated types propagate lifetime parameters through all consumers:

```rust
// BAD: Arena lifetime infects all downstream types
struct ParsedMessage<'arena> {
    symbol: &'arena str,
    levels: Vec<&'arena PriceLevel>,
}

fn process(msg: ParsedMessage<'_>) { ... } // Lifetime everywhere
```

Once one field borrows from an arena, the lifetime spreads to the containing struct, all methods, trait impls, and callers. Refactoring back to owned types later is expensive.

**Mitigation**:
- Confine arena references to a single processing phase — copy out owned data before crossing module boundaries
- Prefer `arena.reset()` between phases over long-lived arena borrows
- Only adopt arena lifetimes where profiling confirms the allocation overhead justifies the complexity

```rust
// GOOD: Arena confined to parse phase, owned data crosses boundaries
fn parse_phase<'a>(arena: &'a Bump, input: &[u8]) -> OwnedMessage {
    let temp: ParsedMessage<'a> = parse_into_arena(arena, input);
    temp.to_owned() // Copy out before arena reference escapes
}
// arena.reset() here — all borrows are dead
```
