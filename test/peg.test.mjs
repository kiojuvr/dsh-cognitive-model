import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  apply,
  graphSnapshot,
  migratePegDocument,
  RECALL_HEURISTIC_LIMIT,
} from '../lib/index.js'
import { workspace } from '../test-support/tmp.mjs'

/** A stand-in for the Cordis host: records what the plugin registers. */
function fakeHost() {
  const tools = new Map()
  const sections = []
  const contexts = []
  const listeners = new Map()
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
    get() {
      return undefined
    },
  }
  return { ctx, tools, sections, contexts, listeners }
}

function exec(cwd, sessionId = 'session-test') {
  return { agent: { sessionId, session: { header: { cwd } } } }
}

const FILE_EVIDENCE = [{ kind: 'file', ref: 'docs/design.md' }]

async function call(host, name, args, cwd) {
  const tool = host.tools.get(name)
  assert.ok(tool, `${name} is registered`)
  return await tool.execute(args, exec(cwd))
}

async function recallOf(host, cwd, sessionId = 'session-test') {
  const listener = host.listeners.get('system-prompt/assemble')[0]
  const assembly = exec(cwd, sessionId)
  await listener({}, assembly, async () => undefined)
  return host.contexts[0].text(assembly)
}

async function structure(host, cwd) {
  await call(
    host,
    'graph_write',
    {
      nodes: [
        { id: 'objective', type: 'objective', label: 'Port' },
        { id: 'component/verification', type: 'component', label: 'verification' },
        { id: 'component/elsewhere', type: 'component', label: 'elsewhere' },
        { id: 'task/current', type: 'task', label: 'PEG loop' },
      ],
      edges: [
        { from: 'component/verification', type: 'serves', to: 'objective' },
        { from: 'component/elsewhere', type: 'serves', to: 'objective' },
        { from: 'task/current', type: 'serves', to: 'component/verification' },
      ],
      evidence: FILE_EVIDENCE,
    },
    cwd,
  )
}

async function errorOf(host, cwd, overrides = {}) {
  const written = await call(
    host,
    'graph_write',
    {
      errors: [
        {
          kind: 'outcome',
          direction: 'worse',
          subject: 'child spawn',
          predicted: 'node --test runs the suite',
          observed: 'spawn is denied in this sandbox',
          lesson: 'use node test/all.mjs',
          ...overrides,
        },
      ],
      evidence: FILE_EVIDENCE,
    },
    cwd,
  )
  assert.equal(written.ok, true)
  return written.errors[0]
}

test('a prediction error is signed: better and worse are distinct records', async () => {
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
          kind: 'estimate',
          direction: 'better',
          subject: 'build time',
          predicted: 'a full rebuild takes ten minutes',
          observed: 'the full rebuild took four minutes',
          lesson: 'do not block a long window for the build',
        },
        {
          kind: 'estimate',
          direction: 'worse',
          subject: 'build time',
          predicted: 'a full rebuild takes one minute',
          observed: 'the full rebuild took ten minutes',
          lesson: 'block a window for the build',
        },
      ],
      evidence: FILE_EVIDENCE,
    },
    cwd,
  )

  const query = await call(host, 'graph_query', { errors: true }, cwd)
  assert.deepEqual(query.errors.map((error) => error.direction).sort(), ['better', 'worse'])

  const text = await recallOf(host, cwd)
  // The block indexes the log; the signed records are read with the query.
  assert.match(text, /Prediction errors: 2 recorded \(graph_query errors=true\)\./)
})

test('a positive error can put an acceptance item in question', async () => {
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
          kind: 'outcome',
          direction: 'better',
          subject: 'the export',
          predicted: 'the export is missing',
          observed: 'the export already exists',
          revisit: 'acceptance',
        },
      ],
      evidence: FILE_EVIDENCE,
    },
    cwd,
  )

  const text = await recallOf(host, cwd)
  assert.match(text, /Before continuing:/)
  assert.match(text, /\[outcome\/better\] the export/)
})

