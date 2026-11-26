import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { Config, apply, GRAPH_FILE } from '../lib/index.js'
import { MAX_EVENTS } from '../lib/graph/schema.js'
import { workspace } from '../test-support/tmp.mjs'

/** A stand-in for the Cordis host: records what the plugin registers. */
function fakeHost() {
  const tools = new Map()
  const sections = []
  const contexts = []
  const listeners = new Map()
  const services = new Map()
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
      context(context) {
        contexts.push(context)
        return () => {}
      },
    },
    on(event, listener) {
      const bucket = listeners.get(event) ?? []
      bucket.push(listener)
      listeners.set(event, bucket)
      return () => {}
    },
    get(name) {
      return services.get(name)
    },
    provide(name, value) {
      services.set(name, value)
      return () => services.delete(name)
    },
  }
  return { ctx, tools, sections, contexts, listeners, services }
}

function exec(cwd, sessionId = 'session-test') {
  return { agent: { sessionId, session: { header: { cwd } } } }
}

const EVIDENCE = [{ kind: 'file', ref: 'docs/design.md' }]

async function call(host, name, args, cwd) {
  const tool = host.tools.get(name)
  assert.ok(tool, `${name} is registered`)
  if (name === 'graph_write' && Array.isArray(args.errors)) {
    args = { ...args, errors: args.errors.map((error) => ({ direction: 'worse', ...error })) }
  }
  return await tool.execute(args, exec(cwd))
}

test('registers four tools, one instruction section, and one recall context', () => {
  const host = fakeHost()
  apply(host.ctx)

  assert.deepEqual([...host.tools.keys()].sort(), [
    'graph_history',
    'graph_query',
    'graph_retract',
    'graph_write',
  ])
  assert.equal(host.sections.length, 1)
  assert.equal(host.sections[0].name, 'cognitive-model:instruction')
  assert.match(host.sections[0].text, /graph_write/)
  assert.match(host.sections[0].text, /guess is refused/)
  assert.equal(host.contexts.length, 1)
  assert.equal(host.contexts[0].name, 'cognitive-model:recall')
  assert.equal(host.contexts[0].required, false)
})

test('publishes the graph as a Host service for sibling plugins', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()

  await call(
    host,
    'graph_write',
    {
      nodes: [
        {
          id: 'objective',
          type: 'objective',
          label: 'Port',
          milestones: [{ text: 'graph', done: true }, { text: 'query', done: false }],
        },
      ],
      evidence: EVIDENCE,
    },
    cwd,
  )

  const service = host.services.get('cognitiveGraph')
  assert.ok(service, 'the service is provided')
  const snapshot = service.snapshot(cwd)
  assert.equal(snapshot.state, 'ready')
  assert.equal(snapshot.nodes.length, 1)
  assert.deepEqual(snapshot.nodes[0].milestones, [
    { text: 'graph', done: true },
    { text: 'query', done: false },
  ])
  assert.equal(snapshot.nodes[0].acceptance.done, 1)
  assert.equal(service.snapshot(undefined).state, 'missing')
  assert.equal(service.snapshot(workspace()).state, 'missing')

  // The same service hands a sibling plugin the block a session starts from,
  // assembled with this plugin's budgets (D108).
  const recall = service.recall(cwd)
  assert.equal(recall.state, 'ready')
  assert.match(recall.text, /^Working memory for this workspace, projected from the event log/)
  assert.match(recall.text, /Objective: Port \[受入: 1\/2\]/)
  assert.equal(service.recall(undefined).state, 'missing')
  assert.equal(service.recall(workspace()).state, 'missing')
})

test('reading the recall block does not spend the bird’s-eye check', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()
  await call(
    host,
    'graph_write',
    {
      nodes: [{ id: 'objective', type: 'objective', label: 'Port' }],
      errors: [
        {
          kind: 'belief',
          subject: 'the premise',
          predicted: 'it held',
          observed: 'it did not',
          revisit: 'objective',
          evidence: EVIDENCE,
        },
      ],
      evidence: EVIDENCE,
    },
    cwd,
  )

  const service = host.services.get('cognitiveGraph')
  const recall = service.recall(cwd)
  assert.equal(recall.state, 'ready')
  // A read must not show the check: it is spent once per reader, by the prompt.
  assert.doesNotMatch(recall.text, /Before continuing/)

  const listener = host.listeners.get('system-prompt/assemble')[0]
  const assembly = exec(cwd)
  await listener({}, assembly, async () => undefined)
  const text = host.contexts[0].text(assembly)
  assert.match(text, /Before continuing: does the work in hand still serve the objective\?/)
})

