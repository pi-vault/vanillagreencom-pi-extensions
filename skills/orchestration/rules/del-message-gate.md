---
title: Message Gate Pattern
impact: CRITICAL
impactDescription: Agents process non-delegation messages (notifications, system messages) as directives
tags: delegation, spawn, message-gate
---

## Message Gate Pattern

**Impact: CRITICAL (agents process non-delegation messages as directives)**

Every agent must include a mandatory message gate: for EVERY message, the agent checks for a delegation marker before acting. No marker found → go idle immediately. This positive gatekeeper (check for X before acting) is more robust than negative filtering (ignore Y).

Without it, agents process task-list notifications and other non-delegation messages, producing incorrect work. The delegation arrives separately via a message containing the delegation marker. The agent checks the task list and finds PENDING tasks.