test('a heuristic is distilled from errors and appears in the experience section', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()
  await structure(host, cwd)
  const errorId = await errorOf(host, cwd)

  const written = await call(
    host,
    'graph_write',
    {
      nodes: [
        {
          id: 'heuristic/test-runner',
          type: 'heuristic',
          label: 'use test/all.mjs',
          value: 'run node test/all.mjs instead of node --test',
          direction: 'worse',
          conditions: 'when the sandbox denies child spawn',
          errorIds: [errorId],
        },
      ],
      edges: [{ from: 'heuristic/test-runner', type: 'node', to: 'component/verification' }],
      evidence: FILE_EVIDENCE,
    },
    cwd,
  )
  assert.equal(written.ok, true)

  const text = await recallOf(host, cwd)
  assert.match(text, /Experience \(rules distilled from earlier prediction errors/)
  assert.match(
    text,
    /- \[worse\] use test\/all\.mjs \(repo; when the sandbox denies child spawn\): run node test\/all\.mjs instead of node --test/,
  )
  assert.match(text, /1 observation\(s\) \(pre_/)
  assert.match(text, /\[for component\/verification\]/)
  assert.ok(text.indexOf('Experience (') < text.indexOf('Prediction errors:'))
  // The rule is a node, so it is queryable with its fields.
  const query = await call(host, 'graph_query', { start: 'heuristic/test-runner' }, cwd)
  const node = query.nodes.find((entry) => entry.id === 'heuristic/test-runner')
  assert.equal(node?.direction, 'worse')
  assert.deepEqual(node?.errorIds, [errorId])
})

test('the experience section follows the current path before recency', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()
  await structure(host, cwd)
  const errorId = await errorOf(host, cwd)

  const heuristic = (id, label, target) => ({
    node: {
      id,
      type: 'heuristic',
      label,
      value: `${label} value`,
      direction: 'worse',
      conditions: 'always',
      errorIds: [errorId],
    },
    ...(target === undefined
      ? {}
      : { edge: { from: id, type: 'node', to: target } }),
  })
  const onPath = heuristic('heuristic/on', 'on-path rule', 'component/verification')
  const offPath = heuristic('heuristic/off', 'off-path rule', 'component/elsewhere')

  await call(
    host,
    'graph_write',
    { nodes: [onPath.node], edges: onPath.edge === undefined ? [] : [onPath.edge], evidence: FILE_EVIDENCE },
    cwd,
  )
  await call(
    host,
    'graph_write',
    { nodes: [offPath.node], edges: offPath.edge === undefined ? [] : [offPath.edge], evidence: FILE_EVIDENCE },
    cwd,
  )

  const text = await recallOf(host, cwd)
  // The off-path rule is newer, but the current-path rule is shown first.
  assert.ok(text.indexOf('on-path rule') < text.indexOf('off-path rule'))
})

test('the experience section is bounded and does not push facts or errors out', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()
  await structure(host, cwd)
  const errorId = await errorOf(host, cwd)

  await call(
    host,
    'graph_write',
    {
      nodes: [
        { id: 'constraint/keep', type: 'constraint', label: 'keep', value: 'must hold' },
        ...Array.from({ length: RECALL_HEURISTIC_LIMIT + 1 }, (_, index) => ({
          id: `heuristic/rule-${index}`,
          type: 'heuristic',
          label: `rule ${index}`,
          value: `value ${index}`,
          direction: 'worse',
          conditions: 'always',
          errorIds: [errorId],
        })),
      ],
      evidence: FILE_EVIDENCE,
    },
    cwd,
  )

  const text = await recallOf(host, cwd)
  const rules = text.split('\n').filter((line) => /^- \[(better|worse)\]/.test(line))
  assert.equal(rules.length, RECALL_HEURISTIC_LIMIT)
  assert.match(text, /Constraints:/)
  assert.match(text, /- keep: must hold/)
  assert.match(text, /Prediction errors:/)
})

test('a heuristic needs direction, conditions, and active error ids', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()
  await structure(host, cwd)
  const errorId = await errorOf(host, cwd)

  const base = {
    id: 'heuristic/check',
    type: 'heuristic',
    label: 'check',
    value: 'do the thing',
    direction: 'worse',
    conditions: 'always',
    errorIds: [errorId],
  }
  const write = (node, extra = {}) =>
    call(host, 'graph_write', { nodes: [node], evidence: FILE_EVIDENCE, ...extra }, cwd)

  const noDirection = await write({ ...base, direction: undefined })
  assert.equal(noDirection.ok, false)
  assert.equal(noDirection.code, 'unknown_direction')

  const noConditions = await write({ ...base, conditions: undefined })
  assert.equal(noConditions.ok, false)
  assert.equal(noConditions.code, 'conditions_required')

  const noErrors = await write({ ...base, errorIds: [] })
  assert.equal(noErrors.ok, false)
  assert.equal(noErrors.code, 'error_ids_required')

  const unknownError = await write({ ...base, errorIds: ['pre_missing'] })
  assert.equal(unknownError.ok, false)
  assert.equal(unknownError.code, 'error_not_found')

  const duplicateError = await write({ ...base, errorIds: [errorId, errorId] })
  assert.equal(duplicateError.ok, false)
  assert.equal(duplicateError.code, 'duplicate_error_ids')

  const onFact = await write({
    id: 'fact/not-a-rule',
    type: 'fact',
    label: 'not a rule',
    direction: 'worse',
    conditions: 'always',
    errorIds: [errorId],
  })
  assert.equal(onFact.ok, false)
  assert.equal(onFact.code, 'heuristic_fields_only')
})

