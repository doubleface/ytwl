#!/usr/bin/env node

/* eslint no-console: off */

process.env.LOG_LEVEL='error'
const { build } = require('@cozy/cli-tree')
const path = require('path')
const debug = require('debug')('ytwl')
const fetchWatchList = require('./youtubeWatchListConnector')
const _ = require('lodash')
const open = require('open')
const dateFns = require('date-fns')
const chalk = require('chalk')
const Database = require('better-sqlite3')
const inquirer = require('inquirer')
const Model = require('./model')
inquirer.registerPrompt('datetime', require('inquirer-datepicker-prompt'))
inquirer.registerPrompt('checkbox-plus', require('inquirer-checkbox-plus-prompt'))
const NO_VALUE = '__no_value__'
const DB_PATH = path.join(__dirname, '..', 'data', 'stats.db')
const conf = require('parse-strings-in-object')(
  require('rc')('ytwl', {
    indice: {
      importDateLimit: 7,
      importDateWeight: 50
    }
  })
)

debug('conf: %O', conf)
const model = new Model()

class Commands {
  async sync({ reset } = {}) {
    showSummary(await model.getVideos())
    const list = await fetchWatchList()
    debug('result: %O', list)
    if (reset) {
      await model.setVideos(list.map(formatCreateVid))
    } else {
      const existingIds = (await model.getVideos()).map(v => v._id)
      const fetchedIndexedById = _(list).keyBy('_id').value()

      const removeCount = await model.removeReadVids(existingIds, fetchedIndexedById)
      console.log(`${chalk.red(removeCount)} videos removed`)

      const addCount = await model.addNewVids(existingIds, fetchedIndexedById)
      console.log(`${chalk.green(addCount)} videos added`)

      const upCount = await model.updateVidsData(existingIds, fetchedIndexedById)
      console.log(`${chalk.yellow(upCount)} videos updated`)

      const summary = showSummary(await model.getVideos())
      const statsDb = new Database(DB_PATH, { verbose: debug })
      const dbParams = [
        new Date().toISOString(),
        summary.count,
        summary.nbViews || 0,
        summary.totalTime || 0,
        summary.totalImportDateDistance || 0
      ]
      debug('db operation params: %O', dbParams)
      const info = statsDb
        .prepare(
          'INSERT INTO stats (time, videos, views, durations, importAges) VALUES (?, ?, ?, ?, ?)'
        )
        .run(dbParams)
      debug('db operation info: %O', info)
      statsDb.close()

      const { newChannelsCount, channelsUpdatedCount } = await model.updateChannelsData()

      if (newChannelsCount) console.log(`${newChannelsCount} new channels`)
      if (channelsUpdatedCount) console.log(`${channelsUpdatedCount} updated channels`)
    }
  }

  async list({ sort, short, long, since, sync, deleted }) {
    if (sync) {
      await this.sync()
    }

    let order = ['indice']
    let direction = ['desc']

    if (sort !== NO_VALUE) {
      if (sort === null) {
        const sortCriterias = [
          { name: 'indice', value: ['indice', 'desc'] },
          { name: 'duration', value: ['duration.value', 'asc'] },
          { name: 'views', value: ['views', 'desc'] },
          { name: 'progress', value: ['progress.value', 'desc'] },
          { name: 'publicationDate', value: ['publicationDate', 'asc'] },
          { name: 'importDate', value: ['importDate', 'desc'] }
        ]

        const { sortOrder } = await inquirer.prompt({
          type: 'list',
          name: 'sortOrder',
          choices: sortCriterias
        })

        order = [sortOrder[0]]
        direction = [sortOrder[1]]
      } else {
        order = [sort]
        direction = ['asc']
      }
    }

    let durationFilter = v => v
    let dateFilter = v => v
    let deletedFilter = v => v

    if (short) {
      durationFilter = v => v.duration.value <= 600
    }

    if (long) {
      durationFilter = v => v.duration.value >= 3600
    }

    if (deleted) {
      deletedFilter = v => v._deleted
    }

    if (since !== NO_VALUE) {
      let sinceResult
      if (since === null) {
        sinceResult = (
          await inquirer.prompt({
            type: 'datetime',
            name: 'since',
            message: 'Please choose a date filter from now',
            format: ['dd', '/', 'mm', '/', 'yyyy'],
            initial: dateFns.startOfToday()
          })
        ).since
      } else {
        sinceResult = new Date(since)
      }
      dateFilter = v => new Date(v.publicationDate) > sinceResult
    }

    const list = _(await model.getVideos())
      .filter(dateFilter)
      .filter(durationFilter)
      .filter(deletedFilter)
      .map(v => ({ ...v, indice: getIndice(v) }))
      .orderBy(order, direction)
			.value()

    var ui = new inquirer.ui.BottomBar()
    ui.log.write(showSummary(list, true))
    const { toOpen } = await inquirer.prompt({
      type: 'checkbox-plus',
      name: 'toOpen',
      message: 'Choose a video to open',
      pageSize: 10,
      searchable: true,
      validate: list => {
        if (list.length >= 1) return true
        return 'Please select at least one item'
      },
      source: async (sofar, input) => _(list).filter(v =>
        `${_.get(v, 'channel.name')} ${_.get(v, 'title.value')}`
          .toLowerCase()
          .includes(input.toLowerCase())
      )
      .map(v => ({
        name: getVideoTextToDisplay(v),
        value: v._id
      }))
      .value()
    })

    await openInBrowser(toOpen)
  }
}

