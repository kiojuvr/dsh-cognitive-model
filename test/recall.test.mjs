import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../lib/index.js'
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
const NOTE_EVIDENCE = [{ kind: 'note', ref: 'the human said so' }]

async function call(host, name, args, cwd) {
  const tool = host.tools.get(name)
  assert.ok(tool, `${name} is registered`)
  // The signed record is the schema now; most fixtures exercise a negative
  // miss. An explicit direction still wins, so a test can write a positive one.
  if (name === 'graph_write' && Array.isArray(args.errors)) {
    args = { ...args, errors: args.errors.map((error) => ({ direction: 'worse', ...error })) }
  }
  return await tool.execute(args, exec(cwd))
}

async function recallOf(host, cwd, sessionId = 'session-test') {
  const listener = host.listeners.get('system-prompt/assemble')[0]
  const assembly = exec(cwd, sessionId)
  await listener({}, assembly, async () => undefined)
  return host.contexts[0].text(assembly)
}

test('the epistemic nodes are written and recalled under their own headings', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()

  await call(
    host,
    'graph_write',
    {
      nodes: [
        { id: 'objective', type: 'objective', label: 'Port' },
        { id: 'constraint/no-force-push', type: 'constraint', label: 'no force push', value: 'never rewrite a published branch' },
        { id: 'decision/one-store', type: 'decision', label: 'one store', value: 'the graph is the only ledger' },
        { id: 'risk/stale-cache', type: 'risk', label: 'stale cache', value: 'the projection can lag the file' },
        { id: 'fact/build', type: 'fact', label: 'build', value: 'the build is tsc -p tsconfig.json' },
      ],
      evidence: FILE_EVIDENCE,
    },
    cwd,
  )
  const preference = await call(
    host,
    'graph_write',
    {
      nodes: [{ id: 'preference/japanese', type: 'preference', label: 'language', value: 'reply in Japanese' }],
      evidence: NOTE_EVIDENCE,
    },
    cwd,
  )
  assert.equal(preference.ok, true)

  const text = await recallOf(host, cwd)
  assert.match(text, /Constraints:\n- no force push: never rewrite a published branch/)
  assert.match(text, /Decisions:\n- one store: the graph is the only ledger/)
  assert.match(text, /Open risks:\n- stale cache: the projection can lag the file/)
  // A fact is reference material: it reaches the block only through a `node`
  // edge to the current path, and here nothing links it.
  assert.match(text, /Facts: 1 recorded, none linked to the current path/)
  assert.match(text, /Preferences:\n- language: reply in Japanese \(reported\)/)
  // A preference is intent: the "unverified" caveat must not fire for it alone.
  assert.doesNotMatch(text, /Labels say how each item was recorded/)
})

test('a constraint that the human reported carries the unverified caveat', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()

  await call(
    host,
    'graph_write',
    {
      nodes: [{ id: 'constraint/no-force-push', type: 'constraint', label: 'no force push', value: 'never rewrite a published branch' }],
      evidence: NOTE_EVIDENCE,
    },
    cwd,
  )

  const text = await recallOf(host, cwd)
  assert.match(text, /no force push: never rewrite a published branch \(reported, unverified\)/)
  assert.match(text, /Labels say how each item was recorded/)
})

test('a prediction error needs an observation, and is recalled and queryable', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()

  const refused = await call(
    host,
    'graph_write',
    {
      errors: [
        { kind: 'outcome', subject: 'reload', predicted: 'the page shows the new card', observed: 'it did not' },
      ],
      evidence: NOTE_EVIDENCE,
    },
    cwd,
  )
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'observation_required')

  const written = await call(
    host,
    'graph_write',
    {
      errors: [
        {
          kind: 'outcome',
          subject: 'reload',
          predicted: 'the page shows the new card',
          observed: 'the host had not re-applied the plugin',
          lesson: 're-enable the plugin instead of reloading',
        },
      ],
      evidence: FILE_EVIDENCE,
    },
    cwd,
  )
  assert.equal(written.ok, true)
  assert.equal(written.errors.length, 1)

  const again = await call(
    host,
    'graph_write',
    {
      errors: [
        {
          kind: 'outcome',
          subject: 'reload',
          predicted: 'the page shows the new card',
          observed: 'the host had not re-applied the plugin',
          lesson: 're-enable the plugin instead of reloading',
        },
      ],
      evidence: FILE_EVIDENCE,
    },
    cwd,
  )
  assert.deepEqual(again.errors, [])
  assert.equal(again.duplicates.length, 1)

  const query = await call(host, 'graph_query', { errors: true }, cwd)
  assert.equal(query.ok, true)
  assert.equal(query.errors.length, 1)
  assert.equal(query.errors[0].subject, 'reload')

  const text = await recallOf(host, cwd)
  // The log is an index now: the block says it exists, and the query reads it.
  assert.match(text, /Prediction errors: 1 recorded \(graph_query errors=true\)\./)
  assert.doesNotMatch(text, /expected the page shows the new card/)
})

