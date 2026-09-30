<!-- markdownlint-disable -->

# AGENTS.md — WA-Gateway

> **Project Description:** WA-Gateway is a Node.js WhatsApp gateway based on Baileys for the AuliaPos Shared WhatsApp Inbox. It owns the WhatsApp session, stores incoming messages in a durable SQLite buffer, forwards them to AuliaPos CI4, and receives outgoing send commands from CI4. The repository also contains Android (`android/`) and Windows supervisor (`supervisor/`) variants.

`README.md` contains feature-specific design decisions. Read the relevant section before modifying a feature.

# 1. Core Engineering Principles

## 1.1 Spec-First & Impact-Aware

Do not write code immediately.

Before changing code:

1. Understand the requirement and requested behavior.
2. Read the relevant code.
3. Trace the real flow end-to-end.
4. Identify callers, consumers, dependencies, and affected platforms.
5. Read the relevant `README.md` design decision.
6. Check the POS-side contract when CI4 integration is involved.
7. Clarify anything that can materially change the implementation.
8. Create an execution plan.
9. Wait for explicit user approval before making code changes.

## 1.2 Efficient Senior Developer Principles

Efficiency means avoiding unnecessary work and unnecessary code. It does not mean sacrificing correctness.

After understanding the problem:

1. Does this need to be built at all? **YAGNI.**
2. Does it already exist in the repository? Reuse the existing helper, utility, store, or pattern.
3. Does Node.js standard library solve it?
4. Does an already-installed dependency solve it?
5. Only then write the minimum code required.

Prefer existing project utilities such as:

* `src/whatsapp/jidUtils.js`;
* `normalize.js`;
* `src/store/*`;

when they already provide the required behavior.

Prefer already-installed dependencies where appropriate, including:

* `baileys`;
* `better-sqlite3`;
* `express`;
* `pino`;
* `@hapi/boom`.

Principles:

* Deletion over addition.
* Boring over clever.
* Fewest files possible.
* No unnecessary abstractions.
* No unnecessary dependencies.
* No unnecessary boilerplate.
* No unrelated refactors.
* Keep the working diff as small as possible.

If a deliberate simplification accepts a meaningful limitation, add a `ponytail:` comment describing the limitation and upgrade path.

## 1.3 Non-Negotiable Gateway Invariants

The following properties must not be weakened for the sake of a smaller diff:

### No Message Loss

Incoming messages must be recorded in the durable SQLite buffer before being considered accepted.

Do not weaken:

* buffering;
* persistence;
* retry;
* dead-letter handling;
* ordering guarantees.

Relevant areas include:

* `src/store/`;
* `src/delivery/`.

### Outgoing Idempotency

Outgoing operations must remain idempotent across process restarts.

Preserve the correctness of:

* `operation_id`;
* the state machine in `src/delivery/outgoingOperationService.js`;
* persistence in `src/store/outgoingOperations.js`.

Do not introduce a code path that can duplicate an outgoing operation after restart.

### Security

Never log:

* `CI4_GATEWAY_TOKEN`;
* contents of `AUTH_FOLDER`;
* credentials;
* other sensitive authentication material.

CI4-facing endpoints in `src/api/ci4Routes.js` must enforce `requireCI4Token`.

### User Data Protection

Do not delete, truncate, reset, or overwrite:

* `auth/`;
* `data/`;

including Android-related paths.

Any operation that may replace or destroy user WhatsApp session data requires explicit approval.

### Logging

Use the project logger under:

`src/logging/`

Do not introduce `console.log` for application logging.

# 2. Communication

## 2.1 Language

`AGENTS.md` is written in **English**.

Communication with the user must be in **Bahasa Indonesia**.

Use **English** for:

* source code;
* code comments;
* file/folder names;
* function and variable names;
* commands;
* library names;
* original error messages;
* official technical terminology.

Use **Bahasa Indonesia** for:

* communication with the user;
* explanations and analysis;
* business/domain documentation.

Technical/design documentation such as `README.md` should use **English**, unless a specific existing section establishes another explicit convention.

Keep technical terms such as `JID`, `@lid`, `operation_id`, and `dead-letter` unchanged.

## 2.2 Tone

Use a style that is:

* clear;
* direct;
* professional;
* concise;
* free of unnecessary small talk;
* free of emojis.

