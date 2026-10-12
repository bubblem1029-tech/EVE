#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveEngineBin, buildExecEnv } from '../dist/runner/index.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const suiteRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(__dirname, 'runtime');
const defaultBackendRoot = path.resolve(suiteRoot, '..', '..', '..', 'eve-backend');

const inputFile = process.argv[2];
const specGlob = process.argv[3] || 'specs/__probe.spec.ts';
const round = process.argv[4] || 'probe';
const input = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
const taskDir = input.taskDir;
const backendRoot = input.backendRoot || defaultBackendRoot;
const resultDir = path.join(taskDir, 'reports', `round-${round}`);
fs.mkdirSync(resultDir, { recursive: true });

const env = buildExecEnv({
  input, taskDir, round, engine: 'cypress', defaultBackendRoot, suiteRoot,
});
const cypressBin = resolveEngineBin({ engine: 'cypress', backendRoot, suiteRoot });
const configPath = path.join(runtimeDir, 'cypress.config.mjs');
const res = spawnSync(cypressBin, [
  'run', '--project', taskDir, '--config-file', configPath,
  '--browser', 'electron', '--spec', specGlob,
], {
  cwd: taskDir,
  stdio: 'inherit',
  env: { ...env, ELECTRON_RUN_AS_NODE: '' },
});
process.exit(res.status ?? 1);