function formatCreateVid(v) {
  return { ...v, metadata: { importDate: new Date() } }
}

function getSummary(videos) {
  function getImportDateDistance(v) {
    return Date.now() - new Date(_.get(v, 'metadata.importDate')).getTime()
  }
  return {
    count: videos.length,
    totalTime: Math.round(_(videos).map('duration.value').sum() / 3600),
    totalImportDateDistance: Math.round(
      _(videos).map(getImportDateDistance).sum() / (1000 * 3600 * 24)
    ),
    totalIndice: _(videos).map(getIndice).sum()
  }
}

function showSummary(videos, getTextOnly = false) {
  const summary = getSummary(videos)
  const finalText = `${chalk.bold(summary.count)} videos to view with a total of ${chalk.bold(
    summary.totalTime
  )} hours of viewing time and ${chalk.blue(summary.totalIndice)} total indice and ${chalk.bold(
    summary.totalImportDateDistance
  )} days of import date age`
  if (getTextOnly) {
    return finalText
  }
  console.log(`
${finalText}
      `)
  return summary
}

function getIndice(v) {
  const { importDateWeight, importDateLimit } = conf.indice
  const importDate = new Date(_.get(v, 'metadata.importDate'))
  const importAgeInDays = (new Date().getTime() - importDate.getTime()) / (1000 * 3600 * 24)

  let importDateIndice = Math.round((importDateWeight / importDateLimit) * importAgeInDays)
  if (importDateIndice > importDateWeight) {
    importDateIndice = importDateWeight
  }

  let viewsPerSecond = 0
  if (_.get(v, 'duration.value')) {
    const remainingDuration = _.get(v, 'duration.value') - _.get(v, 'progress.value')
    viewsPerSecond = Math.round(10000 / remainingDuration)
  }

  return viewsPerSecond + importDateIndice
}

async function openInBrowser(ids) {
  if (ids.length === 1) {
    const [_id] = ids
    const vid = await model.getVideoById(_id)
    if (!vid) throw new Error(`Could not find video with id ${_id}. Need a sync ?`)

    const url = `https://www.youtube.com/watch?v=${_id}&list=WL&t=${vid.progress.value}s`
    open(url)
  } else {
    const url = `http://www.youtube.com/watch_videos?video_ids=` + ids.join(',')
    open(url)
  }
}

function getVideoTextToDisplay(v, mainField = 'indice') {
  const channel = chalk.bold.green(fixSize(_.get(v, 'channel.name', 'no channel name'), 20))
  const title = fixSize(_.get(v, 'title.value', 'no title'), 50)
  const duration = fixSize(_.get(v, 'duration.raw', 'no duration'), 7)
  const progress = fixSize(
    Math.round((_.get(v, 'progress.value') / _.get(v, 'duration.value')) * 100) + '%',
    5
  )

  const importDate = fixSize(
    dateFns.formatDistanceToNow(new Date(_.get(v, 'metadata.importDate', Date.now())), {
      addSuffix: true
    }),
    20
  )
  const indice = fixSize(v.indice, 5)
  const _deleted = v._deleted ? chalk.red(' DELETED') : ''

  let result = `${channel} ${title}: `
  const fields = {
    duration,
    indice,
    importDate,
    progress,
    _deleted
  }

  result += chalk.bold(fields[mainField]) + ','

  result += Object.values(_.omit(fields, mainField)).join(', ')

  return result
}

function fixSize(text, size) {
  return text.toString().slice(0, size).padStart(size, ' ')
}

const commands = new Commands()

const main = async () => {
  await model.init()
  const [parser] = build({
    sync: {
      description: 'Synchronize the local list of videos with your Watch Later playlist',
      arguments: [
        {
          argument: '--reset',
          action: 'storeTrue',
          help: 'Start the local playlist with Watch Later playlist data from empty'
        }
      ],
      handler: async a => commands.sync(a)
    },
    list: {
      description: 'Get the videos list',
      arguments: [
        {
          argument: '--sync',
          action: 'storeTrue',
          help: 'Run the sync command before listing the videos'
        },
        {
          argument: '--since',
          defaultValue: NO_VALUE,
          nargs: '?',
          help: 'Filter the list by date. Ex: 2020-05-25. Try no value to get an ui to chose the date.'
        },
        {
          argument: '--sort',
          defaultValue: NO_VALUE,
          nargs: '?',
          help: 'Video sorting criterias. Ex: "views". Try no value to get an ui to chose a value.'
        },
        {
          argument: '--short',
          action: 'storeTrue',
          help: 'Only show the short videos (10min max)'
        },
        {
          argument: '--long',
          action: 'storeTrue',
          help: 'Only show the long videos (1h min)'
        },
        {
          argument: '--deleted',
          action: 'storeTrue',
          help: 'Only show deleted video (videos which have been made private by the author since the last sync)'
        }
      ],
      handler: async a => commands.list(a)
    }
  })

  const args = parser.parseArgs()
  await args.handler(args)
}

if (require.main === module) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
