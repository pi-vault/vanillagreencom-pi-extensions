---
title: Lifecycle Stages
impact: HIGH
impactDescription: Agent lifecycle confusion causes missed or duplicated work
tags: life
---

## Lifecycle Stages

**Impact: HIGH (Agent lifecycle confusion causes missed or duplicated work)**

```
1. SPAWN        Spawn agent with behavioral prompt → agent goes idle
2. DELEGATE     Send delegation message
3. WORK         Agent wakes, finds PENDING tasks, sets in-progress, processes in order
4. RETURN       Last workflow section sends completion message to orchestrator
5. IDLE/REDEL   Agent goes idle — may receive new tasks + message for fix cycles
6. SHUTDOWN     Orchestrator sends shutdown request when all work complete
```
