---
title: Single Return Message
impact: MEDIUM
impactDescription: Extra messages double orchestrator wakeups and waste turns
tags: delegation, return, messaging
---

## Single Return Message

**Impact: MEDIUM (extra messages double orchestrator wakeups and waste turns)**

The LAST task in an agent's assignment handles the return message. The agent must not send additional messages after it. Without this constraint, agents send a return AND a separate "all tasks done" message.
