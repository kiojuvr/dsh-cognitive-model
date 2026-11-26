import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { graphFileFor, graphSnapshot, recallSnapshot } from '../lib/graph/snapshot.js'
import { workspace } from '../test-support/tmp.mjs'

const LIMITS = { recallLimit: 12, contextLimit: 12 }

let seq = 0
function node(id, type, label, extra = {}) {
  seq += 1
  return {
    seq,
    id: `e${seq}`,
    at: '2026-01-01T00:00:00.000Z',
    op: 'upsert_node',
    scope: 'repo',
    node: { id, type, label, ...extra },
    evidence: [{ kind: 'file', ref: 'x' }],
    source: 'tool_output',
    supersedes: [],
    invalidates: [],
  }
}

function edge(from, type, to) {
  seq += 1
  return {
    seq,
    id: `e${seq}`,
    at: '2026-01-01T00:00:00.000Z',
    op: 'set_edge',
    scope: 'repo',
    edge: { from, type, to },
    evidence: [{ kind: 'file', ref: 'x' }],
    source: 'tool_output',
    supersedes: [],
    invalidates: [],
  }
}

function write(root, events) {
  const file = graphFileFor(root)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ schemaVersion: 2, workspace: root, events, stats: {}, nextSeq: seq + 1 }))
}

test('no workspace is reported as missing, not as an empty graph', () => {
  const snapshot = graphSnapshot(undefined)
  assert.equal(snapshot.state, 'missing')
  assert.equal(snapshot.workspace, null)
})

test('a workspace with no ledger is reported as missing', () => {
  const snapshot = graphSnapshot(workspace())
  assert.equal(snapshot.state, 'missing')
  assert.equal(snapshot.nodes.length, 0)
})

test('an unreadable ledger is reported as error, never as empty success', () => {
  const root = workspace()
  const file = graphFileFor(root)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, '{ not json')
  assert.equal(graphSnapshot(root).state, 'error')
})

test('a ready snapshot carries counts, nodes, typed edges and the two inferences', () => {
  const root = workspace()
  write(root, [
    node('objective', 'objective', 'Port', {
      milestones: [{ text: 'graph', done: true }, { text: 'query', done: false }],
    }),
    node('component/graph', 'component', 'Graph'),
    node('entity/file', 'entity', 'graph.json'),
    node('entity/dir', 'entity', '.dsh'),
    node('entity/team', 'entity', 'team'),
    node('entity/room', 'entity', 'workspace'),
    edge('component/graph', 'serves', 'objective'),
    edge('entity/file', 'part_of', 'entity/dir'),
    edge('entity/dir', 'owned_by', 'entity/team'),
    edge('entity/dir', 'located_in', 'entity/room'),
  ])

  const snapshot = graphSnapshot(root)
  assert.equal(snapshot.state, 'ready')
  assert.equal(snapshot.counts.nodes, 6)
  assert.equal(snapshot.counts.edges, 4)
  assert.equal(snapshot.counts.byType.entity, 4)
  assert.equal(snapshot.counts.byEdge.part_of, 1)
  assert.equal(snapshot.events, 10)
  assert.equal(snapshot.truncated.nodes, false)

  // A reader draws the acceptance items, so the snapshot carries them, not only
  // the done/total count.
  const objective = snapshot.nodes.find((entry) => entry.id === 'objective')
  assert.deepEqual(objective.milestones, [
    { text: 'graph', done: true },
    { text: 'query', done: false },
  ])
  assert.deepEqual(objective.acceptance, { done: 1, total: 2 })

  const owner = snapshot.inference.find(
    (row) => row.entity === 'entity/file' && row.kind === 'owner',
  )
  assert.equal(owner.value, 'entity/team')
  assert.equal(owner.source, 'part_of_derived')

  const location = snapshot.inference.find(
    (row) => row.entity === 'entity/file' && row.kind === 'location',
  )
  assert.equal(location.value, 'entity/room')
})

test('a location conflict is carried as candidates, not as a picked value', () => {
  const root = workspace()
  write(root, [
    node('entity/file', 'entity', 'f'),
    node('entity/dir', 'entity', 'd'),
    node('entity/room-a', 'entity', 'a'),
    node('entity/room-b', 'entity', 'b'),
    edge('entity/file', 'part_of', 'entity/dir'),
    edge('entity/file', 'located_in', 'entity/room-a'),
    edge('entity/dir', 'located_in', 'entity/room-b'),
  ])
  const snapshot = graphSnapshot(root)
  const location = snapshot.inference.find(
    (row) => row.entity === 'entity/file' && row.kind === 'location',
  )
  assert.equal(location.source, 'conflict')
  assert.equal(location.value, undefined)
  assert.deepEqual(location.candidates, ['entity/room-a', 'entity/room-b'])
})

test('a conflict in the log is surfaced in the snapshot', () => {
  const root = workspace()
  const a = node('objective', 'objective', 'A')
  const b = { ...node('objective', 'objective', 'B'), supersedes: [] }
  write(root, [a, b])
  const snapshot = graphSnapshot(root)
  assert.equal(snapshot.conflicts.length, 1)
  assert.equal(snapshot.conflicts[0].key, 'node:objective')
  assert.equal(snapshot.nodes.length, 0)
})

