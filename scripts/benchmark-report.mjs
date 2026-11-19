#!/usr/bin/env node
/**
 * Compare a plugin-disabled baseline run with an enabled run.
 *
 * Both sides are DSH session directories (or individual session log files).
 * `--telemetry` additionally reads the `[dsh-orchestration] telemetry` lines
 * from an Agent log to report per-delegation detail.
 *
 * Usage:
 *   node scripts/benchmark-report.mjs --baseline <path> --enabled <path> [--telemetry <log>] [--json]
 *
 * Run `pnpm run build` first: this script imports the
 * compiled benchmark helpers.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { compareBenchmarks, decodeSessionLog, formatBenchmarkReport, scanSessionLogs } from '../lib/benchmark.js'
import { parseTelemetryLines } from '../lib/telemetry.js'

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
  return undefined
}

function parseArgs(argv) {
  const options = { baseline: [], enabled: [], telemetry: [], json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--baseline':
        options.baseline.push(argv[++index])
        break
      case '--enabled':
        options.enabled.push(argv[++index])
        break
      case '--telemetry':
        options.telemetry.push(argv[++index])
        break
      case '--json':
        options.json = true
        break
      case '--help':
      case '-h':
        return undefined
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (options.baseline.length === 0 || options.enabled.length === 0) {
    throw new Error('both --baseline and --enabled are required')
  }
  if (options.baseline.some(path => path === undefined) || options.enabled.some(path => path === undefined)) {
    throw new Error('a path argument is missing')
  }
  return options
}

function sessionFiles(path) {
  if (statSync(path).isFile()) return [path]
  const files = []
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) files.push(...sessionFiles(child))
    else if (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd')) files.push(child)
  }
  return files
}

function readEvents(file) {
  return decodeSessionLog(readFileSync(file))
}

function scan(paths) {
  const sessions = []
  for (const path of paths) {
    for (const file of sessionFiles(path)) sessions.push(readEvents(file))
  }
  return scanSessionLogs(sessions)
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    fail(`${error.message}\n\nUsage: benchmark-report.mjs --baseline <path> --enabled <path> [--telemetry <log>] [--json]`)
    return
  }
  if (options === undefined) {
    process.stdout.write('Usage: benchmark-report.mjs --baseline <path> --enabled <path> [--telemetry <log>] [--json]\n')
    return
  }
  const records = []
  for (const path of options.telemetry) {
    records.push(...parseTelemetryLines(readFileSync(path, 'utf8')))
  }
  const comparison = compareBenchmarks(scan(options.baseline), scan(options.enabled), records)
  if (options.json) {
    process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`)
    return
  }
  process.stdout.write(`${formatBenchmarkReport(comparison)}\n`)
}

main()
