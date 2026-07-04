// electron-builder afterPack hook (see electron-builder.yml): the Electron
// runtime copied from node_modules/electron/dist includes default_app.asar,
// Electron's built-in fallback app. The onlyLoadAppFromAsar fuse already
// prevents it from ever loading; deleting it keeps the shipped artifact to
// exactly what this app needs.
const { rmSync } = require('node:fs')
const { join } = require('node:path')

module.exports = async function afterPack(context) {
  rmSync(join(context.appOutDir, 'resources', 'default_app.asar'), { force: true })
}
