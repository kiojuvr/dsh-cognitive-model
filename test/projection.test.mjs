import assert from 'node:assert/strict'
import test from 'node:test'

import { groupActiveEvents, projectEvents } from '../lib/graph/projection.js'

let seq = 0
function ev(overrides) {
  seq += 1
  return {
    seq: overrides.seq ?? seq,
    id: overrides.id ?? `e${seq}`,
    at: overrides.at ?? '2026-01-01T00:00:00.000Z',
    op: overrides.op,
    scope: 'repo',
    evidence: [{ kind: 'file', ref: 'README.md' }],
    source: 'tool_output',
    supersedes: overrides.supersedes ?? [],
    invalidates: overrides.invalidates ?? [],
    ...(overrides.node === undefined ? {} : { node: overrides.node }),
    ...(overrides.edge === undefined ? {} : { edge: overrides.edge }),
    ...(overrides.validFrom === undefined ? {} : { validFrom: overrides.validFrom }),
    ...(overrides.validTo === undefined ? {} : { validTo: overrides.validTo }),
    ...(overrides.reason === undefined ? {} : { reason: overrides.reason }),
  }
}

const NOW = new Date('2026-06-01T00:00:00.000Z')

test('a later upsert supersedes the earlier one and keeps the first createdAt', () => {
  const first = ev({
    op: 'upsert_node',
    at: '2026-01-01T00:00:00.000Z',
    node: { id: 'objective', type: 'objective', label: 'old' },
  })
  const second = ev({
    op: 'upsert_node',
    at: '2026-02-01T00:00:00.000Z',
    node: { id: 'objective', type: 'objective', label: 'new' },
    supersedes: [first.id],
  })

  const view = projectEvents([first, second], NOW)
  assert.equal(view.nodes.get('objective')?.label, 'new')
  assert.equal(view.nodes.get('objective')?.createdAt, '2026-01-01T00:00:00.000Z')
  assert.equal(view.conflicts.length, 0)
})

test('two active events on one key are a conflict, and the key is left out of the view', () => {
  const a = ev({ op: 'upsert_node', node: { id: 'objective', type: 'objective', label: 'a' } })
  const b = ev({ op: 'upsert_node', node: { id: 'objective', type: 'objective', label: 'b' } })

  const view = projectEvents([a, b], NOW)
  assert.equal(view.nodes.has('objective'), false)
  assert.equal(view.conflicts.length, 1)
  assert.equal(view.conflicts[0].key, 'node:objective')
  assert.equal(view.conflicts[0].candidates.length, 2)
})

test('an invalidated event never becomes current', () => {
  const write = ev({ op: 'upsert_node', node: { id: 'objective', type: 'objective', label: 'x' } })
  const withdraw = ev({ op: 'retract_node', node: { id: 'objective', type: 'objective', label: 'x' }, invalidates: [write.id] })

  const view = projectEvents([write, withdraw], NOW)
  assert.equal(view.nodes.has('objective'), false)
  assert.equal(view.conflicts.length, 0)
})

test('valid time gates an event without touching it', () => {
  const future = ev({
    op: 'upsert_node',
    node: { id: 'objective', type: 'objective', label: 'later' },
    validFrom: '2026-07-01T00:00:00.000Z',
  })
  const expired = ev({
    op: 'upsert_node',
    node: { id: 'objective/old', type: 'objective', label: 'past' },
    validTo: '2026-05-01T00:00:00.000Z',
  })

  const view = projectEvents([future, expired], NOW)
  assert.equal(view.nodes.size, 0)
})

test('a functional relation keeps one target: the second write supersedes the first', () => {
  const nodeA = ev({ op: 'upsert_node', node: { id: 'entity/a', type: 'entity', label: 'A' } })
  const nodeB = ev({ op: 'upsert_node', node: { id: 'entity/b', type: 'entity', label: 'B' } })
  const nodeC = ev({ op: 'upsert_node', node: { id: 'entity/c', type: 'entity', label: 'C' } })
  const toB = ev({ op: 'set_edge', edge: { from: 'entity/a', type: 'part_of', to: 'entity/b' } })
  const toC = ev({
    op: 'set_edge',
    edge: { from: 'entity/a', type: 'part_of', to: 'entity/c' },
    supersedes: [toB.id],
  })

  const view = projectEvents([nodeA, nodeB, nodeC, toB, toC], NOW)
  const parts = view.edges.filter((edge) => edge.type === 'part_of')
  assert.equal(parts.length, 1)
  assert.equal(parts[0].to, 'entity/c')
})

test('a non-functional relation keeps several targets', () => {
  const a = ev({ op: 'upsert_node', node: { id: 'component/a', type: 'component', label: 'A' } })
  const b = ev({ op: 'upsert_node', node: { id: 'component/b', type: 'component', label: 'B' } })
  const c = ev({ op: 'upsert_node', node: { id: 'component/c', type: 'component', label: 'C' } })
  const ab = ev({ op: 'set_edge', edge: { from: 'component/a', type: 'requires', to: 'component/b' } })
  const ac = ev({ op: 'set_edge', edge: { from: 'component/a', type: 'requires', to: 'component/c' } })

  const view = projectEvents([a, b, c, ab, ac], NOW)
  assert.equal(view.edges.filter((edge) => edge.type === 'requires').length, 2)
})

test('a retracted node moves out of the graph but stays explainable', () => {
  const write = ev({ op: 'upsert_node', node: { id: 'component/graph', type: 'component', label: 'Graph' } })
  const retract = ev({
    op: 'retract_node',
    node: { id: 'component/graph', type: 'component', label: 'Graph' },
    reason: 'not needed',
    supersedes: [write.id],
  })

  const view = projectEvents([write, retract], NOW)
  assert.equal(view.nodes.has('component/graph'), false)
  assert.equal(view.retracted.get('component/graph')?.type, 'component')
})

test('groupActiveEvents answers which event a new write must supersede', () => {
  const write = ev({ op: 'upsert_node', node: { id: 'objective', type: 'objective', label: 'a' } })
  const groups = groupActiveEvents([write], NOW)
  assert.equal(groups.get('node:objective')?.[0]?.id, write.id)
})