## 2.3 Facts, Assumptions, and Verification

Clearly distinguish between:

* facts verified in the repository;
* assumptions;
* hypotheses;
* information not yet verified.

Never invent:

* file names;
* functions;
* Baileys events;
* endpoints;
* payload fields;
* behavior.

If something is unknown, inspect it first or state that it is **not yet verified**.

# 3. Task Execution Protocol

## Phase 1 — Understand the Spec & Check Impact

### Do not write code yet.

Start by:

1. Restating the task in one sentence.
2. Naming the files/functions likely to be affected.
3. Reading the relevant implementation.
4. Tracing the flow end-to-end.
5. Searching all callers.
6. Checking the relevant `README.md` decision.
7. Checking desktop and Android paths when applicable.
8. Checking CI4/POS consumers when integration is involved.

For incoming messages, trace the persistence and delivery path.

For outgoing messages, trace operation creation, persistence, state transitions, sending, acknowledgement, retry, and restart behavior.

For endpoint changes, inspect both Gateway and CI4 consumers.

### Clarification Rules

Ask only when the answer can change the result.

Always ask before changing the cross-repository contract, including:

* `/send`;
* `/send-media`;
* `/media/download`;
* delivery payloads;
* authentication behavior;
* delivery semantics.

Also ask when:

* scope is ambiguous;
* business rules are undefined;
* multiple materially different approaches are valid;
* data loss is possible;
* a destructive operation is involved;
* desktop and Android behavior may intentionally differ.

Ask at most **one round**, with at most **3 numbered questions**.

## Phase 2 — Work Plan & Mitigation

After the specification is clear, provide a concise plan, normally **3–5 steps**.

Include:

* goal;
* files to modify or create;
* major changes;
* dependency usage;
* impact mitigation;
* verification/testing;
* important edge cases.

When multiple approaches are viable:

```text
Ada 2 opsi:

A. <short name> — <main consequence / trade-off>

B. <short name> — <main consequence / trade-off>

Rekomendasi: A, karena <most important reason>.
```

Maximum 3 options.

Always provide one recommendation when multiple viable approaches exist.

Explain concrete consequences such as:

* message-loss risk;
* CI4 impact;
* behavior after restart;
* behavior after connection loss;
* Android/desktop differences.

After the plan, ask:

> "Apakah rencana dan penanganan dampaknya sudah sesuai untuk dieksekusi?"

### Approval Gate

**Do not write or modify code until the user explicitly approves the plan**, such as `OK` or `Lanjut`.

## Phase 3 — Execution

After approval:

* implement the agreed changes;
* preserve the existing delivery and storage guarantees;
* keep the diff minimal;
* avoid unrelated changes;
* run the required verification.

If implementation reveals a material change in contract, state machine, persistence behavior, security, or platform impact, stop and request approval for the revised plan.

# 4. Bug Fix & Root Cause

A bug report describes a symptom, not necessarily its cause.

For bug fixes:

1. Identify the symptom.
2. Trace the root cause.
3. Search all callers of the changed function.
4. Fix the shared root cause when appropriate.
5. Check sibling paths.
6. Check all affected delivery, storage, API, and platform paths.
7. Verify the regression.

When relevant, distinguish:

* dashboard API: `src/api/routes.js`;
* CI4 API: `src/api/ci4Routes.js`;
* desktop behavior;
* Android behavior.

If the cause is uncertain:

* state the candidates;
* state available evidence;
* state what verification is required.

# 5. Technical Investigation Format

Prefer call chains with `file:line` references.

Example:

```text
sock.ev.on('messages.upsert')  (src/whatsapp/connectionManager.js:336)
  → _onMessagesUpsert()
  → normalization
  → enqueueWithRetry()         (src/store/enqueueRetry.js)
  → delivery worker
  → CI4
```

Explain **why** the change is necessary, not merely what the code does.

# 6. Validation, Error Handling & Security

Validate all trust-boundary inputs.

Consider:

* null/empty values;
* malformed payloads;
* invalid types;
* oversized input;
* unauthorized access;
* concurrent processing;
* network failures;
* database failures;
* restart behavior;
* timeout;
* filesystem failures;
* resource limits.

Never:

