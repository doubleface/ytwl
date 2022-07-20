const React = require('react')
const importJsx = require('import-jsx')
const { render } = require('ink')

const conf = require('parse-strings-in-object')(
  require('rc')('ytwl', {
    indice: {
      importDateLimit: 7,
      importDateWeight: 50,
    },
  })
)

const path = require('path')
const low = require('lowdb')
const FileSync = require('lowdb/adapters/FileSync')
const adapter = new FileSync(path.join(__dirname, '..', 'data/youtube.json'))
const db = low(adapter)

const ui = importJsx('./ui')

render(React.createElement(ui))