test('rejects an invalid config instead of half-applying it', () => {
  assert.throws(() => apply(fakeHost().ctx, { maxDepth: 0 }), /maxDepth/)
  assert.throws(() => apply(fakeHost().ctx, { writeTypes: ['nope'] }), /writeTypes\[0\]/)
  const validated = Config['~standard'].validate({ contextLimit: 5 })
  assert.equal(validated.value.contextLimit, 5)
})

test('a write without evidence is refused, and the graph stays empty', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()

  const result = await call(
    host,
    'graph_write',
    { nodes: [{ id: 'objective', type: 'objective', label: 'Port' }] },
    cwd,
  )
  assert.equal(result.ok, false)
  assert.equal(result.code, 'evidence_required')

  const query = await call(host, 'graph_query', {}, cwd)
  assert.deepEqual(query.nodes, [])
})

test('writes a node and a serving edge, then reads them back', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()

  const write = await call(
    host,
    'graph_write',
    {
      nodes: [
        { id: 'objective', type: 'objective', label: 'Port the cognitive model' },
        { id: 'component/graph', type: 'component', label: 'Graph store' },
      ],
      edges: [{ from: 'component/graph', type: 'serves', to: 'objective' }],
      evidence: EVIDENCE,
    },
    cwd,
  )
  assert.equal(write.ok, true)
  assert.deepEqual(write.nodes, ['objective', 'component/graph'])
  assert.equal(write.edges.length, 1)

  const query = await call(host, 'graph_query', { start: 'component/graph', depth: 1 }, cwd)
  assert.equal(query.ok, true)
  const ids = query.nodes.map((node) => node.id).sort()
  assert.deepEqual(ids, ['component/graph', 'objective'])

  // The document on disk holds events, not nodes: state is projected.
  const doc = JSON.parse(readFileSync(path.join(cwd, '.dsh', 'cognitive-model', GRAPH_FILE), 'utf8'))
  assert.equal(doc.events.length, 3)
  assert.equal(doc.events[0].op, 'upsert_node')
  assert.equal(doc.nodes, undefined)
})

test('an edge to a node that does not exist is refused', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()

  const result = await call(
    host,
    'graph_write',
    { edges: [{ from: 'component/x', type: 'serves', to: 'objective' }], evidence: EVIDENCE },
    cwd,
  )
  assert.equal(result.ok, false)
  assert.equal(result.code, 'missing_endpoint')
})

test('writing the same node again is a no-op, and a changed node supersedes', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()
  const node = { id: 'objective', type: 'objective', label: 'Port' }

  const first = await call(host, 'graph_write', { nodes: [node], evidence: EVIDENCE }, cwd)
  assert.equal(first.nodes.length, 1)

  const again = await call(host, 'graph_write', { nodes: [node], evidence: EVIDENCE }, cwd)
  assert.deepEqual(again.nodes, [])
  assert.equal(again.duplicates.length, 1)

  const changed = await call(
    host,
    'graph_write',
    { nodes: [{ ...node, label: 'Port the graph' }], evidence: EVIDENCE },
    cwd,
  )
  assert.equal(changed.nodes.length, 1)

  const query = await call(host, 'graph_query', { start: 'objective' }, cwd)
  assert.equal(query.nodes[0].label, 'Port the graph')

  const history = await call(host, 'graph_history', { node: 'objective' }, cwd)
  assert.equal(history.entries.length, 2)
  assert.equal(history.entries[0].status, 'active')
  assert.equal(history.entries[1].status, 'superseded')
})

test('owner and location are inferred through part_of', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()

  await call(
    host,
    'graph_write',
    {
      nodes: [
        { id: 'entity/file', type: 'entity', label: 'graph.json' },
        { id: 'entity/dir', type: 'entity', label: '.dsh' },
        { id: 'entity/team', type: 'entity', label: 'cognitive' },
        { id: 'entity/room', type: 'entity', label: 'workspace' },
      ],
      edges: [
        { from: 'entity/file', type: 'part_of', to: 'entity/dir' },
        { from: 'entity/dir', type: 'owned_by', to: 'entity/team' },
        { from: 'entity/dir', type: 'located_in', to: 'entity/room' },
      ],
      evidence: EVIDENCE,
    },
    cwd,
  )

  const owner = await call(host, 'graph_query', { start: 'entity/file', infer: 'owner' }, cwd)
  assert.equal(owner.inferred.owner, 'entity/team')
  assert.equal(owner.inferred.source, 'part_of_derived')

  const location = await call(host, 'graph_query', { start: 'entity/file', infer: 'location' }, cwd)
  assert.equal(location.inferred.resolution.kind, 'resolved')
  assert.equal(location.inferred.resolution.location, 'entity/room')
})

