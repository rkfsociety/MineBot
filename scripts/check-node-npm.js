#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

const execPath = process.execPath
const nodeDir = path.dirname(execPath)
const npmCli = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')

console.log(JSON.stringify({ execPath, nodeDir, npmCli, npmCliExists: fs.existsSync(npmCli) }, null, 2))