test('a retracted heuristic leaves the experience section', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()
  await structure(host, cwd)
  const errorId = await errorOf(host, cwd)

  await call(
    host,
    'graph_write',
    {
      nodes: [
        {
          id: 'heuristic/test-runner',
          type: 'heuristic',
          label: 'use test/all.mjs',
          value: 'run node test/all.mjs',
          direction: 'worse',
          conditions: 'when child spawn is denied',
          errorIds: [errorId],
        },
      ],
      evidence: FILE_EVIDENCE,
    },
    cwd,
  )
  assert.match(await recallOf(host, cwd), /Experience \(/)

  const retracted = await call(
    host,
    'graph_retract',
    { nodes: ['heuristic/test-runner'], reason: 'the sandbox changed', evidence: FILE_EVIDENCE },
    cwd,
  )
  assert.equal(retracted.ok, true)
  assert.doesNotMatch(await recallOf(host, cwd), /Experience \(/)
})

test('the schema-2 migration signs old errors and is idempotent', () => {
  const doc = {
    schemaVersion: 1,
    workspace: 'w',
    events: [
      {
        seq: 1,
        id: 'evt_1',
        at: '2026-01-01T00:00:00.000Z',
        op: 'record_error',
        scope: 'repo',
        error: {
          id: 'pre_1',
          kind: 'belief',
          subject: 'old',
          predicted: 'a',
          observed: 'b',
        },
        evidence: [{ kind: 'file', ref: 'README.md' }],
        source: 'verified_command',
        supersedes: [],
        invalidates: [],
      },
      {
        seq: 2,
        id: 'evt_2',
        at: '2026-01-01T00:00:00.000Z',
        op: 'upsert_node',
        scope: 'repo',
        node: { id: 'objective', type: 'objective', label: 'goal' },
        evidence: [{ kind: 'file', ref: 'README.md' }],
        source: 'verified_command',
        supersedes: [],
        invalidates: [],
      },
    ],
    stats: { writes: 2, retractions: 0, rejections: 0, duplicates: 0 },
    nextSeq: 3,
  }

  const first = migratePegDocument(doc)
  assert.equal(first.changed, 1)
  assert.equal(first.doc.schemaVersion, 2)
  assert.equal(first.doc.events[0].error.direction, 'worse')
  assert.equal(first.doc.events[1].node.id, 'objective')

  const second = migratePegDocument(first.doc)
  assert.equal(second.changed, 0)
  assert.equal(second.doc, first.doc)
})

test('the full conditions are shown, including a trailing exception', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()
  await structure(host, cwd)
  const errorId = await errorOf(host, cwd)
  const conditions =
    'when only a few source files changed, except when the lockfile changed or the build cache is cold'

  await call(
    host,
    'graph_write',
    {
      nodes: [
        {
          id: 'heuristic/long-condition',
          type: 'heuristic',
          label: 'incremental build',
          value: 'run the incremental build first',
          direction: 'better',
          conditions,
          errorIds: [errorId],
        },
      ],
      evidence: FILE_EVIDENCE,
    },
    cwd,
  )

  const text = await recallOf(host, cwd)
  assert.match(text, new RegExp(conditions))
})