test('retracting a node withdraws the edges that point at it', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()

  await call(
    host,
    'graph_write',
    {
      nodes: [
        { id: 'objective', type: 'objective', label: 'Port' },
        { id: 'component/graph', type: 'component', label: 'Graph' },
      ],
      edges: [{ from: 'component/graph', type: 'serves', to: 'objective' }],
      evidence: EVIDENCE,
    },
    cwd,
  )

  const retract = await call(
    host,
    'graph_retract',
    {
      nodes: ['component/graph'],
      reason: 'merged into another component',
      evidence: [{ kind: 'note', ref: 'the human asked to merge them' }],
    },
    cwd,
  )
  assert.equal(retract.ok, true)
  assert.deepEqual(retract.nodes, ['component/graph'])

  const query = await call(host, 'graph_query', {}, cwd)
  assert.deepEqual(query.nodes.map((node) => node.id), ['objective'])

  const missing = await call(host, 'graph_query', { start: 'component/graph' }, cwd)
  assert.match(missing.note, /withdrawn/)
})

test('the passive recall shows the objective tree, the current task, and acceptance', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()

  await call(
    host,
    'graph_write',
    {
      nodes: [
        { id: 'objective', type: 'objective', label: 'Port', milestones: [{ text: 'graph', done: true }, { text: 'query', done: false }] },
        { id: 'component/graph', type: 'component', label: 'Graph', milestones: [{ text: 'project', done: true }] },
        { id: 'task/current', type: 'task', label: 'Build the graph' },
      ],
      edges: [
        { from: 'component/graph', type: 'serves', to: 'objective' },
        { from: 'task/current', type: 'serves', to: 'component/graph' },
      ],
      evidence: EVIDENCE,
    },
    cwd,
  )

  // The assemble warm-up loads the cache the synchronous provider reads.
  const listener = host.listeners.get('system-prompt/assemble')[0]
  const assembly = exec(cwd)
  await listener({}, assembly, async () => undefined)

  const text = host.contexts[0].text(assembly)
  assert.match(text, /^Working memory for this workspace, projected from the event log/)
  assert.match(text, /Objective: Port \[tasks: 1\] \[受入: 1\/2\]/)
  assert.match(text, /Path: objective → component\/graph/)
  // The objective's unmet acceptance item is remaining work, not a count.
  assert.match(text, /Remaining:\n- 未達 \[objective\] query/)
  // A finished acceptance count is history; only the unmet item is shown.
  assert.match(text, /^  - Graph \[tasks: 1\]$/m)
  assert.match(text, /Now: Build the graph/)
})

test('a hand-written second active event is surfaced as a conflict', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()
  await call(host, 'graph_write', { nodes: [{ id: 'objective', type: 'objective', label: 'A' }], evidence: EVIDENCE }, cwd)

  // Simulate a concurrent writer that appended without superseding.
  const file = path.join(cwd, '.dsh', 'cognitive-model', GRAPH_FILE)
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  const last = doc.events[doc.events.length - 1]
  doc.events.push({
    ...last,
    seq: doc.nextSeq,
    id: 'evt_concurrent',
    node: { id: 'objective', type: 'objective', label: 'B' },
    supersedes: [],
  })
  doc.nextSeq += 1
  const { writeFileSync } = await import('node:fs')
  writeFileSync(file, JSON.stringify(doc, null, 2))

  const query = await call(host, 'graph_query', {}, cwd)
  assert.equal(query.conflicts.length, 1)
  assert.equal(query.conflicts[0].key, 'node:objective')
  assert.equal(query.nodes.length, 0)
})

// ---------------------------------------------------------------- the review fixes

