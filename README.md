# dsh-cognitive-model

The cognitive model and the world model as **one graph**, for DSH agents — and
the recall block a new session starts from.

Nodes and typed edges represent objectives, tasks, claims and world entities.
Readers can follow relationships in the graph or infer ownership and location
through `part_of`.

State is not stored as truth. The durable document holds an append-only **event
log**; the graph is projected from it on every read. That is what makes a
replacement, a withdrawal, and a valid-time window apply before anything is
answered — and what makes an unresolved conflict visible instead of silently
resolved.

If you used `dsh-cognitive-memory`, you can [migrate its ledger](#migrating-a-memory-ledger).
Normal operation does not read the legacy ledger.

## What it is not

- **Not a gate.** No tool blocks work, and the graph never refuses to let you
  continue. A refused write is reported and the work goes on.
- **Not a drift detector.** The bird's-eye check does not judge whether the work
  has drifted. It asks the reader to re-check when a recorded prediction error
  puts the objective, an acceptance item, or a priority in question, and
  "continue" is a normal answer.
- **Not a graph database.** No queries beyond a bounded traversal and one
  boolean filter algebra, no indexes, no background maintenance. The document is
  one JSON file beside the workspace.
- **Not a substitute for evidence.** A write needs evidence: a file you read, a
  command you ran, a url, or the human's own words. A guess is refused, and
  `agent_inference` is never durable.
- **Not an approval system.** DSH owns approval. There is no second authority
  here.
- **Not a second history of the conversation.** It records structure you
  deliberately write, not what happened in the session.

## The graph

Three vocabularies share one store, because "what is the work for", "what may be
believed about it", and "what is it made of" are asked together.

**Nodes** — `objective` / `component` / `task` / `decision` (the
structure), `constraint` / `risk` / `fact` / `preference` (the epistemic record),
`heuristic` (a conditional rule distilled from prediction errors), and `entity`
(the world). A finding is not a node: it is a deferral queue item in the
findings ledger, whose `node` field points back at the objective or component
it belongs to.

A constraint is a bound on the work; a risk is an unresolved danger; a fact is
a claim about the repository, stored in `value`; a preference is how the human
wants things done. These are nodes, not attributes, so readers can query them
and the recall block can group them without a second store.

A **prediction error** — an expectation that differed from what happened, better
or worse — is *not* a node: it has no place in the structure and no edge to
anything. It is an event (`record_error`), appended once and never superseded; a
correction is a newer record, so the expectation that differed stays readable.
Its `direction` says which way the outcome differed, and its `revisit` field is
the impact, separate from the kind: what, if anything, the error puts in
question.

A **heuristic** is a node: a conditional, revisable rule distilled from one or
more errors. It carries `direction` (the rule's valence), `conditions` (when it
applies), and `errorIds` (the source errors). It is linked with a `node` edge to
the objective or component it serves. It is written deliberately — the writer
decides that recurrence, impact, or explanatory value justifies a rule — not
generated automatically.

**Edges** — `serves` / `requires` / `verifies` / `node` join the cognitive side;
`part_of` / `owned_by` / `located_in` join the world side.

| edge | functional | from → to | meaning |
|---|---|---|---|
| `serves` | yes | objective / component / task → objective / component | what a task or component is for; an objective serves only its parent objective |
| `requires` | no | component / task / decision → component | a dependency on a component |
| `verifies` | no | component → component | which component checks which |
| `node` | yes | decision / fact / risk / constraint / preference / heuristic → objective / component | the node this record belongs to |
| `part_of` | yes | entity → entity | the structural parent |
| `owned_by` | yes | entity → entity | who owns the entity |
| `located_in` | yes | entity → entity | where the entity is |

The vocabulary is closed, and the write path checks it: an edge between the
wrong kinds is refused with `invalid_edge_endpoint` instead of being stored and
silently ignored by the tree.

A **functional** relation has one active target per `(from, type)`: writing a
second target replaces the first, and the first stays in `graph_history`. A
non-functional relation accumulates.

### The two inferences

`graph_query` with `infer` answers the questions the graph exists for:

- **owner** — a direct `owned_by` wins; otherwise the owner is inherited from
  the nearest ancestor on the `part_of` chain that has one, and the result says
  which of the two it used.
- **location** — a direct `located_in` and an inherited one are both candidates.
  When they name different places the answer is a **conflict with the
  candidates**, not the newer one.

`part_of` is a strict partial order: a node is not part of itself. Chains are
cycle-safe and report the cycle rather than following it forever.

## Projection rules

The order matters, and it is the order the code follows:

1. collect the events
2. partition by projection key
3. resolve supersession — an explicit replacement beats recency
4. apply invalidation — a withdrawn event never becomes current
5. apply valid time — an event may not cover this instant
6. build the view

When two events are still active on one key and neither supersedes the other,
the projection records a **conflict** and leaves that key out of the view. A
conflict is returned with every `graph_query` result.

## Tools

### `graph_write`

| argument | required | meaning |
|---|---|---|
| `nodes` | one of | `{ id, type, label, value?, direction?, conditions?, errorIds?, paths?, docs?, milestones? }`; `direction` / `conditions` / `errorIds` are heuristic-only |
| `edges` | one of | `{ from, type, to }` |
| `errors` | one of | `{ kind, direction, subject, predicted, observed, lesson?, factId?, revisit? }` |
| `evidence` | effectively | a file, a command, a url, or the human's words |
| `source` | no | derived from the evidence when omitted |
| `scope` | no | defaults to `repo` |
| `validFrom` / `validTo` | no | when the claim starts and stops holding |

Both endpoints of an edge must exist — in this call or an earlier one. The whole
call is validated before anything is appended: a batch that is half applied is a
graph nobody can reason about. A node or edge named twice in one call is folded
into one event (the later entry wins), so a batch cannot leave two active events
on one projection key — the projection would report that as an unresolvable
conflict and hide the node.

Writing the same claim with the same source and evidence again is a no-op. A
write whose source or evidence changed supersedes the earlier event, so a claim
first recorded from a note can later be verified by a command without changing
its text; the earlier record stays in `graph_history`.

A prediction error is stricter than a node: its evidence must include a command,
a file, or a url. A note alone is a report, not an observation — "it differed"
is only worth recalling if something other than the reporter showed it. The same
record written twice is reported as a duplicate and not appended again. A
heuristic is stricter too: it needs `direction`, `conditions`, and one to ten
active `errorIds` (record the errors first; their ids are returned by the write).
A heuristic distilled by the model also needs a command, file, or url; a human
may state one from a note.

`direction` is `better` or `worse`: the outcome beat the expectation (it worked,
was faster, or was smaller) or fell short. Both are recorded and recalled; a
positive error can widen a boundary or raise confidence, a negative one can
narrow it or add a check.

`revisit` is the impact, not another kind: set it only when the error puts the
current objective (`objective`), an acceptance item (`acceptance`), or a
priority (`priority`) in question. A `scope` or `estimate` miss that changes
nothing about the objective is a calibration record and leaves it unset; a
`belief` that overturns an assumption or an `outcome` that shows an acceptance
item cannot be met — or is already met — may set it.

### `graph_retract`

`nodes?`, `edges?`, `reason` (required), `evidence`. Retracting a node also
withdraws the edges that point at it, so no relation is left dangling. Nothing is
erased: the retraction supersedes the event and both stay in history.

### `graph_query`

`start?`, `via?`, `direction?`, `depth?`, `predicate?`, `infer?`, `errors?`,
`limit?`.

With `errors: true` it lists the recorded prediction errors, newest first,
instead of graph nodes.

The predicate algebra is the whole query language:

```
{ type: 'owner',      owner,    mode? }
{ type: 'part_of',    parent,   mode? }
{ type: 'located_in', place,    mode? }
{ type: 'node_type',  nodeType, mode? }
{ type: 'and' | 'or', of: [ … ] }
{ type: 'not',        of: { … } }
{ type: 'true' } | { type: 'false' }
```

`mode` is `include` (default) or `exclude`. Use `and`, `or`, and `not` to
combine predicates.

Traversal returns every `via` edge between reached nodes (the induced
subgraph), not only the BFS tree, and reports a cycle only when the walk
actually closes one — an undirected walk back over the edge it came by is not a
cycle.

### `graph_history`

`node?`, `edge?`, `limit?`. Every write, replacement, and retraction behind one
target, newest first, each with its source, its evidence, and whether it is still
current.

## The recall block

The plugin provides a short instruction and assembles a bounded recall block
from the projection on each step. Here is an example for a documentation site:

```
Working memory for this workspace, projected from the event log — build on it instead of re-deriving it:
Objective: Publish a searchable documentation site [tasks: 1] (reported)
Path: objective → component/search
Now: Add a search index (reported, unverified)
Remaining: none recorded — this does not mean nothing else remains.
Map:
  - Search — Index published pages [tasks: 1]
  - Publishing — Build and deploy the site
Constraints:
- Search must work without sending queries to a third-party service
Preferences:
- Keep the site usable offline (reported)
Decisions:
- Build the search index at publish time
Facts: 12 recorded, none linked to the current path (graph_query with node_type=fact lists them).
Experience (rules distilled from earlier prediction errors; conditional and revisable, not a rule for this case):
- [better] use the incremental build (repo; when only a few source files changed): run the incremental build before a full rebuild — 2 observation(s) (pre_…, pre_…), observed [for component/search]
Before continuing: does the work in hand still serve the objective?
Why this check — a recorded prediction error puts the acceptance items in question:
- [outcome/worse] offline search (repo; revisit: acceptance): expected results offline — actually the index required a network request
Compare the objective, the current position, and the other unfinished parts
(if the block names none, they are unrecorded — not absent), then decide to continue, change, or hold.
Refining the objective or the approach is allowed, and earlier decisions can be re-examined;
this is a check, not a gate.
Prediction errors: 12 recorded (graph_query errors=true).
Labels say how each item was recorded, not that its content was re-checked; an unmarked item cites a file, command or url. (reported, unverified) was said, not checked: check one when a detail matters, then record the correction with evidence.
```

The block gives the next session context without reproducing the whole ledger.
`Objective` describes the root. `Path` follows the `serves` chain leading to
`task/current`, which is shown separately under `Now`. If `task/current` is
absent, `Now` says `not recorded` rather than showing the newest task.
`Remaining` summarizes other tasks and recorded unmet acceptance items. The
map keeps more detail on the current path and condenses off-path descendants
to names.

Each section has its own budget. Constraints, risks and preferences are
listed separately. Decisions linked to the current path come first, then other
decisions by recency. Facts appear only when a `node` edge links them to the
current path (nearest first, then recency). A fact with no
link is not replaced by an unrelated sample: the block says how many are
recorded and how to query them. The error log is an index — one line with the
count — while the distilled rules stay in `Experience` and the one-shot check
keeps its reason. `contextLimit` bounds the map rows. `recallLimit` caps
constraints, risks, preferences and decisions per section; linked facts and
experience rules have separate limits.

When an error carries `revisit`, the block adds one non-binding request to look
up from the work in hand. The trigger is the recorded **impact**, not the error's
kind or size: a `scope` or `estimate` miss that changes nothing about the
objective is a calibration record and does not ask for the check, while a
`belief` that overturns an assumption or an `outcome` that shows an acceptance
item cannot be met can. The request carries the triggering error's subject and
its predicted/observed difference, because the trigger is independent of the
error section — the log is one line, and the reader should not have to guess
which record asked.

The check is **once per session per error**, not once per process or
workspace. Another session in the same workspace is still asked, and a restarted
session is not asked again for an error it already saw; the receipt is kept in
`.dsh/cognitive-model/recall.json`. It is a check, not a gate, and an agreed
change of objective is not drift.

The block is registered as optional (`required: false`), so it follows the
deployment's runtime-context switch.

## The Host service

The graph is published to sibling Host plugins as the Cordis service
`cognitiveGraph`:

```js
const model = ctx.get('cognitiveGraph') // undefined when this plugin is absent
const snapshot = model.snapshot(root)   // { state: 'ready' | 'missing' | 'error', nodes, edges, … }
const recall = model.recall(root)       // { state, text } — the block a session starts from
```

`snapshot(root)` is synchronous and takes a workspace root. A consumer gets the
same projection the browser reads (`nodes` with their acceptance items, typed
`edges`, conflicts, and the two `part_of` inferences) without importing this
package or folding the event log a second time. `dsh-cognitive-dashboard` is the
first consumer: its objective tree is drawn from this snapshot, so supersession
and conflict detection keep one implementation.

`recall(root)` returns the recall block itself as `text`, assembled with this
plugin's configured budgets. A UI can display the block directly instead of rebuilding it. The read does not
consume the per-session bird's-eye check — the prompt spends that once per
reader — so the check is absent from the returned text. Both calls share one
cached read of the log.

## Storage

```
<projectRoot>/.dsh/cognitive-model/graph.json    # the append-only event log
<projectRoot>/.dsh/cognitive-model/recall.json   # read receipts for the bird's-eye check
```

`<projectRoot>` is the nearest ancestor containing `.git`; without one, the
current working directory — the same definition DSH uses for
`<projectRoot>/.dsh/skills`.

The graph document holds `events`, `stats`, and `nextSeq`. It has no `nodes`
array: state is projected, never stored. The document is schema 2; the log is
capped at 20,000 events and is append-only; the supported reset when it is full
is deleting the area (the graph is a working memory, not an archive). A refused
write appends no event; the document records it in `stats.rejections` (the first
refusal creates the document, because the counter is the durable sign that the
policy ran).

`recall.json` is bookkeeping, not a ledger: it remembers which session has
already been shown which bird's-eye check. Deleting it only means one check may
be shown again; it never affects what the graph believes.

**Reset is physical deletion:**

```
rm -rf <projectRoot>/.dsh/cognitive-model
```

There is no delete tool. `graph_retract` withdraws an entity from the projected
graph; it does not erase the event that created it.

An unreadable document is moved aside as `graph.json.corrupt-<timestamp>` before
the next write, so a hand-edited ledger stays recoverable.

## Migrating a memory ledger

When the graph takes over the recall from `dsh-cognitive-memory`, the ledger's
active facts, their relations, and its prediction errors can be copied in:

```
npm run build
node scripts/import-memory.mjs <workspace> --dry-run   # report only
node scripts/import-memory.mjs <workspace>
```

The import preserves each fact's own evidence and source — it does not upgrade
trust, and a fact today's policy would refuse is reported, not forced in. A node
the graph already knows and that is newer than the fact is kept, so the import is
safe to run again. The memory ledger is left untouched; deleting
`.dsh/cognitive-memory` afterwards is the point of no return, not a requirement.
An imported error from the old ledger becomes `direction: worse`; the ledger
predates the signed record.

## Migrating the graph to schema 2

Schema 2 gives every prediction error a direction. This is a one-time format
migration, not a correction: the old errors were negative by construction, so
they become `worse`. Run it once before enabling this version:

```
npm run build
node scripts/migrate-peg.mjs <workspace> --dry-run   # report only
node scripts/migrate-peg.mjs <workspace>
```

It writes a timestamped `.bak-…` beside the graph, is idempotent, and leaves the
rest of the log untouched. A new graph is already schema 2; no migration is
needed.

## Install

1. Put the shared library in a sibling checkout named `dsh-cognitive-core`. It
   ships its built `lib/`, so it needs no build step of its own, and it is never
   added to DSH directly.
2. In this directory, run `npm install`, then `npm run build`.
3. Add this directory to DSH: **Plugins > Add plugin**, or
   `dsh plugin --profile <profile> add <absolute path>` from a shell. The
   installer writes the `link:` dependency and the bundle entry into the
   profile's `package.json`; do not edit it by hand.
4. The plugin is enabled when it is added. If it is not, enable it in
   **Plugins**.

## Config

```yaml
- insert:
    - id: cognitive-model
      name: 'dsh-cognitive-model'
      config:
        contextLimit: 12    # objective-tree rows shown by the recall block
        recallLimit: 12     # per-section cap for constraints, risks, preferences and decisions
        queryLimit: 50      # upper bound on one graph_query result
        maxDepth: 6         # traversal depth cap, whatever the caller asks for
        writeTypes: []      # empty = every node type
        writeScopes: []     # empty = every scope
```

## Storage counters

The graph document records these counters:

- `writes` — events appended
- `retractions` — events that withdraw a record
- `rejections` — writes refused by policy, validation, or a storage limit
- `duplicates` — repeated claims with the same evidence; no event is appended.

Conflicts are derived at projection time and are returned with every query, not
persisted.

## Tests

```
npm test                    # builds first (pretest), then runs the suite once
node scripts/run-tests.mjs  # in-process runner for a sandbox that denies the child spawn
```

The suite covers the projection rules (supersession, invalidation, valid time,
conflicts), the two inferences and the traversal, the recall block and the
signed prediction-error policy (including the impact-based bird's-eye check, its
per-session receipts, its reason line, and a scope miss that stays a calibration
record), the experience rules (a heuristic distilled from errors, its fields and
policy, the current-path-first recall section, its budget, and its retraction),
the schema-2 migration, the memory-ledger import (including the component
mapping, the old-ledger `worse` default, and a refused fact that must not drop
the rest), the write policy and the edge vocabulary, and the four tools end to
end against a temporary workspace.

## Licence

MIT.
