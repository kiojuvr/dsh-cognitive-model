/**
 * In-process test runner for environments that cannot spawn child processes
 * (the DSH sandbox denies the `node --test` child spawn). Importing the files
 * registers their `node:test` cases in this process.
 *
 * It lives outside `test/` on purpose: `node --test` discovers every `.mjs`
 * under `test/`, so a runner kept there made the suite run twice.
 */
import '../test/projection.test.mjs'
import '../test/query.test.mjs'
import '../test/snapshot.test.mjs'
import '../test/recall.test.mjs'
import '../test/peg.test.mjs'
import '../test/plugin.test.mjs'