* log secrets;
* hardcode credentials;
* expose authentication material;
* bypass `requireCI4Token`;
* silently ignore errors that can lose messages;
* weaken retry/dead-letter behavior without explicit approval;
* write untrusted values into database queries or commands unsafely.

# 7. SQLite & Persistence

Treat SQLite as part of the Gateway's durability guarantees.

Before changing storage code, inspect:

* schema;
* initialization;
* write ordering;
* retry behavior;
* dead-letter behavior;
* ordering;
* state transitions;
* restart recovery;
* concurrent access.

Do not use production database files for automated tests.

Do not perform destructive storage operations without explicit user approval.

# 8. Incoming Message Delivery

Incoming message acceptance must preserve this invariant:

```text
WhatsApp event
  → normalize
  → durable SQLite persistence
  → delivery/retry
  → CI4
```

Do not consider a message successfully received before the durable persistence step has completed.

Any change to ordering, retry, dead-letter, or worker behavior must be analyzed for:

* message loss;
* duplicate delivery;
* out-of-order delivery;
* restart recovery.

# 9. Outgoing Message Operations

Outgoing operations must preserve durable idempotency.

Inspect the full lifecycle involving:

* `operation_id`;
* operation creation;
* persistence;
* state transitions;
* send attempt;
* acknowledgement/result;
* retry;
* restart recovery.

Do not change one state transition without checking all other transitions and recovery paths.

# 10. CI4 ↔ Gateway Contract

The Gateway and AuliaPos CI4 are separate systems with a shared contract.

Treat changes to any of the following as cross-repository changes:

* `/send`;
* `/send-media`;
* `/media/download`;
* request/response payloads;
* delivery payloads;
* authentication;
* error semantics;
* retry semantics;
* operation identifiers;
* message-state behavior.

Before implementation:

1. Inspect the Gateway provider side.
2. Inspect the CI4 consumer side when available.
3. Determine backward compatibility.
4. Identify failure behavior.
5. Get explicit user approval.

Never assume that a Gateway-only modification is safe when CI4 consumes the affected behavior.

If the POS repository is unavailable in the current workspace, state that its side is **not yet verified**.

# 11. Platform Scope: Desktop & Android

The repository includes platform-specific areas.

When a change touches shared behavior, determine whether it affects:

* Node.js desktop/runtime;
* Android;
* Windows supervisor;
* shared storage or authentication paths.

Do not assume Android and desktop are behaviorally identical.

For platform-specific behavior that cannot be tested automatically, state it explicitly as **belum diverifikasi**.

# 12. Testing

Tests are standalone Node.js scripts using `assert` and should follow the existing patterns under:

`test/`

Examples include:

* `simulate-*.js`;
* `check-*.js`.

Run them individually:

```text
node test/<name>.js
```

## SQLite Isolation

Every test must set `SQLITE_PATH` to a temporary directory **before requiring any `src/` module that initializes database access**.

Tests must never touch:

```text
data/gateway.sqlite
```

## Baileys Isolation

Baileys must be stubbed where needed.

Use deterministic stubs for behaviors such as:

* `connectionManager.sendReply`;
* `isConnected`.

Automated tests must not require a real WhatsApp connection.

## Non-Trivial Logic

Every non-trivial logic change must leave at least one standalone test script that would fail if the logic were broken.

Follow existing repository test patterns instead of introducing a new framework.

## Real-Device / Real-WhatsApp Verification

Behavior that can only be verified with:

* a real WhatsApp connection;
* a real phone;
* Android runtime;
* actual session state;

must be explicitly labeled:

**belum diverifikasi**

Follow the existing README structure:

* **Yang sudah diverifikasi**
* **Yang PERLU kamu jalankan/verifikasi sendiri**

Never claim real-device behavior was tested when it was not.

# 13. Logging

Use the logger under:

`src/logging/`

Do not use `console.log` for application logging.

Never log:

* `CI4_GATEWAY_TOKEN`;
* credentials;
* authentication folder contents;
* WhatsApp session secrets;
* sensitive message data unless explicitly required and safely redacted.

# 14. User Data & Filesystem Safety

Treat the following as persistent user data:

* `auth/`;
* `data/`.

Do not:

* delete them;
* reset them;
* replace them wholesale;
* overwrite them;
* use them as disposable test storage.

