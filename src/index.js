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
const inquirer = require('inquirer')
inquirer.registerPrompt('datetime', require('inquirer-datepicker-prompt'))
inquirer.registerPrompt(
  'checkbox-plus',
  require('inquirer-checkbox-plus-prompt')
)

const argv = parseArgs(process.argv.slice(2), {
  boolean: ['reset', 'short', 'long', 'sync', 'deleted'],
  string: ['since', 'sort'],
})
debug('argv: %O', argv)
const [command] = argv._
debug('command: %s', command)

db.defaults({ videos: [], channels: [] }).write()

class Commands {
  async sync({ reset } = {}) {
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

      updateChannelsData()
    }
  }

  async list({ sort, short, long, since, sync, deleted }) {
    if (sync) {
      await this.sync()
    }

    let order = ['indice']
    let direction = ['desc']

    if (sort === '') {
      const sortCriterias = [
        { name: 'indice', value: ['indice', 'desc'] },
        { name: 'duration', value: ['duration.value', 'asc'] },
        { name: 'views', value: ['views', 'desc'] },
        { name: 'progress', value: ['progress.value', 'desc'] },
        { name: 'publicationDate', value: ['publicationDate', 'asc'] },
        { name: 'importDate', value: ['importDate', 'desc'] },
      ]

      const { sortOrder } = await inquirer.prompt({
        type: 'list',
        name: 'sortOrder',
        choices: sortCriterias,
      })

      order = [sortOrder[0]]
      direction = [sortOrder[1]]
    }

    let durationFilter = (v) => v
    let dateFilter = (v) => v
    let deletedFilter = (v) => v

    if (short) {
      durationFilter = (v) => v.duration.value <= 600
    }

    if (long) {
      durationFilter = (v) => v.duration.value >= 3600
    }

    if (deleted) {
      deletedFilter = (v) => v._deleted
    }

    if (since !== undefined) {
      let sinceResult
      if (since === '') {
        sinceResult = (
          await inquirer.prompt({
            type: 'datetime',
            name: 'since',
            message: 'Please choose a date filter from now',
            format: ['dd', '/', 'mm', '/', 'yyyy'],
            initial: dateFns.startOfToday(),
          })
        ).since
      } else {
        sinceResult = new Date(since)
      }
      dateFilter = (v) => new Date(v.publicationDate) > sinceResult
    }

    const list = db
      .get('videos')
      .filter(dateFilter)
      .filter(durationFilter)
      .filter(deletedFilter)
      .map((v) => ({ ...v, indice: getIndice(v) }))
      .orderBy(order, direction)

    var ui = new inquirer.ui.BottomBar()
    ui.log.write(showSummary(list, true))
    const { toOpen } = await inquirer.prompt({
      type: 'checkbox-plus',
      name: 'toOpen',
      message: 'Choose a video to open',
      pageSize: 10,
      searchable: true,
      validate: (list) => {
        if (list.length >= 1) return true
        return 'Please select at least one item'
      },
      source: async (sofar, input) => {
        return list
          .filter((v) =>
            `${_.get(v, 'channel.name')} ${_.get(v, 'title.value')}`
              .toLowerCase()
              .includes(input.toLowerCase())
          )
          .map((v) => ({
            name: getVideoTextToDisplay(v),
            value: v._id,
          }))
          .value()
      },
    })

    openInBrowser(toOpen)
  }
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
  if (!_.get(v, 'duration.value') || !_.get(v, 'views')) return 0
  const result = Math.round(_.get(v, 'views', 0) / _.get(v, 'duration.value'))
  return result
}

function openInBrowser(ids) {
  if (ids.length === 1) {
    const [_id] = ids
    const vid = db.get('videos').find({ _id }).value()
    if (!vid)
      throw new Error(`Could not find video with id ${_id}. Need a sync ?`)

    const url = `https://www.youtube.com/watch?v=${_id}&list=WL&t=${vid.progress.value}s`
    open(url)
  } else {
    const url = `http://www.youtube.com/watch_videos?video_ids=` + ids.join(',')
    open(url)
  }
}

function getVideoTextToDisplay(v, mainField = 'indice') {
  const channel = chalk.bold.green(
    fixSize(_.get(v, 'channel.name', 'no channel name'), 20)
  )
  const title = fixSize(_.get(v, 'title.value', 'no title'), 50)
  const duration = fixSize(_.get(v, 'duration.raw', 'no duration'), 7)
  const views = fixSize(
    v.views ? new Intl.NumberFormat().format(v.views) + ' views' : 'N/A',
    15
  )
  const publicationDate = fixSize(
    dateFns.formatDistanceToNow(
      new Date(_.get(v, 'publicationDate', Date.now())),
      {
        addSuffix: true,
      }
    ),
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

function updateChannelsData() {
  const channelsIndex = db.get('videos').groupBy('channel._id').value()
  const channels = db.get('channels')
  let newChannelsCount = 0
  let channelsUpdatedCount = 0
  for (const channelId in channelsIndex) {
    const dbChannel = channels.find({ _id: channelId })
    const newChannelName = _.get(channelsIndex[channelId], '[0].channel.name')
    const values = {
      name: newChannelName,
    }
    if (dbChannel.size().value() > 0) {
      if (dbChannel.get('name').value() !== newChannelName) {
        channelsUpdatedCount++
        dbChannel.assign(values).write()
      }
    } else {
      newChannelsCount++
      channels
        .push({
          _id: channelId,
          ...values,
        })
        .write()
    }
  }
  if (newChannelsCount) console.log(`${newChannelsCount} new channels`)
  if (channelsUpdatedCount)
    console.log(`${channelsUpdatedCount} updated channels`)
}

const commands = new Commands()

if (commands[command])
  commands[command](argv).catch((err) => {
    console.error(err)
  })
