/* eslint-disable unicorn/no-process-exit */

// Native
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import zlib from 'zlib'

// Packages
import onDeath from 'death'
import fetch from 'node-fetch'
import retry from 'async-retry'
import which from 'which-promise'

// Utilities
import plusxSync from './chmod'
import {
  disableProgress,
  enableProgress,
  info,
  showProgress,
  warn
} from './log'

fetch.Promise = Promise
global.Promise = Promise
let { platform } = process
if (detectAlpine()) platform = 'alpine'

const packagePath = path.join(__dirname, '../../package.json')
const packageJSON = JSON.parse(fs.readFileSync(packagePath, 'utf8'))

const now = path.join(__dirname, 'now')
const targetWin32 = path.join(__dirname, 'now.exe')
const target = platform === 'win32' ? targetWin32 : now
const partial = target + '.partial'
const backup = target + '.' + packageJSON.version + '.backup'

const platformToName = {
  alpine: 'now-alpine',
  darwin: 'now-macos',
  linux: 'now-linux',
  win32: 'now-win.exe'
}

function detectAlpine () {
  if (platform !== 'linux') return false
  // https://github.com/sass/node-sass/issues/1589#issuecomment-265292579
  const ldd = spawnSync('ldd', [ process.execPath ]).stdout.toString()
  return /\bmusl\b/.test(ldd)
}

async function download() {
  try {
    fs.writeFileSync(
      now,
      '#!/usr/bin/env node\n' +
        'console.log("Please wait until the \'now\' installation completes!")\n'
    )
  } catch (err) {
    if (err.code === 'EACCES') {
      warn(
        'Please try installing now CLI again with the `--unsafe-perm` option.'
      )
      info('Example: `npm i -g --unsafe-perm now`')

      process.exit()
    }

    throw err
  }

  onDeath(() => {
    fs.writeFileSync(
      now,
      '#!/usr/bin/env node\n' +
        'console.log("The \'now\' installation did not complete successfully.")\n' +
        'console.log("Please run \'npm i -g now\' to reinstall!")\n'
    )
    process.exit()
  })

  info('For the source code, check out: https://github.com/zeit/now-cli')

  // Print an empty line
  console.log('')

  await retry(async () => {
    enableProgress('Downloading now CLI ' + packageJSON.version)
    showProgress(0)

    try {
      const name = platformToName[platform]
      const url = `https://cdn.zeit.co/releases/now/${packageJSON.version}/${name}`
      const resp = await fetch(url, { compress: false })

      if (resp.status !== 200) {
        throw new Error(resp.statusText + ' ' + url)
      }

      const size = resp.headers.get('content-length')

      if (!size) {
        throw new Error('Not found (content-length is absent)')
      }

      const ws = fs.createWriteStream(partial)

      await new Promise((resolve, reject) => {
        let bytesRead = 0

        resp.body
          .on('error', reject)
          .on('data', chunk => {
            bytesRead += chunk.length
            showProgress(100 * bytesRead / size)
          })

        const gunzip = zlib.createGunzip()

        gunzip
          .on('error', reject)

        resp.body.pipe(gunzip).pipe(ws)

        ws
          .on('error', reject)
          .on('close', () => {
            showProgress(100)
            resolve()
          })
      })
    } finally {
      disableProgress()
    }
  }, {
    retries: 500,
    onRetry: (err) => console.error(err)
  })

  fs.renameSync(partial, target)
  fs.writeFileSync(backup, fs.readFileSync(target))
}

async function main() {
  if (fs.existsSync(backup)) {
    fs.writeFileSync(target, fs.readFileSync(backup))
  } else {
    await download()
  }

  if (platform === 'win32') {
    // Now.exe is executed only
    fs.unlinkSync(now)
    try {
      // Workaround for https://github.com/npm/cmd-shim/pull/25
      const globalPath = path.dirname(await which('npm'))
      const gitBashFile = path.join(globalPath, 'now')
      fs.writeFileSync(
        gitBashFile,
        '#!/bin/sh\n' +
          'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\n' +
          '\n' +
          'case `uname` in\n' +
          '    *CYGWIN*) basedir=`cygpath -w "$basedir"`;;\n' +
          'esac\n' +
          '\n' +
          fs.readFileSync(gitBashFile, 'utf8')
      )
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Not a problem. only git cmd will not work
        console.error(err)
      }
    }
  } else {
    plusxSync(now)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(2)
})
