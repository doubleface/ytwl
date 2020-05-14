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
const dateFns = require('date-fns')
const chalk = require('chalk')
const is = require('@sindresorhus/is')
const inquirer = require('inquirer')

const argv = parseArgs(process.argv.slice(2), {
  boolean: ['reset', 'views', 'short', 'long', 'today', 'subWeek', 'duration'],
  string: ['since'],
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
    openInBrowser(_id)
  },
  vids: async ({ views, duration, short, long, since, today, subWeek }) => {
    let order = ['indice']
    let direction = ['desc']
    let orderFilter = (v) => is.number(v.views)
    let durationFilter = (v) => v
    let dateFilter = (v) => v

    if (views) {
      order = ['views']
      direction = ['desc']
      orderFilter = (v) => is.number(v.views)
    }

    if (duration) {
      order = ['duration.value']
      direction = ['asc']
      orderFilter = (v) => v
    }

    if (short) {
      durationFilter = (v) => v.duration.value <= 600
    }

    if (long) {
      durationFilter = (v) => v.duration.value >= 3600
    }

    if (since) {
      const date = new Date(since)
      dateFilter = (v) => new Date(v.publicationDate) > date
    }

    if (today) {
      dateFilter = (v) => dateFns.isToday(new Date(v.publicationDate))
    }

    if (subWeek) {
      const date = dateFns.subDays(new Date(), 7)
      dateFilter = (v) => new Date(v.publicationDate) > date
    }

    const list = db
      .get('videos')
      .filter(dateFilter)
      .filter(orderFilter)
      .filter(durationFilter)
      .map((v) => ({ ...v, indice: getIndice(v) }))
      .orderBy(order, direction)

    var ui = new inquirer.ui.BottomBar()
    ui.log.write(showSummary(list, true))
    const { toOpen } = await inquirer.prompt([
      {
        type: 'list',
        name: 'toOpen',
        choices: list
          .map((v) => ({
            name: getVideoTextToDisplay(v),
            value: v._id,
          }))
          .value(),
      },
    ])

    openInBrowser(toOpen)
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
    totalTime: dateFns.formatDistanceStrict(
      new Date(),
      new Date(Date.now() + videos.map('duration.value').sum().value() * 1000),
      { unit: 'hour' }
    ),
    totalIndice: videos.map(getIndice).sum().value(),
  }
}

function showSummary(videos, getTextOnly = false) {
  const summary = getSummary(videos)
  const finalText = `${chalk.bold(
    summary.count
  )} videos to view with a total of ${chalk.bold(
    summary.nbViews
  )} views and ${chalk.bold(
    summary.totalTime
  )} of viewing time and ${chalk.blue(summary.totalIndice)} total indice`
  if (getTextOnly) {
    return finalText
  }
  console.log(`
${finalText}
      `)
}

function getIndice(v) {
  if (!_.get(v, 'duration.value')) return 0
  const result = Math.round(_.get(v, 'views', 0) / _.get(v, 'duration.value'))
  return result
}

function openInBrowser(_id) {
  const vid = db.get('videos').find({ _id }).value()
  if (!vid)
    throw new Error(`Could not find video with id ${_id}. Need a sync ?`)

  const url = `https://www.youtube.com/watch?v=${_id}&list=WL&t=${vid.progress.value}s`
  open(url)
}

function getVideoTextToDisplay(v, mainField = 'indice') {
  const channel = chalk.bold.green(
    fixSize(_.get(v, 'channel.name', 'no channel name'), 20)
  )
  const title = fixSize(_.get(v, 'title.value', 'no title'), 50)
  const duration = fixSize(_.get(v, 'duration.raw', 'no duration'), 7)
  const views = fixSize(new Intl.NumberFormat().format(v.views) + ' views', 15)
  const publicationDate = fixSize(
    dateFns.formatDistanceToNow(new Date(v.publicationDate), {
      addSuffix: true,
    }),
    20
  )
  const indice = fixSize(v.indice + ' v/s', 7)
  const _deleted = v._deleted ? chalk.red(' DELETED') : ''

  let result = `${channel} ${title}: `
  const fields = { duration, views, indice, publicationDate, _deleted }

  result += chalk.bold(fields[mainField]) + ','

  result += Object.values(_.omit(fields, mainField)).join(', ')

  return result
}

function fixSize(text, size) {
  return text.slice(0, size).padStart(size, ' ')
}

if (commands[command]) commands[command](argv)