test('the PEG loop runs end to end: signed errors -> heuristic -> a new session -> retract', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()
  await structure(host, cwd)

  const written = await call(
    host,
    'graph_write',
    {
      errors: [
        {
          kind: 'estimate',
          direction: 'better',
          subject: 'incremental build',
          predicted: 'a full rebuild is needed',
          observed: 'the incremental build took 40 seconds',
          lesson: 'try the incremental build first',
        },
        {
          kind: 'outcome',
          direction: 'worse',
          subject: 'full rebuild',
          predicted: 'the full rebuild is quick',
          observed: 'the full rebuild took ten minutes',
          lesson: 'block a window for a full rebuild',
        },
      ],
      evidence: FILE_EVIDENCE,
    },
    cwd,
  )
  assert.equal(written.errors.length, 2)
  const [betterId, worseId] = written.errors

  const heuristic = await call(
    host,
    'graph_write',
    {
      nodes: [
        {
          id: 'heuristic/incremental-first',
          type: 'heuristic',
          label: 'try the incremental build first',
          value: 'run the incremental build before a full rebuild',
          direction: 'better',
          conditions: 'when only a few source files changed',
          errorIds: [betterId, worseId],
        },
      ],
      edges: [{ from: 'heuristic/incremental-first', type: 'node', to: 'component/verification' }],
      evidence: FILE_EVIDENCE,
    },
    cwd,
  )
  assert.equal(heuristic.ok, true)

  // A different session sees the rule; the signed errors are one query away.
  const text = await recallOf(host, cwd, 'session-next')
  assert.match(text, /Experience \(/)
  assert.match(text, /- \[better\] try the incremental build first/)
  assert.match(text, /2 observation\(s\)/)
  assert.match(text, /Prediction errors: 2 recorded/)

  // Withdrawing the rule removes the Experience section, not the error log.
  const retracted = await call(
    host,
    'graph_retract',
    { nodes: ['heuristic/incremental-first'], reason: 'the build changed', evidence: FILE_EVIDENCE },
    cwd,
  )
  assert.equal(retracted.ok, true)
  const after = await recallOf(host, cwd, 'session-next')
  assert.doesNotMatch(after, /Experience \(/)
  assert.match(after, /Prediction errors: 2 recorded/)
})

test('an unmigrated graph is refused without being rewritten', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()
  const file = path.join(cwd, '.dsh', 'cognitive-model', 'graph.json')
  mkdirSync(path.dirname(file), { recursive: true })
  const old = {
    schemaVersion: 1,
    workspace: cwd,
    events: [
      {
        seq: 1,
        id: 'evt_1',
        at: '2026-01-01T00:00:00.000Z',
        op: 'record_error',
        scope: 'repo',
        error: {
          id: 'pre_1',
          kind: 'belief',
          subject: 'old',
          predicted: 'a',
          observed: 'b',
        },
        evidence: [{ kind: 'file', ref: 'README.md' }],
        source: 'verified_command',
        supersedes: [],
        invalidates: [],
      },
      {
        seq: 2,
        id: 'evt_2',
        at: '2026-01-01T00:00:00.000Z',
        op: 'upsert_node',
        scope: 'repo',
        node: { id: 'objective', type: 'objective', label: 'goal' },
        evidence: [{ kind: 'file', ref: 'README.md' }],
        source: 'verified_command',
        supersedes: [],
        invalidates: [],
      },
    ],
    stats: { writes: 2, retractions: 0, rejections: 0, duplicates: 0 },
    nextSeq: 3,
  }
  writeFileSync(file, `${JSON.stringify(old, null, 2)}\n`, 'utf8')
  const before = readFileSync(file, 'utf8')

  await assert.rejects(call(host, 'graph_query', { errors: true }, cwd), /migrate-peg/)
  await assert.rejects(
    call(
      host,
      'graph_write',
      { nodes: [{ id: 'objective', type: 'objective', label: 'new' }], evidence: FILE_EVIDENCE },
      cwd,
    ),
    /migrate-peg/,
  )
  assert.equal(readFileSync(file, 'utf8'), before)

  const snapshot = graphSnapshot(cwd)
  assert.equal(snapshot.state, 'error')
  // The dashboard shows this text to a human, so it describes the state and
  // does not hand out a command (D77). The tool refusal names the command.
  assert.match(snapshot.message, /schema 1/)
  assert.doesNotMatch(snapshot.message, /migrate-peg/)

  // The migration makes the same graph readable.
  const migrated = migratePegDocument(JSON.parse(before))
  writeFileSync(file, `${JSON.stringify(migrated.doc, null, 2)}\n`, 'utf8')
  const query = await call(host, 'graph_query', { errors: true }, cwd)
  assert.equal(query.ok, true)
  assert.equal(query.errors[0].direction, 'worse')
})
