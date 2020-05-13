#!/usr/bin/env node

/* eslint no-console: off */

const path = require('path')
const parseArgs = require('minimist')
const debug = require('debug')('ytwl')
const low = require('lowdb')
const FileSync = require('lowdb/adapters/FileSync')
const adapter = new FileSync(path.join(__dirname, '..', 'data/youtube.json'))
const db = low(adapter)
const fetchWatchList = require('./youtubeWatchListConnector')
const _ = require('lodash')
const open = require('open')
const formatDistance = require('date-fns/formatDistanceStrict')
const chalk = require('chalk')
const is = require('@sindresorhus/is')

const argv = parseArgs(process.argv.slice(2), {
  boolean: ['reset', 'views', 'indice'],
})
debug('argv: %O', argv)
const [command] = argv._
debug('command: %s', command)

db.defaults({ videos: [], channels: [] }).write()

const commands = {
  sync: async ({ reset }) => {
    const list = await fetchWatchList()
    debug('result: %O', list)
    if (reset) {
      db.set(
        'videos',
        list.map((v) => ({ ...v, metadata: { importDate: new Date() } }))
      ).write()
    } else {
      const existingIds = db.get('videos').map('_id').value()
      const fetchedIndex = _(list).keyBy('_id').value()

      const toRemoveIds = _.difference(existingIds, Object.keys(fetchedIndex))
      db.get('videos')
        .remove((vid) => toRemoveIds.includes(vid._id))
        .write()
      console.log(`${chalk.red(toRemoveIds.length)} videos removed`)

      const toAddIds = _.difference(Object.keys(fetchedIndex), existingIds)
      let videos = db.get('videos')
      for (const id of toAddIds) {
        videos.push({ ...fetchedIndex[id], importDate: new Date() }).write()
      }
      console.log(`${chalk.green(toAddIds.length)} videos added`)

      videos = db.get('videos')
      const toUpdateIds = _.intersection(existingIds, Object.keys(fetchedIndex))
      let upCount = 0
      for (const id of toUpdateIds) {
        const dbVid = videos.find({ _id: id }).value()
        if (
          JSON.stringify(_.omit(dbVid, ['metadata', 'publicationDate'])) !==
          JSON.stringify(
            _.omit(fetchedIndex[id], ['metadata', 'publicationDate'])
          )
        ) {
          upCount++
        }
        fetchedIndex[id].metadata = {
          importDate: dbVid.metadata.importDate,
          updateDate: new Date(),
        }
        videos.find({ _id: id }).assign(fetchedIndex[id]).write()
      }
      console.log(`${chalk.yellow(upCount)} videos updated`)

      videos = db.get('videos')
      console.log(
        `
${chalk.bold(videos.size())} videos to view with a total of ${chalk.bold(
          new Intl.NumberFormat().format(videos.map('views').sum().value())
        )} views and ${chalk.bold(
          formatDistance(
            new Date(),
            new Date(
              Date.now() + videos.map('duration.value').sum().value() * 1000
            ),
            { unit: 'hour' }
          )
        )} of viewing time`
      )

      const channels = db.get('videos').groupBy('channel._id').value()
      db.set('channels', []).write()
      for (const channelId in channels) {
        db.get('channels')
          .push({
            _id: channelId,
            name: _.get(channels[channelId], '[0].channel.name'),
            count: channels[channelId].length,
          })
          .write()
      }
    }
  },
  open: () => {
    const [, _id] = argv._
    const vid = db.get('videos').find({ _id }).value()
    if (!vid)
      throw new Error(`Could not find video with id ${_id}. Need a sync ?`)

    const url = `https://www.youtube.com/watch?v=${_id}&list=WL&t=${vid.progress.value}s`
    open(url)
  },
  vids: ({ views, indice }) => {
    let order = ['duration.value']
    let direction = ['asc']
    let filter = (v) => v

    if (views) {
      order = ['views']
      direction = ['desc']
      filter = (v) => is.number(v.views)
    }

    if (indice) {
      order = ['indice']
      direction = ['desc']
      filter = (v) => is.number(v.views)
    }
    db.get('videos')
      .filter(filter)
      .map((v) => ({ ...v, indice: Math.round(v.views / v.duration.value) }))
      .orderBy(order, direction)
      .slice(0, 10)
      .value()
      .forEach((v) => {
        console.log(
          `${v._id} ${chalk.bold(v.duration.raw.padStart(7, ' '))}: ${
            v.title.value
          } (${chalk.bold(
            new Intl.NumberFormat().format(v.views)
          )} views) ${chalk.blue(v.indice)} v/s`
        )
      })
  },
  channels: () => {
    const channels = db
      .get('channels')
      .orderBy(['count'], ['desc'])
      .filter((c) => c.count > 0)

    channels
      .slice(0, 10)
      .value()
      .forEach((channel) => {
        console.log(
          `${String(channel.count).padStart(3, ' ')}: ${channel.name}`
        )
      })

    console.log(
      `... and ${channels
        .slice(10)
        .size()} other channels with a total of ${channels
        .slice(10)
        .map('count')
        .sum()
        .value()} more videos`
    )
  },
}

if (commands[command]) commands[command](argv)
