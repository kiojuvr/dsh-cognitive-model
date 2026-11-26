import assert from 'node:assert/strict'
import test from 'node:test'

import { projectEvents } from '../lib/graph/projection.js'
import {
  evalPredicate,
  followChain,
  isPartOf,
  resolveLocation,
  resolveOwner,
  traverse,
} from '../lib/graph/query.js'

let seq = 0
function node(id, type = 'entity') {
  seq += 1
  return {
    seq,
    id: `e${seq}`,
    at: '2026-01-01T00:00:00.000Z',
    op: 'upsert_node',
    scope: 'repo',
    node: { id, type, label: id },
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

function viewOf(events) {
  return projectEvents(events, new Date('2026-06-01T00:00:00.000Z'))
}

test('a direct owner wins over an inherited one', () => {
  const view = viewOf([
    node('entity/a'),
    node('entity/team'),
    edge('entity/a', 'owned_by', 'entity/team'),
  ])
  const owner = resolveOwner(view, 'entity/a')
  assert.equal(owner.owner, 'entity/team')
  assert.equal(owner.source, 'direct')
})

test('an owner is inherited through the part_of chain', () => {
  const view = viewOf([
    node('entity/file'),
    node('entity/dir'),
    node('entity/team'),
    edge('entity/file', 'part_of', 'entity/dir'),
    edge('entity/dir', 'owned_by', 'entity/team'),
  ])
  const owner = resolveOwner(view, 'entity/file')
  assert.equal(owner.owner, 'entity/team')
  assert.equal(owner.source, 'part_of_derived')
  assert.deepEqual(owner.path, ['entity/file', 'entity/dir'])
})

test('an entity with no owner resolves to unknown', () => {
  const view = viewOf([node('entity/a')])
  assert.equal(resolveOwner(view, 'entity/a').source, 'unknown')
})

test('a location is inherited when nobody set it directly', () => {
  const view = viewOf([
    node('entity/file'),
    node('entity/dir'),
    node('entity/room'),
    edge('entity/file', 'part_of', 'entity/dir'),
    edge('entity/dir', 'located_in', 'entity/room'),
  ])
  const location = resolveLocation(view, 'entity/file')
  assert.equal(location.kind, 'resolved')
  assert.equal(location.location, 'entity/room')
  assert.equal(location.source, 'part_of_derived')
})

test('a direct and an inherited location that disagree are a conflict, not a choice', () => {
  const view = viewOf([
    node('entity/file'),
    node('entity/dir'),
    node('entity/room-a'),
    node('entity/room-b'),
    edge('entity/file', 'part_of', 'entity/dir'),
    edge('entity/file', 'located_in', 'entity/room-a'),
    edge('entity/dir', 'located_in', 'entity/room-b'),
  ])
  const location = resolveLocation(view, 'entity/file')
  assert.equal(location.kind, 'conflict')
  assert.equal(location.candidates.length, 2)
  const places = location.candidates.map((candidate) => candidate.location).sort()
  assert.deepEqual(places, ['entity/room-a', 'entity/room-b'])
})

test('a part_of cycle is reported rather than followed forever', () => {
  const view = viewOf([
    node('entity/a'),
    node('entity/b'),
    edge('entity/a', 'part_of', 'entity/b'),
    edge('entity/b', 'part_of', 'entity/a'),
  ])
  const chain = followChain(view, 'entity/a', 'part_of')
  assert.equal(chain.cycle, true)
  assert.deepEqual(chain.path, ['entity/a', 'entity/b', 'entity/a'])
})

test('isPartOf follows the chain', () => {
  const view = viewOf([
    node('entity/a'),
    node('entity/b'),
    node('entity/c'),
    edge('entity/a', 'part_of', 'entity/b'),
    edge('entity/b', 'part_of', 'entity/c'),
  ])
  assert.equal(isPartOf(view, 'entity/a', 'entity/c'), true)
  assert.equal(isPartOf(view, 'entity/c', 'entity/a'), false)
})

test('the predicate algebra composes leaves', () => {
  const view = viewOf([
    node('entity/a'),
    node('component/b', 'component'),
    node('component/child', 'component'),
    edge('component/child', 'part_of', 'component/b'),
  ])
  const under = { type: 'part_of', parent: 'component/b', mode: 'include' }
  const isComponent = { type: 'node_type', nodeType: 'component', mode: 'include' }

  // part_of is strict: a node is not part of itself.
  assert.equal(evalPredicate(view, 'component/child', under), true)
  assert.equal(evalPredicate(view, 'component/b', under), false)

  assert.equal(evalPredicate(view, 'component/child', { type: 'and', of: [under, isComponent] }), true)
  assert.equal(evalPredicate(view, 'entity/a', { type: 'and', of: [under, isComponent] }), false)
  assert.equal(evalPredicate(view, 'component/child', { type: 'not', of: under }), false)
  assert.equal(evalPredicate(view, 'component/b', { type: 'or', of: [under, isComponent] }), true)
  assert.equal(evalPredicate(view, 'entity/a', { type: 'or', of: [under, isComponent] }), false)
  assert.equal(evalPredicate(view, 'entity/a', { type: 'true' }), true)
  assert.equal(evalPredicate(view, 'entity/a', { type: 'false' }), false)
})

test('traversal is bounded, cycle-safe, and keeps the edges it walked', () => {
  const view = viewOf([
    node('entity/a'),
    node('entity/b'),
    node('entity/c'),
    node('entity/d'),
    edge('entity/a', 'part_of', 'entity/b'),
    edge('entity/b', 'part_of', 'entity/c'),
    edge('entity/c', 'part_of', 'entity/d'),
  ])
  const result = traverse(view, { start: 'entity/a', via: ['part_of'], direction: 'out', depth: 2 })
  assert.deepEqual(result.reached, ['entity/a', 'entity/b', 'entity/c'])
  assert.equal(result.walked.length, 2)
  assert.equal(result.truncated, true)
})

test('traversal can walk incoming relations', () => {
  const view = viewOf([
    node('entity/a'),
    node('entity/b'),
    edge('entity/a', 'part_of', 'entity/b'),
  ])
  const result = traverse(view, { start: 'entity/b', via: ['part_of'], direction: 'in', depth: 1 })
  assert.deepEqual(result.reached, ['entity/b', 'entity/a'])
})

test('traversal returns every edge among the reached nodes, not only the BFS tree', () => {
  const view = viewOf([
    node('component/a', 'component'),
    node('component/b', 'component'),
    node('component/c', 'component'),
    node('component/d', 'component'),
    edge('component/a', 'requires', 'component/b'),
    edge('component/a', 'requires', 'component/c'),
    edge('component/b', 'requires', 'component/d'),
    edge('component/c', 'requires', 'component/d'),
  ])
  const result = traverse(view, { start: 'component/a', via: ['requires'], direction: 'out', depth: 3 })
  assert.deepEqual(result.reached.sort(), [
    'component/a',
    'component/b',
    'component/c',
    'component/d',
  ])
  assert.deepEqual(
    result.walked.map((edge) => `${edge.from}->${edge.to}`).sort(),
    [
      'component/a->component/b',
      'component/a->component/c',
      'component/b->component/d',
      'component/c->component/d',
    ],
  )
})

test('an undirected walk over a tree reports no cycles, and a real cycle is reported', () => {
  const tree = viewOf([
    node('entity/root'),
    node('entity/a'),
    node('entity/b'),
    edge('entity/a', 'part_of', 'entity/root'),
    edge('entity/b', 'part_of', 'entity/a'),
  ])
  const treeWalk = traverse(tree, { start: 'entity/a', via: ['part_of'], direction: 'both', depth: 3 })
  assert.deepEqual(treeWalk.cycles, [])

  const triangle = viewOf([
    node('entity/a'),
    node('entity/b'),
    node('entity/c'),
    edge('entity/a', 'part_of', 'entity/b'),
    edge('entity/b', 'part_of', 'entity/c'),
    edge('entity/c', 'part_of', 'entity/a'),
  ])
  const triangleWalk = traverse(triangle, { start: 'entity/a', via: ['part_of'], direction: 'both', depth: 3 })
  assert.equal(triangleWalk.cycles.length, 1)
  assert.deepEqual(triangleWalk.cycles[0], ['entity/a', 'entity/b', 'entity/c', 'entity/a'])
})

test('a directed two-node cycle is reported', () => {
  const view = viewOf([
    node('component/a', 'component'),
    node('component/b', 'component'),
    edge('component/a', 'requires', 'component/b'),
    edge('component/b', 'requires', 'component/a'),
  ])
  const result = traverse(view, { start: 'component/a', via: ['requires'], direction: 'out', depth: 2 })
  assert.equal(result.cycles.length, 1)
  assert.deepEqual(result.cycles[0], ['component/a', 'component/b', 'component/a'])
})
