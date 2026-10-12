# Live collaboration acceptance

Use a dedicated private test mailbox and an isolated development directory. Keep
worker identities, raw provider output, local paths, and pending payloads in ignored
runtime storage. Do not reuse an unrelated project's mailbox or publish its history.

## What to verify

1. Initialize the private mailbox and register distinct workers. Verify the real
   MCP transport, then report each worker's actual capabilities and bounded scope.
2. Have an implementation agent create a small task with concrete acceptance
   criteria and produce an artifact. Save a checkpoint before handing it for review.
3. Have a different provider session discover the review through `next_actions`
   or `get_recovery`, inspect the actual artifact, and record its own verdict.
4. Start a fresh implementation process, inspect the checkpoint and current task,
   correct the recorded findings, run tests, and resubmit the current revision.
5. Obtain a fresh independent review. Complete only with passing acceptance
   evidence and current approval. Verify that completion remains in
   `list_notifications` until it has been delivered and acknowledged.
6. Capture a reusable skill from the completed work, obtain independent review,
   publish it, and have the receiving worker inspect and apply that exact version.
   Record actual reuse evidence; publication alone is not reuse.
7. Separately verify host scheduling: enable the authorized supported schedule on
   each host, observe scheduled receipt and continuation, and record actual evidence
   with activation receipts. A manually launched process is not a scheduler test.

An acceptance harness may set up identities and launch sessions, but it must not
fabricate provider verdicts or label scripted mutations as independent reasoning.
Use deliberately seeded defects only when the report identifies the exercise as a
synthetic fixture. Treat claims of completion from either model as reports to verify
against mailbox state and actual artifacts.

## Evidence from this development pass

The local regression suite exercises coordination, recovery, review, skill reuse,
planning, and notification acknowledgement with deterministic simulated workers.
This is distinct from real model execution.

On October 12, 2026, a fresh private test mailbox was created and initialized. The
first live setup attempt exposed GitHub's empty-repository response; initialization
now seeds a generic README only after verifying that the private repository is empty,
then creates the mailbox on a separate orphan branch. The real MCP initialize,
tool-list, and mailbox-read smoke check passed.

The live coding exercise uses an isolated tag-normalization fixture, explicit
acceptance criteria, a saved implementation checkpoint, and a distinct Claude
review worker. Its first real Claude invocation stopped before model inference
because the saved Claude OAuth session had expired. No review verdict was recorded
by that attempt. Authentication status alone was therefore insufficient evidence
that a provider could run.

After normal reauthentication, a real Claude Code session inspected the fixture
and recorded `request_changes` in the mailbox for missing deduplication and input
validation. The Codex builder recovered the checkpoint through a fresh CLI process,
corrected the fixture, ran two executable acceptance tests, and resubmitted. A fresh
Claude session independently approved the current revision in round two. Relay then
accepted task completion. Two notification reads returned the same pending result;
after the result was reported and explicitly acknowledged, the queue was empty.

The builder captured a reusable normalization skill from that completed task. A
separate Claude invocation reviewed the exact immutable draft against source and
tests and approved it before publication.

Claude then read the published skill and generated a second implementation for
label normalization; the provided two reuse tests passed, and an independent
rerun confirmed them. That invocation mistakenly registered a new worker, so
Relay rejected its attempt to accept the task assigned to the existing worker.
It nevertheless produced the artifact and a reuse report without completing the
assigned task. This was a model workflow failure, not a successful lifecycle.
The MCP server instructions now explicitly require stable identity reuse and
stopping after rejected acceptance. Reconciliation must use the original assignee
and verify the artifact before completing the task; it must not erase the failed
attempt or claim the ownership guard was bypassed.

A subsequent Claude session reused the original assignee, accepted the pending
task, reran the two tests without editing files, completed it, and recorded successful
reuse linked to that completed task. Independent reads of GitHub confirmed both
tasks completed, round-two approval, a published skill, linked reuse evidence, and
no active work claims. Both reuse reports remain in history; the first is not
misrepresented as a completed assigned-task run. The toolkit regression suite
finished with 124 passing tests.

This exercise used real provider sessions and private GitHub storage on one machine.
Codex launched the bounded Claude invocations; no human carried review findings
between the agents after authentication. It used a deliberately incomplete synthetic
fixture, not a production feature. Recovery demonstrated a fresh process reading a
persisted checkpoint, not a simulated power loss. Scheduled wakes and separate-machine
continuation were not tested, and no enabled-scheduler receipt was fabricated.