test('a duplicate id in one batch is one node, not a conflict', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()

  const write = await call(
    host,
    'graph_write',
    {
      nodes: [
        { id: 'task/current', type: 'task', label: 'first' },
        { id: 'task/current', type: 'task', label: 'second' },
      ],
      evidence: EVIDENCE,
    },
    cwd,
  )
  assert.equal(write.ok, true)

  const query = await call(host, 'graph_query', {}, cwd)
  assert.deepEqual(query.nodes.map((node) => node.id), ['task/current'])
  assert.equal(query.nodes[0].label, 'second')
  assert.deepEqual(query.conflicts, [])

  // A later write still works: the conflict is not permanent.
  const later = await call(
    host,
    'graph_write',
    { nodes: [{ id: 'task/current', type: 'task', label: 'third' }], evidence: EVIDENCE },
    cwd,
  )
  assert.equal(later.nodes.length, 1)
  const after = await call(host, 'graph_query', { start: 'task/current' }, cwd)
  assert.equal(after.nodes[0].label, 'third')
})

test('a duplicate edge in one batch is one edge, not a conflict', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()

  await call(
    host,
    'graph_write',
    {
      nodes: [
        { id: 'component/a', type: 'component', label: 'A' },
        { id: 'component/b', type: 'component', label: 'B' },
      ],
      evidence: EVIDENCE,
    },
    cwd,
  )
  const write = await call(
    host,
    'graph_write',
    {
      edges: [
        { from: 'component/a', type: 'requires', to: 'component/b' },
        { from: 'component/a', type: 'requires', to: 'component/b' },
      ],
      evidence: EVIDENCE,
    },
    cwd,
  )
  assert.equal(write.ok, true)

  const query = await call(host, 'graph_query', { start: 'component/a', depth: 1 }, cwd)
  assert.deepEqual(
    query.edges.map((edge) => `${edge.from} -${edge.type}-> ${edge.to}`),
    ['component/a -requires-> component/b'],
  )
  assert.deepEqual(query.conflicts, [])
})

test('retracting the same node twice in one call is one withdrawal', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()

  await call(
    host,
    'graph_write',
    { nodes: [{ id: 'component/graph', type: 'component', label: 'Graph' }], evidence: EVIDENCE },
    cwd,
  )
  const retract = await call(
    host,
    'graph_retract',
    {
      nodes: ['component/graph', 'component/graph'],
      reason: 'merged',
      evidence: [{ kind: 'note', ref: 'the human asked to merge them' }],
    },
    cwd,
  )
  assert.equal(retract.ok, true)

  const query = await call(host, 'graph_query', {}, cwd)
  assert.deepEqual(query.nodes, [])
  assert.deepEqual(query.conflicts, [])
  const history = await call(host, 'graph_history', { node: 'component/graph' }, cwd)
  assert.equal(history.entries.length, 2)
  assert.equal(history.entries[0].status, 'active')
})

test('a second target of a functional relation replaces the first', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()

  await call(
    host,
    'graph_write',
    {
      nodes: [
        { id: 'entity/a', type: 'entity', label: 'A' },
        { id: 'entity/b', type: 'entity', label: 'B' },
        { id: 'entity/c', type: 'entity', label: 'C' },
      ],
      evidence: EVIDENCE,
    },
    cwd,
  )
  await call(
    host,
    'graph_write',
    { edges: [{ from: 'entity/a', type: 'part_of', to: 'entity/b' }], evidence: EVIDENCE },
    cwd,
  )
  const second = await call(
    host,
    'graph_write',
    { edges: [{ from: 'entity/a', type: 'part_of', to: 'entity/c' }], evidence: EVIDENCE },
    cwd,
  )
  assert.equal(second.ok, true)

  const query = await call(host, 'graph_query', { start: 'entity/a', depth: 1 }, cwd)
  assert.deepEqual(
    query.edges.map((edge) => `${edge.from} -${edge.type}-> ${edge.to}`),
    ['entity/a -part_of-> entity/c'],
  )
  assert.deepEqual(query.conflicts, [])

  const history = await call(host, 'graph_history', { edge: { from: 'entity/a', type: 'part_of' } }, cwd)
  assert.equal(history.entries.length, 2)
  assert.equal(history.entries[0].status, 'active')
  assert.equal(history.entries[1].status, 'superseded')
})