test('a scope or estimate miss alone is a calibration record, not a check', async () => {
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
          kind: 'scope',
          subject: 'the extent',
          predicted: 'one file changes',
          observed: 'five files changed',
        },
      ],
      evidence: FILE_EVIDENCE,
    },
    cwd,
  )

  const text = await recallOf(host, cwd)
  // The kind says what went wrong; it does not decide that the objective is in doubt.
  assert.match(text, /Prediction errors: 1 recorded/)
  assert.doesNotMatch(text, /\[scope\/worse\] the extent/)
  assert.doesNotMatch(text, /Before continuing:/)
})

test('an error that puts the objective in question asks once, and carries its reason', async () => {
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
          subject: 'offline search',
          predicted: 'the index requires a network request',
          observed: 'the index also works offline',
          revisit: 'objective',
        },
      ],
      evidence: FILE_EVIDENCE,
    },
    cwd,
  )

  const first = await recallOf(host, cwd)
  assert.match(first, /Before continuing: does the work in hand still serve the objective\?/)
  assert.match(first, /a recorded prediction error puts the objective in question:/)
  assert.match(
    first,
    /- \[belief\/worse\] offline search \(repo; revisit: objective\): expected the index requires a network request — actually the index also works offline/,
  )
  assert.match(first, /this is a check, not a gate/)
  // The log itself is not printed; the reason still carries the record.
  assert.match(first, /Prediction errors: 1 recorded/)

  const query = await call(host, 'graph_query', { errors: true }, cwd)
  assert.equal(query.errors[0].revisit, 'objective')

  // The check belongs to the turn that has to decide, not to every assembly.
  const second = await recallOf(host, cwd)
  assert.doesNotMatch(second, /Before continuing:/)
})

test('acceptance and priority impacts fire too, and the reason lists both', async () => {
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
          subject: 'the export is missing',
          predicted: 'the build passes the acceptance check',
          observed: 'the acceptance check cannot pass without the export',
          revisit: 'acceptance',
        },
        {
          kind: 'estimate',
          subject: 'the next step',
          predicted: 'the query work is the priority',
          observed: 'the projection work is the priority',
          revisit: 'priority',
        },
      ],
      evidence: FILE_EVIDENCE,
    },
    cwd,
  )

  const text = await recallOf(host, cwd)
  assert.match(text, /recorded prediction errors put the acceptance items and the priorities in question:/)
  assert.match(text, /- \[outcome\/worse\] the export is missing/)
  assert.match(text, /- \[estimate\/worse\] the next step/)
})

test('the check is once per session: another session is still asked', async () => {
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
          subject: 'reload',
          predicted: 'the page updates',
          observed: 'the host had not re-applied',
          revisit: 'objective',
        },
      ],
      evidence: FILE_EVIDENCE,
    },
    cwd,
  )

  assert.match(await recallOf(host, cwd, 'session-one'), /Before continuing:/)
  assert.match(await recallOf(host, cwd, 'session-two'), /Before continuing:/)
  // Each session is asked once, not once per workspace.
  assert.doesNotMatch(await recallOf(host, cwd, 'session-two'), /Before continuing:/)
})

test('a restart does not ask the same session again, but a new session is asked', async () => {
  const first = fakeHost()
  apply(first.ctx)
  const cwd = workspace()

  await call(
    first,
    'graph_write',
    {
      nodes: [{ id: 'objective', type: 'objective', label: 'Port' }],
      errors: [
        {
          kind: 'belief',
          subject: 'the cache is warm',
          predicted: 'the cache is warm after the reload',
          observed: 'the host had not re-applied the plugin',
          revisit: 'objective',
        },
      ],
      evidence: FILE_EVIDENCE,
    },
    cwd,
  )
  assert.match(await recallOf(first, cwd, 'session-persisted'), /Before continuing:/)

  // A new process (and service) on the same workspace: the receipt survives.
  const second = fakeHost()
  apply(second.ctx)
  assert.doesNotMatch(await recallOf(second, cwd, 'session-persisted'), /Before continuing:/)
  // A session that has not seen it is still asked.
  assert.match(await recallOf(second, cwd, 'session-new'), /Before continuing:/)
})