Any potentially destructive filesystem operation requires explicit user approval.

# 15. Git & Workspace Hygiene

Do not:

* delete user changes;
* overwrite work not created by the agent;
* perform destructive Git operations without explicit approval;
* use `reset`, `checkout`, `restore`, `clean`, or equivalent destructive commands without confirmation;
* modify unrelated files.

Keep the diff focused.

Avoid mass formatting and unrelated refactoring.

# 16. Dependency Management

Before adding a dependency, check:

1. existing Gateway code;
2. Node.js standard library;
3. already-installed dependencies;
4. existing project patterns.

Add a dependency only when genuinely necessary.

If added:

* explain why;
* consider maintenance and security cost;
* avoid using a dependency for a trivial problem.

# 17. Source of Truth

Use this order of repository sources for technical verification:

1. current user requirement;
2. this `AGENTS.md`;
3. relevant `README.md` design decisions;
4. verified current code;
5. tests and observed behavior;
6. assumptions.

When these conflict and the conflict can affect behavior, data, security, or compatibility, identify the conflict and ask the user.

Do not silently resolve material contradictions.

Do not treat conversation history or ChatGPT memory as authoritative project documentation.

# 18. Persistent Project Knowledge & Memory

Do not rely on ChatGPT memory to preserve:

* delivery guarantees;
* API contracts;
* state-machine rules;
* storage rules;
* authentication requirements;
* architecture decisions;
* platform-specific behavior;
* important operational constraints.

Persist important project knowledge in the repository, such as:

* `AGENTS.md`;
* `README.md`;
* `docs/`;
* architecture documentation;
* changelog;
* source code where the information is part of the implementation contract.

A new agent should be able to understand the Gateway without depending on prior conversations.

# 19. Design Decision Documentation

`README.md` is the feature-level design decision record.

For new features or behavior changes, update the relevant `README.md` section with:

* the design decision;
* files changed;
* behavior and constraints;
* what has been verified;
* what still needs manual verification.

Use **English** for technical/design documentation.

Business/domain documentation intended for the Indonesian team may use **Bahasa Indonesia**.

# 20. Code Comments

Code comments must be written in **English**.

Add comments only when the reasoning or constraint is not obvious from the code.

For deliberate simplifications with a known ceiling:

```text
ponytail: <constraint / ceiling>; upgrade path: <future improvement>
```

# 21. Commit Messages

Use the repository's established commit convention:

```text
feat(scope): ...
fix(scope): ...
```

Commit messages must be written in **English**.

Describe:

* what changed;
* why it changed.

# 22. Final Report

After implementation, keep the final report to **2–4 lines**:

* what changed and where;
* test script(s) run and results;
* anything not yet verified, especially WhatsApp/Android/manual behavior.

Do not repeat the diff or write a long summary.

# 23. Instruction Priority

When rules conflict, use:

1. **Message durability & data integrity**
2. **Security**
3. **Explicit user requirements**
4. **Cross-repository contract compatibility**
5. **Documented Gateway design decisions**
6. **Backward compatibility**
7. **Existing architecture and conventions**
8. **YAGNI / minimum implementation**
9. **Code elegance and optimization**

If a material conflict remains unresolved, ask the user rather than guessing.

# 24. Completion Checklist

Before declaring a task complete:

* [ ] Requirement is understood.
* [ ] Relevant callers were checked.
* [ ] Root cause was addressed for bug fixes.
* [ ] Incoming message durability was preserved when relevant.
* [ ] Outgoing idempotency was preserved when relevant.
* [ ] Retry/dead-letter/order behavior was checked when relevant.
* [ ] CI4 contract impact was checked when relevant.
* [ ] Android/desktop impact was checked when relevant.
* [ ] Security and secret handling were checked.
* [ ] `auth/` and `data/` safety was preserved.
* [ ] No unnecessary dependency or abstraction was introduced.
* [ ] Tests use temporary `SQLITE_PATH`.
* [ ] Tests do not touch `data/gateway.sqlite`.
* [ ] Real WhatsApp/Android behavior is clearly marked when not verified.
* [ ] Relevant `README.md` documentation was updated for feature/behavior changes.
* [ ] No unrelated files were changed.
* [ ] Test results are reported truthfully.
* [ ] No unverified behavior is presented as verified.
