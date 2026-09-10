const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs')

const workerPath = path.resolve('src/workers/duckdb.worker.ts')
const sourceText = fs.readFileSync(workerPath, 'utf8')
const source = ts.createSourceFile(workerPath, sourceText, ts.ScriptTarget.Latest, true)
const values = {
  granularity: 'month',
  localTimestamp: "played_at + ((CASE WHEN played_at >= try_cast('2024-03-31T01:00:00.000Z' AS TIMESTAMP) THEN 120 ELSE 60 END) * INTERVAL 1 MINUTE)",
  startDate: "'2024-01-01'",
  endDate: "'2024-12-31'",
  minMs: '30000',
  metricOrder: 'plays',
  aggregateOrder: 'count(*)',
}

let insightsFunction
function findFunction(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'queryInsights') insightsFunction = node
  ts.forEachChild(node, findFunction)
}
findFunction(source)

const queries = []
function templateText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (!ts.isTemplateExpression(node)) throw new Error(`Unsupported query node: ${node.getText(source)}`)
  let result = node.head.text
  for (const span of node.templateSpans) {
    const key = span.expression.getText(source)
    if (!(key in values)) throw new Error(`Missing template value: ${key}`)
    result += values[key] + span.literal.text
  }
  return result
}
function findQueries(node) {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === 'query' && node.arguments.length) {
    queries.push(templateText(node.arguments[0]))
  }
  ts.forEachChild(node, findQueries)
}
findQueries(insightsFunction)

function validateTimezoneTransitions(expect) {
  const source = fs.readFileSync(path.resolve('src/services/timezone.ts'), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const timezoneModule = { exports: {} }
  new Function('require', 'module', 'exports', compiled)(require, timezoneModule, timezoneModule.exports)
  const originalTimezone = process.env.TZ
  process.env.TZ = 'Europe/Amsterdam'
  const result = timezoneModule.exports.browserTimezone('2024-01-01', '2024-12-31')
  if (originalTimezone == null) delete process.env.TZ
  else process.env.TZ = originalTimezone

  expect(result.timezone === 'Europe/Amsterdam', 'browser IANA timezone')
  expect(result.timezoneTransitions.some((item) => item.startsAt === '2024-03-31T01:00:00.000Z' && item.offsetMinutes === 120), 'spring DST transition')
  expect(result.timezoneTransitions.some((item) => item.startsAt === '2024-10-27T01:00:00.000Z' && item.offsetMinutes === 60), 'autumn DST transition')
}

async function main() {
  const expect = (condition, message) => {
    if (!condition) throw new Error(`Analytics assertion failed: ${message}`)
  }
  validateTimezoneTransitions(expect)
  const dist = path.dirname(require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs'))
  const bundles = { mvp: { mainModule: path.join(dist, 'duckdb-mvp.wasm'), mainWorker: path.join(dist, 'duckdb-node-mvp.worker.cjs') } }
  const db = await duckdb.createDuckDB(bundles, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME)
  await db.instantiate(() => {})
  db.open({})
  const conn = db.connect()
  conn.query(`
    CREATE TABLE listening_history (
      played_at TIMESTAMP, track_name VARCHAR, artist_name VARCHAR, album_name VARCHAR,
      spotify_track_uri VARCHAR, ms_played BIGINT, skipped BOOLEAN, shuffle BOOLEAN,
      platform VARCHAR, offline BOOLEAN, reason_start VARCHAR, reason_end VARCHAR,
      is_first_play BOOLEAN
    );
    INSERT INTO listening_history VALUES
      ('2023-12-20 10:00:00', 'Alpha', 'Artist A', 'Album A', 'spotify:track:a', 180000, false, false, 'web', false, 'clickrow', 'trackdone', true),
      ('2024-01-01 10:00:00', 'Alpha', 'Artist A', 'Album A', 'spotify:track:a', 175000, false, true, 'web', false, 'trackdone', 'trackdone', false),
      ('2024-01-01 10:04:00', 'Beta', 'Artist A', 'Album A', 'spotify:track:b', 8000, true, true, 'web', false, 'trackdone', 'fwdbtn', true),
      ('2024-01-01 10:08:00', 'Gamma', 'Artist B', 'Album B', 'spotify:track:c', 210000, false, false, 'phone', true, 'clickrow', 'trackdone', true),
      ('2024-03-10 19:00:00', 'Beta', 'Artist A', 'Album A', 'spotify:track:b', 190000, false, false, 'phone', false, 'clickrow', 'endplay', false),
      ('2024-08-10 19:00:00', 'Alpha', 'Artist A', 'Album A', 'spotify:track:a', 180000, false, false, 'phone', false, 'clickrow', 'trackdone', false);
  `)
  const timezoneCheck = conn.query(`
    WITH checks(label, played_at) AS (VALUES
      ('winter', TIMESTAMP '2024-01-01 12:00:00'),
      ('summer', TIMESTAMP '2024-07-01 12:00:00'),
      ('midnight', TIMESTAMP '2024-01-01 23:30:00')
    ), localized AS (
      SELECT
        label,
        played_at + ((CASE WHEN played_at >= TIMESTAMP '2024-03-31 01:00:00' THEN 120 ELSE 60 END) * INTERVAL 1 MINUTE) AS local_at
      FROM checks
    )
    SELECT label, extract(hour FROM local_at)::INTEGER AS hour, strftime(local_at, '%Y-%m-%d') AS date
    FROM localized ORDER BY label;
  `).toArray()
  const results = []
  for (let index = 0; index < queries.length; index += 1) {
    try {
      results.push(conn.query(queries[index]).toArray())
    } catch (error) {
      console.error(`Query ${index + 1} failed:\n${queries[index]}\n`)
      throw error
    }
  }
  const timezoneRows = Object.fromEntries(timezoneCheck.map((row) => [String(row.label), row]))
  expect(Number(timezoneRows.winter.hour) === 13, 'winter timezone offset')
  expect(Number(timezoneRows.summer.hour) === 14, 'summer daylight-saving offset')
  expect(String(timezoneRows.midnight.date) === '2024-01-02', 'local midnight date rollover')
  expect(Number(results[1][0].total_plays) === 4, 'qualified play total')
  expect(Number(results[3][0].total_streams) === 5, 'all-stream total')
  const behavior = results[7].reduce((total, row) => ({
    natural: total.natural + Number(row.natural_ends),
    early: total.early + Number(row.early_exits),
    other: total.other + Number(row.other_ends),
  }), { natural: 0, early: 0, other: 0 })
  expect(behavior.natural === 3 && behavior.early === 1 && behavior.other === 1, 'stream ending categories')
  expect(Number(results[10][0].sessions) === 3, '30-minute session boundaries')
  expect(Number(results[12][0].discoveries) === 2 && Number(results[12][0].one_and_done) === 1, 'discovery retention')
  expect(results[13].length === 1 && Number(results[13][0].gap_days) >= 200, 'long-gap rediscovery')
  expect(results[14].length === 2, 'album aggregation')
  console.log(`Validated ${queries.length} query calls and core analytics results.`)
  conn.close()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
