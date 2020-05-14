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
  boolean: ['reset', 'views', 'indice', 'short', 'long'],
})
debug('argv: %O', argv)
const [command] = argv._
debug('command: %s', command)

db.defaults({ videos: [], channels: [] }).write()

const commands = {
  summary: async () => {
    showSummary(db.get('videos'))
  },
  sync: async ({ reset }) => {
    showSummary(db.get('videos'))
    const list = await fetchWatchList()
    debug('result: %O', list)
    if (reset) {
      db.set('videos', list.map(formatCreateVid)).write()
    } else {
      const existingIds = db.get('videos').map('_id').value()
      const fetchedIndexedById = _(list).keyBy('_id').value()

      const removeCount = removeReadVids(existingIds, fetchedIndexedById)
      console.log(`${chalk.red(removeCount)} videos removed`)

      const addCount = addNewVids(existingIds, fetchedIndexedById)
      console.log(`${chalk.green(addCount)} videos added`)

      const upCount = updateVidsData(existingIds, fetchedIndexedById)
      console.log(`${chalk.yellow(upCount)} videos updated`)

      showSummary(db.get('videos'))

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
  vids: ({ views, indice, short, long }) => {
    let order = ['duration.value']
    let direction = ['asc']
    let orderFilter = (v) => v
    let durationFilter = (v) => v

    if (views) {
      order = ['views']
      direction = ['desc']
      orderFilter = (v) => is.number(v.views)
    }

    if (indice) {
      order = ['indice']
      direction = ['desc']
      orderFilter = (v) => is.number(v.views)
    }

    if (short) {
      durationFilter = (v) => v.duration.value <= 600
    }

    if (long) {
      durationFilter = (v) => v.duration.value >= 3600
    }
    db.get('videos')
      .filter(orderFilter)
      .filter(durationFilter)
      .map((v) => ({ ...v, indice: getIndice(v) }))
      .orderBy(order, direction)
      .slice(0, 10)
      .value()
      .forEach((v) => {
        console.log(
          `${v._id} ${chalk.bold(v.duration.raw.padStart(7, ' '))}: ${
            v.title.value
          } (${chalk.bold(
            new Intl.NumberFormat().format(v.views)
          )} views) ${chalk.blue(v.indice)} v/s${
            v._deleted ? chalk.red(' DELETED') : ''
          }`
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

function formatCreateVid(v) {
  return { ...v, metadata: { importDate: new Date() } }
}

function removeReadVids(existingIds, fetchedIndexedById) {
  const toRemoveIds = _.difference(existingIds, Object.keys(fetchedIndexedById))
  db.get('videos')
    .remove((v) => toRemoveIds.includes(v._id))
    .write()
  return toRemoveIds.length
}

function addNewVids(existingIds, fetchedIndexedById) {
  const toAddIds = _.difference(Object.keys(fetchedIndexedById), existingIds)
  const videos = db.get('videos')
  for (const id of toAddIds) {
    videos.push(formatCreateVid(fetchedIndexedById[id])).write()
  }
  return toAddIds.length
}

function updateVidsData(existingIds, fetchedIndexedById) {
  const videos = db.get('videos')
  const toUpdateIds = _.intersection(
    existingIds,
    Object.keys(fetchedIndexedById)
  )
  let upCount = 0
  for (const id of toUpdateIds) {
    const dbVid = videos.find({ _id: id }).value()
    if (findUpdatedData(dbVid, fetchedIndexedById[id])) {
      upCount++
    }
    fetchedIndexedById[id].metadata = {
      importDate: dbVid.metadata.importDate,
      updateDate: new Date(),
    }
    videos.find({ _id: id }).assign(fetchedIndexedById[id]).write()
  }
  return upCount
}
function findUpdatedData(oldVid, newVid) {
  const blackListAttributes = ['metadata', 'publicationDate']
  return (
    JSON.stringify(_.omit(oldVid, blackListAttributes)) !==
    JSON.stringify(_.omit(newVid, blackListAttributes))
  )
}

function getSummary(videos) {
  return {
    count: videos.size(),
    nbViews: new Intl.NumberFormat().format(videos.map('views').sum().value()),
    totalTime: formatDistance(
      new Date(),
      new Date(Date.now() + videos.map('duration.value').sum().value() * 1000),
      { unit: 'hour' }
    ),
    totalIndice: videos.map(getIndice).sum().value(),
  }
}

function showSummary(videos) {
  const summary = getSummary(videos)
  console.log(
    `
${chalk.bold(summary.count)} videos to view with a total of ${chalk.bold(
      summary.nbViews
    )} views and ${chalk.bold(
      summary.totalTime
    )} of viewing time and ${chalk.blue(summary.totalIndice)} total indice`
  )
}

function getIndice(v) {
  if (!_.get(v, 'duration.value')) return 0
  const result = Math.round(_.get(v, 'views', 0) / _.get(v, 'duration.value'))
  return result
}

if (commands[command]) commands[command](argv)