test('a verified claim supersedes the reported one, and the evidence is kept', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()
  const node = { id: 'fact/tests', type: 'fact', label: 'Tests', value: 'the suite passes' }

  await call(
    host,
    'graph_write',
    { nodes: [node], evidence: [{ kind: 'note', ref: 'the human said the suite passes' }] },
    cwd,
  )
  const upgrade = await call(
    host,
    'graph_write',
    { nodes: [node], evidence: [{ kind: 'command', ref: 'node --test' }] },
    cwd,
  )
  assert.equal(upgrade.nodes.length, 1)
  assert.deepEqual(upgrade.duplicates, [])

  const query = await call(host, 'graph_query', { start: 'fact/tests' }, cwd)
  assert.equal(query.nodes[0].confidence, 'verified')
  const history = await call(host, 'graph_history', { node: 'fact/tests' }, cwd)
  assert.equal(history.entries.length, 2)
  assert.equal(history.entries[0].confidence, 'verified')
  assert.equal(history.entries[1].confidence, 'reported')
})

test('an invalid or inverted valid-time window is refused', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()
  const node = { id: 'fact/x', type: 'fact', label: 'X', value: 'claim' }

  const bad = await call(host, 'graph_write', { nodes: [node], evidence: EVIDENCE, validFrom: 'not-a-date' }, cwd)
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'invalid_valid_time')

  const inverted = await call(
    host,
    'graph_write',
    {
      nodes: [node],
      evidence: EVIDENCE,
      validFrom: '2030-01-01T00:00:00Z',
      validTo: '2020-01-01T00:00:00Z',
    },
    cwd,
  )
  assert.equal(inverted.ok, false)
  assert.equal(inverted.code, 'invalid_valid_time')
})

test('an error that cites a fact which does not exist is refused', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()

  const result = await call(
    host,
    'graph_write',
    {
      errors: [
        {
          kind: 'belief',
          subject: 'ledger',
          predicted: 'a',
          observed: 'b',
          factId: 'fact/does-not-exist',
        },
      ],
      evidence: [{ kind: 'command', ref: 'node --test' }],
    },
    cwd,
  )
  assert.equal(result.ok, false)
  assert.equal(result.code, 'fact_not_found')
})

test('an edge between the wrong kinds is refused', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()

  const factServes = await call(
    host,
    'graph_write',
    {
      nodes: [
        { id: 'fact/x', type: 'fact', label: 'X' },
        { id: 'objective', type: 'objective', label: 'Goal' },
      ],
      edges: [{ from: 'fact/x', type: 'serves', to: 'objective' }],
      evidence: EVIDENCE,
    },
    cwd,
  )
  assert.equal(factServes.ok, false)
  assert.equal(factServes.code, 'invalid_edge_endpoint')

  const worldIntoObjective = await call(
    host,
    'graph_write',
    {
      nodes: [
        { id: 'objective', type: 'objective', label: 'Goal' },
        { id: 'fact/x', type: 'fact', label: 'X' },
      ],
      edges: [{ from: 'objective', type: 'part_of', to: 'fact/x' }],
      evidence: EVIDENCE,
    },
    cwd,
  )
  assert.equal(worldIntoObjective.ok, false)
  assert.equal(worldIntoObjective.code, 'invalid_edge_endpoint')
})

test('the trust matrix refuses a preference from the model and a decision from an executor', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()

  const preference = await call(
    host,
    'graph_write',
    { nodes: [{ id: 'preference/x', type: 'preference', label: 'x' }], evidence: EVIDENCE },
    cwd,
  )
  assert.equal(preference.ok, false)
  assert.equal(preference.code, 'source_not_trusted')

  const decision = await call(
    host,
    'graph_write',
    {
      nodes: [{ id: 'decision/x', type: 'decision', label: 'x', value: 'why' }],
      evidence: [{ kind: 'note', ref: 'the executor reported it' }],
      source: 'executor_summary',
    },
    cwd,
  )
  assert.equal(decision.ok, false)
  assert.equal(decision.code, 'source_not_trusted')

  const guess = await call(
    host,
    'graph_write',
    {
      nodes: [{ id: 'fact/y', type: 'fact', label: 'y' }],
      evidence: EVIDENCE,
      source: 'agent_inference',
    },
    cwd,
  )
  assert.equal(guess.ok, false)
  assert.equal(guess.code, 'source_not_trusted')
})

test('a refused write is counted in stats.rejections', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()

  const refused = await call(host, 'graph_write', { nodes: [{ id: 'objective', type: 'objective', label: 'A' }] }, cwd)
  assert.equal(refused.ok, false)

  const doc = JSON.parse(readFileSync(path.join(cwd, '.dsh', 'cognitive-model', GRAPH_FILE), 'utf8'))
  assert.equal(doc.stats.rejections, 1)
  assert.equal(doc.events.length, 0)
})

