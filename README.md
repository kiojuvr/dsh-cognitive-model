# dsh-cognitive-model

> 日本語: [README.ja.md](README.ja.md)

A workspace-scoped graph that carries **the objective, the current position, and the work still open** across sessions — and the recall block a session starts from. The agent writes it with evidence; the next session reads it before it starts working. The same graph is what the Cognition tab draws.

## Why this exists

A long project outlives a session — often many of them. The next session starts without the objective, without the decisions already made, and without the work still open. It re-derives what was settled, repeats a mistake, or optimizes the task in front of it until the real goal is out of view.

The model keeps the material for the next decision outside the conversation:

- **Structure** — objective → component → task. What the work is for, and how it decomposes.
- **The epistemic record** — decision, constraint, risk, fact, preference. What has been settled, and what may be believed.
- **The world model** — entity, `part_of` / `owned_by` / `located_in`. What the work is made of, and who owns it.
- **Experience** — prediction errors and the conditional rules distilled from them.

The aim is not a larger memory; it is a next decision that still points at the objective.

A finding is not a node: it is a deferral queue item in `@kioju/dsh-cognitive-findings`, pointing back at the node it belongs to.

## What you get

- The next session starts from the objective, not from zero.
- Decisions, constraints, and verified facts survive the session — with the evidence that supports them. A guess is refused.
- The agent sees objective → path → now → remaining on every step, not only at the start.
- The same material is visible to you in the Cognition tab (install the dashboard).
- The graph never blocks work: a refused write is reported, and the work goes on.

It pays off when the work spans sessions and someone — you or the agent — would otherwise reconstruct the objective. For a single short task, the graph is overhead; install it when the work is long enough that the next session would start from zero.

## What it is not

- **Not a gate.** No tool blocks work, and the graph never refuses to let you continue. A refused write is reported and the work goes on.
- **Not a drift detector.** The bird's-eye check does not judge whether the work has drifted. It asks the reader to re-check when a recorded prediction error puts the objective, an acceptance item, or a priority in question; "continue" is a normal answer.
- **Not a graph database.** No queries beyond a bounded traversal and one boolean filter algebra, no indexes, no background maintenance. The document is one JSON file beside the workspace.
- **Not a substitute for evidence.** A write needs evidence: a file you read, a command you ran, a url, or the human's own words. A guess is refused, and `agent_inference` is never durable.
- **Not an approval system.** DSH owns approval. There is no second authority here.
- **Not a second history of the conversation.** It records structure you deliberately write, not what happened in the session.

## What happens after install

- Four tools: `graph_write`, `graph_retract`, `graph_query`, `graph_history`.
- A standing instruction that says what must survive the session and what must not be recorded.
- A **recall block** assembled on every prompt: objective, current path, now, remaining, map, constraints, decisions, linked facts, experience rules, and — when a recorded error asks for it — one non-binding whole-picture check.
- One append-only event log per workspace: `.dsh/cognitive-model/graph.json`. State is projected, never stored.

## Install

In DSH, open **Plugins**, choose **Add plugin**, and enter `@kioju/dsh-cognitive-model`. From a shell the same install is:

```
dsh plugin add @kioju/dsh-cognitive-model
```

The plugin is enabled when it is added; switch it on in **Plugins** if it is not.

The package is its own bundle (`dsh.bundle.patch`), and `@kioju/dsh-cognitive-core` arrives as an ordinary dependency — no checkout, no build step, nothing to place beside the package.

The **Cognition** tab that draws this graph is `@kioju/dsh-cognitive-dashboard`. Install it too to see what the agent sees:

```
dsh plugin add @kioju/dsh-cognitive-dashboard
```

`@kioju/dsh-cognitive-findings` is optional; it adds the deferral queue for out-of-scope findings. Each plugin is independent.

## First five minutes

The graph starts empty. Until something is written, the recall block is empty and the Cognition tab says **No objective is recorded yet**. That is the designed start, not a failure: the plugin does not infer an objective from the conversation.

The objective is your intent, so state it yourself — one sentence is enough:

> The goal of this work is `<one sentence>`. Record it in the cognitive graph as `objective`, the current work as `task/current`, and the other open work as `task/<key>`. Use this message as the evidence for the objective, and read the repository only to fill in components and tasks. Tell me in one line what you wrote.

The plugin does not create or modify `package.json`; it stores the graph in `.dsh/cognitive-model/graph.json`. A package manifest can help the agent find components and tasks, but it does not define the objective. A human statement is evidence too: the objective is recorded as `reported`, not as a verified fact.

After the write, the next prompt carries a block like this (trimmed):

```
Working memory for this workspace, projected from the event log — build on it instead of re-deriving it:
Objective: Publish a searchable documentation site — offline search is the acceptance bar [tasks: 2] (reported)
Path: objective → component/search
Now: Add a search index (reported, unverified)
Remaining:
- [objective] Deploy the site
Map:
  - Search — Index published pages [tasks: 1]
  - Publishing — Build and deploy the site
Constraints:
- Search must work without sending queries to a third-party service
Decisions:
- Build the search index at publish time
Experience (rules distilled from earlier prediction errors; conditional and revisable, not a rule for this case):
- [better] use the incremental build (repo; when only a few source files changed): run the incremental build before a full rebuild — 2 observation(s) (pre_…, pre_…), observed [for component/search]
Prediction errors: 12 recorded (graph_query errors=true).
```

and the tab draws the tree. From then on the agent updates the position as the work moves; you do not re-state the objective each session.

If nothing appears:

1. Is the plugin enabled in **Plugins**?
2. Is the session in the repository? The graph is per project root — the nearest ancestor with `.git`.
3. Did the write have evidence? A write without evidence (a file, a command, a url, or the human's words) is refused by design.
4. Is runtime context suppressed? The recall block is an optional context section; a profile that turns runtime context off will not show it.

## How the agent uses it

### What to record

| When | Write | Why |
|---|---|---|
| The work starts, or the objective is agreed | `objective` and `component`s with `serves` | The next session needs the whole picture |
| A decision is made | `decision` with a `node` edge | The next session should not re-open it |
| A constraint is found | `constraint` | A bound that must not be crossed |
| A fact is verified | `fact` with a `node` edge | Only linked facts reach the recall block |
| The current work moves | `task/current` | The "Now" line |
| Other work is still open | `task/<key>` | The "Remaining" line |
| An expectation differs | `errors` with a `direction` and evidence | The one-shot check and the calibration |
| A rule is distilled | `heuristic` with `errorIds` | Experience, not a one-shot note |

`label` is the line the next reader sees; `value` adds what the reader needs beyond the name. For a task, the value says where the work stands and what is still unconfirmed — not what is finished.

### What not to record

- The work itself — do it.
- A guess — a guess is refused; evidence is required.
- The conversation — this is not a transcript.

### A first write

```json
{
  "nodes": [
    { "id": "objective", "type": "objective", "label": "Publish a searchable documentation site", "value": "Offline search is the acceptance bar" },
    { "id": "component/search", "type": "component", "label": "Search", "value": "Index published pages and answer queries" },
    { "id": "task/current", "type": "task", "label": "Add a search index", "value": "Build the index at publish time; offline search is unconfirmed" },
    { "id": "task/deploy", "type": "task", "label": "Deploy the site" }
  ],
  "edges": [
    { "from": "component/search", "type": "serves", "to": "objective" },
    { "from": "task/current", "type": "serves", "to": "component/search" },
    { "from": "task/deploy", "type": "serves", "to": "objective" }
  ],
  "evidence": [{ "kind": "file", "ref": "README.md" }]
}
```

The example is deliberately small: one objective, one component, the current task, and one other open task. The evidence must be something the agent actually saw.

### The recall block

The block is assembled fresh on every prompt, so it follows the graph instead of a stale summary. It answers the questions a session would otherwise re-derive:

- `Objective` — the root, its task count, and the acceptance still unmet.
- `Path` — the `serves` chain leading to `task/current`.
- `Now` — the one current task. A newer task does not take this place; `task/current` does.
- `Remaining` — the other open tasks. `none recorded` does not mean nothing remains.
- `Map` — the objective tree, compressed; more detail on the current path.
- `Constraints` / `Risks` / `Preferences` / `Decisions` / `Facts` — what may be believed and what is settled. A fact appears only when a `node` edge links it to the current path.
- `Experience` — rules distilled from earlier prediction errors, with their conditions.
- The one-shot check — a non-binding request to look up, added only when a recorded error puts the objective, an acceptance item, or a priority in question. It is shown once per session per error.

### Questions

- **The objective changed.** Write the same node again with the new value; the earlier value stays in `graph_history`. A change of objective is allowed — it is not drift by itself.
- **I wrote the same node twice.** The later write replaces the earlier one; `graph_history` keeps both.
- **A record is wrong.** `graph_retract` with a reason and evidence. Nothing is erased; the retraction supersedes it.
- **Two records are active on one key.** The projection reports a conflict and leaves the key out of the view. It is returned with every query, not silently resolved.
- **A fact does not appear in the recall block.** Link it to the current path with a `node` edge when the next session should see it.
- **The recall block is empty.** Either nothing is recorded, the runtime context is suppressed, or the session is outside the project root.

## The Cognition tab

Install `@kioju/dsh-cognitive-dashboard` to see the same graph as a tree, with the current task, the other open work, the findings, and the recall block itself. The dashboard README has the reading guide.

## Reference

Full behaviour, tools, storage and policy: [docs/REFERENCE.md](docs/REFERENCE.md).

### Tools

| Tool | Use |
|---|---|
| `graph_write` | Write nodes, edges, or prediction errors, with evidence |
| `graph_retract` | Withdraw a node or edge with a reason |
| `graph_query` | Traverse, filter, infer owner or location, or list errors |
| `graph_history` | Read the event chain behind a node or edge |

### Config

```yaml
- insert:
    - id: cognitive-model
      name: '@kioju/dsh-cognitive-model'
      config:
        contextLimit: 12    # objective-tree rows shown by the recall block
        recallLimit: 12     # per-section cap for constraints, risks, preferences and decisions
        queryLimit: 50      # upper bound on one graph_query result
        maxDepth: 6         # traversal depth cap, whatever the caller asks for
        writeTypes: []      # empty = every node type
        writeScopes: []     # empty = every scope
```

### Storage

```
<projectRoot>/.dsh/cognitive-model/graph.json    # the append-only event log
<projectRoot>/.dsh/cognitive-model/recall.json   # read receipts for the bird's-eye check
```

`<projectRoot>` is the nearest ancestor containing `.git`; without one, the current working directory — the same definition DSH uses for `<projectRoot>/.dsh/skills`.

The graph is a working memory, not an archive: the log is capped at 20,000 events. Reset is physical deletion:

```
rm -rf <projectRoot>/.dsh/cognitive-model
```

There is no delete tool. `graph_retract` withdraws a node from the projected graph; it does not erase the event that created it.

### Upgrade

Schema 2 gives every prediction error a direction. If the workspace has a schema-1 graph, run the one-time migration before enabling this version:

```
npm run build
node scripts/migrate-peg.mjs <workspace> --dry-run   # report only
node scripts/migrate-peg.mjs <workspace>
```

It writes a timestamped `.bak-…` beside the graph, is idempotent, and leaves the rest of the log untouched. A new graph is already schema 2.

### Test

```
npm test                    # builds first (pretest), then runs the suite once
node scripts/run-tests.mjs  # in-process runner for a sandbox that denies the child spawn
```

## The family

`dsh-cognitive-*` keeps the material for the next decision outside the conversation: the objective and how the work decomposes, what has been decided and constrained, what is still open, and what was noticed but deferred.

| Package | Role | If it is missing |
|---|---|---|
| `@kioju/dsh-cognitive-model` | The graph and the recall block | No tree and no recall block; findings still work |
| `@kioju/dsh-cognitive-dashboard` | The Cognition tab | The agent still records; you have no view |
| `@kioju/dsh-cognitive-findings` | The deferral queue | Out-of-scope discoveries have nowhere durable to go |
| `@kioju/dsh-cognitive-core` | Shared library | Installed automatically |

Each plugin is independent. Install model + dashboard for the full view; add findings for the deferral loop.

## License

MIT.
