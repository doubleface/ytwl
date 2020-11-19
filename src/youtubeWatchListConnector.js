const puppeteer = require('puppeteer')
const is = require('@sindresorhus/is')
const fs = require('fs')
const get = require('lodash/get')
const debug = require('debug')('youtubeWatchListConnector')
const path = require('path')

const DATA_DIR = path.join(__dirname, '..', 'data')
const SESSION_PATH = path.join(DATA_DIR, 'session.json')
const FIREFOX_COOKIES_PATH = path.join(DATA_DIR, 'firefoxCookies.json')

module.exports = fetchWatchList

async function init() {
  const browser = await puppeteer.launch({
    // headless: false
    // devtools: true
  })
  const page = await browser.newPage()

  await initSession(page)
  return { browser, page }
}

async function fetchWatchList() {
  const { browser, page } = await init()
  let { videoList, ctoken, itct, idtoken } = await fetchInitWatchList(page)
  if (ctoken && itct && idtoken) {
    const { moreVideoList } = await fetchMoreVideos(page, {
      ctoken,
      itct,
      idtoken,
    })

    videoList.push.apply(videoList, moreVideoList)
  }
  debug('videoList length:', videoList.length)

  videoList = videoList.map(youtubeDataFormater)

  await stop({ browser, page })

  return videoList
}

async function fetchMoreVideos(page, { ctoken, itct, idtoken }) {
  const resp = await fetchJSON(
    page,
    `https://www.youtube.com/browse_ajax?ctoken=${ctoken}&continuation=${ctoken}&itct=${itct}`,
    {
      headers: {
        'X-YouTube-Client-Name': '1',
        'X-YouTube-Client-Version': '2.20200507.04.00',
        'X-Youtube-Identity-Token': idtoken,
      },
      method: 'GET',
    }
  )

  const moreVideoList = get(
    resp,
    '[1].response.continuationContents.playlistVideoListContinuation.contents'
  )
  is.assert.array(moreVideoList)
  debug('moreVideoList length', moreVideoList.length)
  return { moreVideoList }
}

async function fetchInitWatchList(page) {
  debug('https://www.youtube.com/playlist?list=WL ...')
  await page.goto('https://www.youtube.com/playlist?list=WL')
  const { contents, idtoken } = await page.evaluate(() => {
    const result = window.ytInitialData
    result.idtoken = window.ytcfg.data_['ID_TOKEN']
    return result
  })
  is.assert.nonEmptyString(idtoken)
  const playlistVideoListRenderer = get(
    contents,
    'twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.contents[0].itemSectionRenderer.contents[0].playlistVideoListRenderer',
    []
  )

  const videoList = get(playlistVideoListRenderer, 'contents', [])
  is.assert.array(videoList)
  debug('videoList length:', videoList.length)
  const continuation = get(playlistVideoListRenderer, 'continuations[0]', {})
  debug('continuation data: %O', continuation)

  if (!continuation || !continuation.nextContinuationData) return { videoList }

  const ctoken = continuation.nextContinuationData.continuation
  is.assert.nonEmptyString(ctoken)
  const itct = continuation.nextContinuationData.clickTrackingParams
  is.assert.nonEmptyString(itct)

  return { videoList, ctoken, itct, idtoken }
}

async function initSession(page) {
  debug('initSession')
  let session
  if (fs.existsSync(SESSION_PATH)) {
    debug('found session.json file')
    session = JSON.parse(fs.readFileSync(SESSION_PATH))
  } else {
    debug('no session.json file reading firefox session file')
    session = JSON.parse(fs.readFileSync(FIREFOX_COOKIES_PATH)).map(
      (cookie) => ({
        name: cookie['Name raw'],
        value: cookie['Content raw'],
        url: cookie['Host raw'],
        path: cookie['Path raw'],
        expires: Number(cookie['Expires raw']),
        httpOnly: cookie['HTTP only raw'] === 'true',
      })
    )
  }
  is.assert.nonEmptyArray(session)

  await page.setCookie(...session)
}

async function saveSession(page) {
  const session = await page.cookies()
  fs.writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2))
}

function fetchJSON(page, url, options) {
  return page.evaluate(
    async (url, options) => {
      const r = await fetch(url, options)
      const body = await r.json()
      return body
    },
    url,
    options
  )
}

async function stop({ browser, page }) {
  debug('Saving session for next run')
  await saveSession(page)
  await browser.close()
}