test('the bounded payload keeps the structure before the facts', () => {
  const root = workspace()
  write(root, [
    node('fact/a', 'fact', 'A'),
    node('fact/b', 'fact', 'B'),
    node('objective', 'objective', 'Port'),
  ])
  const snapshot = graphSnapshot(root)
  // Sorting by id alone would put fact/* before objective and could cut the
  // tree out of a capped payload (P3).
  assert.equal(snapshot.nodes[0].id, 'objective')
  assert.equal(snapshot.nodes[0].type, 'objective')
})

test('a repeated snapshot returns the same projection', () => {
  const root = workspace()
  write(root, [node('objective', 'objective', 'Port'), node('component/graph', 'component', 'Graph')])
  const first = graphSnapshot(root)
  const second = graphSnapshot(root)
  assert.deepEqual(second.nodes, first.nodes)
  assert.deepEqual(second.counts, first.counts)
  assert.equal(second.state, 'ready')
})

test('a changed document is re-read instead of served from the cache', () => {
  const root = workspace()
  write(root, [node('objective', 'objective', 'Port')])
  assert.equal(graphSnapshot(root).counts.nodes, 1)
  write(root, [node('objective', 'objective', 'Port'), node('component/graph', 'component', 'Graph')])
  assert.equal(graphSnapshot(root).counts.nodes, 2)
})

// The recall block is the second payload of the same read (D108): a UI shows
// the text the input receives instead of drawing the material again.
test('the recall block is the text a session starts from', () => {
  const root = workspace()
  write(root, [
    node('objective', 'objective', 'Port', { value: 'the goal' }),
    node('component/graph', 'component', 'Graph'),
    node('task/current', 'task', 'Build', { value: 'build the graph' }),
    node('fact/one', 'fact', 'The ledger is append-only'),
    edge('component/graph', 'serves', 'objective'),
    edge('task/current', 'serves', 'component/graph'),
  ])

  const recall = recallSnapshot(root, LIMITS)
  assert.equal(recall.state, 'ready')
  assert.equal(recall.events, 6)
  assert.match(recall.text, /^Working memory for this workspace/)
  assert.match(recall.text, /Objective: Port — the goal \[tasks: 1\]/)
  assert.match(recall.text, /Path: objective → component\/graph/)
  assert.match(recall.text, /  - Graph \[tasks: 1\]/)
  assert.match(recall.text, /Now: Build — build the graph/)
  // The fact is not linked to the current path, so the block indexes it.
  assert.match(recall.text, /Facts: 1 recorded, none linked to the current path/)
})

test('the recall block is absent, with a state, when there is nothing to recall', () => {
  const noWorkspace = recallSnapshot(undefined, LIMITS)
  assert.equal(noWorkspace.state, 'missing')
  assert.equal(noWorkspace.text, '')
  assert.equal(noWorkspace.workspace, null)

  const noLedger = recallSnapshot(workspace(), LIMITS)
  assert.equal(noLedger.state, 'missing')
  assert.equal(noLedger.text, '')
})

test('an unreadable ledger is reported as an error, never as an empty block', () => {
  const root = workspace()
  const file = graphFileFor(root)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, '{ not json')
  const recall = recallSnapshot(root, LIMITS)
  assert.equal(recall.state, 'error')
  assert.equal(recall.text, '')
})

test('an unmigrated ledger carries the model reason, not a command', () => {
  const root = workspace()
  write(root, [])
  const file = graphFileFor(root)
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  doc.schemaVersion = 1
  writeFileSync(file, JSON.stringify(doc))

  const recall = recallSnapshot(root, LIMITS)
  assert.equal(recall.state, 'error')
  assert.match(recall.message ?? '', /schema/)
  assert.equal(recall.text, '')
})

test('the tree budget bounds the block and says what it left out', () => {
  const root = workspace()
  write(root, [
    node('objective', 'objective', 'Port'),
    node('component/a', 'component', 'A'),
    node('component/b', 'component', 'B'),
    edge('component/a', 'serves', 'objective'),
    edge('component/b', 'serves', 'objective'),
  ])

  const wide = recallSnapshot(root, LIMITS)
  assert.match(wide.text, /^  - A$/m)
  assert.match(wide.text, /^  - B$/m)

  const narrow = recallSnapshot(root, { recallLimit: 12, contextLimit: 1 })
  assert.match(narrow.text, /^  - A$/m)
  assert.doesNotMatch(narrow.text, /^  - B$/m)
  assert.match(narrow.text, /\(\+1 more node not shown; graph_query\)/)
})

test('a changed document rebuilds the block instead of serving the old text', () => {
  const root = workspace()
  write(root, [node('objective', 'objective', 'Port')])
  assert.match(recallSnapshot(root, LIMITS).text, /Objective: Port/)
  write(root, [node('objective', 'objective', 'Renamed')])
  assert.match(recallSnapshot(root, LIMITS).text, /Objective: Renamed/)
})