test('the reason is shown even though the block no longer lists the errors', async () => {
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
          subject: 'the old assumption',
          predicted: 'the old assumption still holds',
          observed: 'it does not hold',
          revisit: 'objective',
        },
        { kind: 'estimate', subject: 'one', predicted: 'a', observed: 'b' },
        { kind: 'estimate', subject: 'two', predicted: 'a', observed: 'b' },
        { kind: 'estimate', subject: 'three', predicted: 'a', observed: 'b' },
      ],
      evidence: FILE_EVIDENCE,
    },
    cwd,
  )

  const text = await recallOf(host, cwd)
  const [before, after] = text.split('Before continuing:')
  // The log is an index; no error line is printed before the check.
  assert.doesNotMatch(before, /the old assumption/)
  assert.match(after, /- \[belief\/worse\] the old assumption \(repo; revisit: objective\)/)
})

test('a revisit that is not a known target is refused', async () => {
  const host = fakeHost()
  apply(host.ctx)
  const cwd = workspace()

  await assert.rejects(
    call(
      host,
      'graph_write',
      {
        errors: [
          {
            kind: 'belief',
            subject: 'x',
            predicted: 'a',
            observed: 'b',
            revisit: 'the-whole-thing',
          },
        ],
        evidence: FILE_EVIDENCE,
      },
      cwd,
    ),
    /revisit must be one of objective, acceptance, priority/,
  )
})

test('recallLimit bounds the decisions, not the facts frame', async () => {
  const host = fakeHost()
  apply(host.ctx, { recallLimit: 2 })
  const cwd = workspace()

  await call(
    host,
    'graph_write',
    {
      nodes: [
        { id: 'objective', type: 'objective', label: 'Port' },
        ...Array.from({ length: 3 }, (_, index) => ({
          id: `decision/d${index}`,
          type: 'decision',
          label: `decision ${index}`,
          value: `value ${index}`,
        })),
      ],
      evidence: FILE_EVIDENCE,
    },
    cwd,
  )

  const text = await recallOf(host, cwd)
  assert.match(text, /Objective: Port/)
  // recallLimit bounds the settled frame; the tree has its own budget.
  const decisions = text
    .split('Decisions:\n')[1]
    ?.split('\n  (+')[0]
    ?.split('\n')
    .filter((line) => line.startsWith('- ')) ?? []
  assert.equal(decisions.length, 2)
  assert.match(text, /\(\+1 more; graph_query with node_type=decision\)/)
})

test('a fact is shown only when a node edge links it to the current path', async () => {
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
        { id: 'task/current', type: 'task', label: 'Build the graph' },
        { id: 'fact/linked', type: 'fact', label: 'linked fact', value: 'the graph is append-only' },
        { id: 'fact/unlinked', type: 'fact', label: 'unlinked fact', value: 'an unrelated detail' },
      ],
      edges: [
        { from: 'component/graph', type: 'serves', to: 'objective' },
        { from: 'task/current', type: 'serves', to: 'component/graph' },
        { from: 'fact/linked', type: 'node', to: 'component/graph' },
      ],
      evidence: FILE_EVIDENCE,
    },
    cwd,
  )

  const text = await recallOf(host, cwd)
  assert.match(text, /Facts:\n- linked fact: the graph is append-only/)
  assert.doesNotMatch(text, /unlinked fact/)
  // The unlinked one is counted, not silently dropped.
  assert.match(text, /\(\+1 more; graph_query with node_type=fact\)/)
})

test('a deep objective tree does not push the constraints and decisions out', async () => {
  const host = fakeHost()
  apply(host.ctx, { contextLimit: 2, recallLimit: 3 })
  const cwd = workspace()

  const components = ['a', 'b', 'c', 'd', 'e']
  await call(
    host,
    'graph_write',
    {
      nodes: [
        { id: 'objective', type: 'objective', label: 'Port' },
        ...components.map((key) => ({ id: `component/${key}`, type: 'component', label: key })),
        { id: 'constraint/x', type: 'constraint', label: 'x', value: 'must hold' },
        { id: 'decision/y', type: 'decision', label: 'y', value: 'chosen' },
      ],
      edges: components.map((key) => ({ from: `component/${key}`, type: 'serves', to: 'objective' })),
      evidence: FILE_EVIDENCE,
    },
    cwd,
  )

  const text = await recallOf(host, cwd)
  // The tree has its own budget (contextLimit), so the facts still appear.
  assert.match(text, /Constraints:/)
  assert.match(text, /- x: must hold/)
  assert.match(text, /Decisions:/)
  assert.match(text, /\(\+3 more nodes not shown; graph_query\)/)
})
