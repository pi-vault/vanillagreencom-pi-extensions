---
title: Nested Workflow Invocation
impact: CRITICAL
impactDescription: Ad-hoc substitution breaks task tracking and recovery
tags: workflow, nested, subflow
---

## Nested Workflow Invocation

**Impact: CRITICAL (ad-hoc substitution breaks task tracking and recovery)**

Nested workflows (marked with `⤵`) must be invoked through the harness's workflow invocation mechanism — never inlined or substituted with ad-hoc commands. If the marker includes a return point (`→ § X`), note it for compaction resilience.
