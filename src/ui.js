const React = require('react')
const { Box, Text, useInput } = require('ink')

const path = require('path')
const low = require('lowdb')
const FileSync = require('lowdb/adapters/FileSync')
const adapter = new FileSync(path.join(__dirname, '..', 'data/youtube.json'))
const db = low(adapter)

db.defaults({ videos: [], channels: [] }).write()

const list = db.get('videos').value()

const App = () => {
  const [focus, setFocus] = React.useState(0)
  const [checked, setChecked] = React.useState(new Set())

  useInput((input, key) => {
    if (key.downArrow) {
      setFocus(focus >= list.length - 1 ? 0 : focus + 1)
    }
    if (key.upArrow) {
      setFocus(focus === 0 ? list.length - 1 : focus - 1)
    }
    if (key.space) {
      setFocus(focus === 0 ? list.length - 1 : focus - 1)
    }
    if (input === ' ') {
      const currentId = list[focus]._id
      if (checked.has(currentId)) {
        checked.delete(currentId)
      } else {
        checked.add(currentId)
      }
      setChecked(new Set(checked))
    }
  })

  return (
    <Box width="100%" flexDirection="column">
      {list.map((v, index) => (
        <Box key={v._id}>
          <Box width={4} paddingX={1}>
            <Text>
              {focus === index ? '❯' : ' '}
              {checked.has(v._id) ? '◉' : '◯'}
            </Text>
          </Box>
          <Box width="20%">
            <Text color="green" bold={true} wrap="truncate">
              {v.channel.name}
            </Text>
          </Box>
          <Box width="50%">
            <Text wrap="truncate"> {v.title.value} </Text>
          </Box>
          <Box width={9} justifyContent="flex-end">
            <Text> {v.duration.raw} </Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}

module.exports = App
