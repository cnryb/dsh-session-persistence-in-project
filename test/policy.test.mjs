/**
 * 策略层测试：不依赖 harness，`node --test test/` 直接可跑。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_PROJECT_ROOT,
  LOCATION_DEFAULT,
  LOCATION_PROJECT,
  parseSwitchYaml,
  readSwitch,
  resolveLocation,
} from '../src/policy.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const DEFAULT_ROOT = '/tmp/dsh-default-root'
const noEnv = {}

test('没有开关文件时落在默认根', () => {
  const result = resolveLocation(join(fixtures, 'plain'), { defaultRoot: DEFAULT_ROOT, env: noEnv })
  assert.equal(result.location, LOCATION_DEFAULT)
  assert.equal(result.root, resolve(DEFAULT_ROOT))
  assert.equal(result.reason, 'no-switch-file')
  assert.equal(result.switchFile, null)
})

test('开关文件存在即视为开启，落点进项目', () => {
  const project = join(fixtures, 'enabled')
  const result = resolveLocation(project, { defaultRoot: DEFAULT_ROOT, env: noEnv })
  assert.equal(result.location, LOCATION_PROJECT)
  assert.equal(result.root, resolve(project, DEFAULT_PROJECT_ROOT))
  assert.equal(result.reason, 'switch-present')
})

test('sessions: default 显式否决项目内落点', () => {
  const result = resolveLocation(join(fixtures, 'explicit-off'), { defaultRoot: DEFAULT_ROOT, env: noEnv })
  assert.equal(result.location, LOCATION_DEFAULT)
  assert.equal(result.root, resolve(DEFAULT_ROOT))
  assert.equal(result.reason, 'switch-says-default')
})

test('project.json 同样生效，且 sessionsRoot 按项目根解析', () => {
  const project = join(fixtures, 'json-switch')
  const result = resolveLocation(project, { defaultRoot: DEFAULT_ROOT, env: noEnv })
  assert.equal(result.location, LOCATION_PROJECT)
  assert.equal(result.root, resolve(project, 'var/session-logs'))
})

test('环境变量覆盖开关文件', () => {
  const project = join(fixtures, 'enabled')
  const forced = resolveLocation(project, { defaultRoot: DEFAULT_ROOT, env: { DSH_SESSION_LOCATION: 'default' } })
  assert.equal(forced.location, LOCATION_DEFAULT)
  assert.equal(forced.reason, 'env-override')
})

test('取值非法时退回默认落点，绝不悄悄换地方存', () => {
  const project = mkdtempSync(join(tmpdir(), 'dsh-sip-'))
  mkdirSync(join(project, '.dsh'), { recursive: true })
  writeFileSync(join(project, '.dsh', 'project.yml'), 'sessions: yes-please\n')
  const result = resolveLocation(project, { defaultRoot: DEFAULT_ROOT, env: noEnv })
  assert.equal(result.location, LOCATION_DEFAULT)
  assert.equal(result.reason, 'invalid-switch-value')
  assert.equal(result.invalidValue, 'yes-please')
})

test('开关文件解析失败时退回默认落点', () => {
  const project = mkdtempSync(join(tmpdir(), 'dsh-sip-'))
  mkdirSync(join(project, '.dsh'), { recursive: true })
  writeFileSync(join(project, '.dsh', 'project.json'), '{ 这不是 JSON')
  const result = resolveLocation(project, { defaultRoot: DEFAULT_ROOT, env: noEnv })
  assert.equal(result.location, LOCATION_DEFAULT)
  assert.equal(result.reason, 'unparsable-switch-file')
})

test('YAML 子集：注释、空行、引号、布尔', () => {
  const values = parseSwitchYaml([
    '# 注释',
    '',
    'sessions: "project"',
    "sessionsRoot: '.dsh/logs'",
    'log: true',
    'debug: false',
  ].join('\n'))
  assert.deepEqual(values, {
    sessions: 'project',
    sessionsRoot: '.dsh/logs',
    log: true,
    debug: false,
  })
})

test('readSwitch 对不存在的项目返回 null', () => {
  assert.equal(readSwitch(join(fixtures, 'plain')), null)
})