test('the node cap refuses a batch that would exceed it', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()
  const nodes = Array.from({ length: 2001 }, (_, index) => ({
    id: `fact/f${index}`,
    type: 'fact',
    label: `f${index}`,
  }))

  const result = await call(host, 'graph_write', { nodes, evidence: EVIDENCE }, cwd)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'too_many_nodes')
})

test('every tool renders its result as text', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()

  const write = await call(
    host,
    'graph_write',
    { nodes: [{ id: 'objective', type: 'objective', label: 'Port' }], evidence: EVIDENCE },
    cwd,
  )
  const render = (name, value) => host.tools.get(name).output.render({}, value)

  assert.match(render('graph_write', write)[0].text, /^written: 1 node\(s\)/)
  assert.match(render('graph_write', { ok: false, error: 'refused' })[0].text, /^not written: refused/)

  const query = await call(host, 'graph_query', {}, cwd)
  assert.match(render('graph_query', query)[0].text, /^1 node\(s\)/)
  assert.match(
    render('graph_query', { ok: false, error: 'refused' })[0].text,
    /^query failed: refused/,
  )

  const errors = await call(host, 'graph_query', { errors: true }, cwd)
  assert.match(render('graph_query', errors)[0].text, /^0 prediction error\(s\)/)

  const history = await call(host, 'graph_history', { node: 'objective' }, cwd)
  assert.match(render('graph_history', history)[0].text, /\[active, observed\]/)

  const retract = await call(
    host,
    'graph_retract',
    { nodes: ['objective'], reason: 'done', evidence: [{ kind: 'note', ref: 'the human said so' }] },
    cwd,
  )
  assert.match(render('graph_retract', retract)[0].text, /^retracted: 1 node\(s\)/)
  assert.match(
    render('graph_retract', { ok: false, error: 'refused' })[0].text,
    /^not retracted: refused/,
  )
})

test('graph_history reports the total behind the limit', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()

  for (const label of ['first', 'second', 'third']) {
    await call(host, 'graph_write', { nodes: [{ id: 'objective', type: 'objective', label }], evidence: EVIDENCE }, cwd)
  }
  const history = await call(host, 'graph_history', { node: 'objective', limit: 2 }, cwd)
  assert.equal(history.entries.length, 2)
  assert.equal(history.total, 3)
})


test('a full event log refuses a write and a retraction, and names the reset', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()
  const file = path.join(cwd, '.dsh', 'cognitive-model', GRAPH_FILE)
  const events = Array.from({ length: MAX_EVENTS - 1 }, (_, index) => ({
    seq: index + 1,
    id: `evt_${index}`,
    at: '2026-01-01T00:00:00.000Z',
    op: 'record_error',
    scope: 'repo',
    error: {
      id: `pre_${index}`,
      kind: 'belief',
      direction: 'worse',
      subject: `s${index}`,
      predicted: 'a',
      observed: 'b',
    },
    evidence: [{ kind: 'command', ref: 'node --test' }],
    source: 'verified_command',
    supersedes: [],
    invalidates: [],
  }))
  // The last slot holds the node the retraction below tries to withdraw.
  events.push({
    seq: MAX_EVENTS,
    id: 'evt_node',
    at: '2026-01-01T00:00:00.000Z',
    op: 'upsert_node',
    scope: 'repo',
    node: { id: 'fact/x', type: 'fact', label: 'x' },
    evidence: [{ kind: 'command', ref: 'node --test' }],
    source: 'verified_command',
    supersedes: [],
    invalidates: [],
  })
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 2,
      workspace: cwd,
      events,
      stats: { writes: events.length, retractions: 0, rejections: 0, duplicates: 0 },
      nextSeq: MAX_EVENTS + 1,
    }),
  )

  const result = await call(
    host,
    'graph_write',
    { nodes: [{ id: 'fact/x', type: 'fact', label: 'x' }], evidence: EVIDENCE },
    cwd,
  )
  assert.equal(result.ok, false)
  assert.equal(result.code, 'event_log_full')
  assert.match(result.error, /deleting/)

  const retracted = await call(
    host,
    'graph_retract',
    { nodes: ['fact/x'], reason: 'no longer needed', evidence: EVIDENCE },
    cwd,
  )
  assert.equal(retracted.ok, false)
  assert.equal(retracted.code, 'event_log_full')
  assert.match(retracted.error, /deleting/)
})