function youtubeDataFormater(vid) {
  const { playlistVideoRenderer } = vid
  debug('playlistVideoRenderer: %O', playlistVideoRenderer)
  const _id = playlistVideoRenderer.videoId
  is.assert.string(_id)
  const title = get(playlistVideoRenderer, 'title.runs[0].text')
  if (title === undefined) {
    debug(`Got %s video deleted`, _id)
    return { _id, _deleted: true }
  }
  is.assert.string(title)
  const rawTitle = get(
    playlistVideoRenderer,
    'title.accessibility.accessibilityData.label'
  )
  is.assert.string(rawTitle)
  const duration = Number(get(playlistVideoRenderer, 'lengthSeconds', 0)) // number in seconds
  is.assert.number(duration)
  const rawDuration = get(
    playlistVideoRenderer,
    'lengthText.simpleText',
    'not yet'
  ) // string like nn:nn
  is.assert.string(rawDuration)
  const percentDurationWatched = get(
    playlistVideoRenderer,
    'thumbnailOverlays[0].thumbnailOverlayResumePlaybackRenderer.percentDurationWatched',
    0
  )
  is.assert.number(percentDurationWatched)
  const progress = get(
    playlistVideoRenderer,
    'navigationEndpoint.watchEndpoint.startTimeSeconds',
    0
  )
  is.assert.number(progress)
  const channel = {
    _id: get(
      playlistVideoRenderer,
      'shortBylineText.runs[0].navigationEndpoint.browseEndpoint.browseId'
    ),
    name: get(playlistVideoRenderer, 'shortBylineText.runs[0].text'),
  }
  is.assert.string(channel._id)
  is.assert.string(channel.name)

  const thumbnail = get(playlistVideoRenderer, 'thumbnail.thumbnails[3].url') // string url
  is.assert.urlString(thumbnail)

  return {
    _id,
    title: {
      value: title,
      raw: rawTitle,
    },
    duration: {
      value: duration,
      raw: rawDuration,
    },
    progress: {
      value: progress,
      percentDurationWatched,
    },
    channel,
    thumbnail,
    ...getMetaData(rawTitle),
  }
}

// extracts metadata from a long youtube title: nb views and publication date
function getMetaData(rawTitle) {
  debug('Trying to get metadata from raw title: %s', rawTitle)
  const regexps = [
    /.*(\w+\s\w+)\sago.*$/,
    /.*il y a (\w+\S\w+).*$/,
    /.*il y a (\w+\s\w+).*$/,
  ]

  let matching
  for (const regex of regexps) {
    matching = rawTitle.match(regex)
    if (!matching) continue
    else break
  }

  // debug('matching: %O', matching)
  let [ago, views] = matching ? matching.slice(1).filter(Boolean) : []
  // if (views) views = Number(views.split(/\s/).join(''))
  debug('%s: %s, %s', rawTitle, ago, views)
  const publicationDate = ago ? convertDistanceToDate(ago) : new Date()
  is.assert.date(publicationDate)

  return {
    publicationDate,
    views,
  }
}

// ex: convert 5 years ago to a corresponding date object
function convertDistanceToDate(distance) {
  is.assert.string(distance)
  debug('Converting time distance: %s', distance)
  let [nb, unit] = distance.trim().split(/\s/)
  debug('nb: ', nb)
  debug('unit: ', unit)
  const ms = 1
  const second = 1000 * ms
  const minute = 60 * second
  const hour = 60 * minute
  const day = 24 * hour
  const week = 7 * day
  const month = 30 * day
  const year = 365 * day

  unit = detectAndConvertFrUnit(unit.trim())
  debug('En unit: ', unit)

  const mapTime = { second, minute, hour, day, week, month, year }
  for (const key in mapTime) {
    mapTime[key + 's'] = key
  }
  debug('mapTime[unit]: ', mapTime[unit])

  return new Date(Date.now() - Number(nb) * mapTime[unit])
}

function detectAndConvertFrUnit(unit) {
  const frDict = {
    seconde: 'second',
    heure: 'hour',
    minute: 'minute',
    jour: 'day',
    semaine: 'week',
    mois: 'month',
    an: 'year',
  }

  const foundOne = frDict[unit]
  const foundPlural = frDict[unit.slice(0, -1)]

  if (foundOne) {
    return frDict[unit]
  } else if (foundPlural) {
    return frDict[unit.slice(0, -1)]
  }

  return unit
}
