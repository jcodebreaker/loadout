---
name: feedback-offline-tests
description: "The user wants tests that run offline and never hit the network; mock every HTTP call at the boundary, keep fixtures invented and small, and say in the PR which tests changed"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 22222222-bbbb-4bbb-8bbb-000000000002
  modified: 2026-09-20T10:00:00.000Z
---

Tests must pass on a plane.

**Why:** A flaky upstream once blocked a release for a day.

**How to apply:** Stub the client at the edge; never record real responses.
