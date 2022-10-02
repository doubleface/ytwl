const _ = require('lodash')
const { Q } = require('cozy-client')
const { createClientInteractive } = require('cozy-client/dist/cli')

const VIDEOS_DOCTYPE = 'ytwl.videos'
const CHANNELS_DOCTYPE = 'ytwl.channels'

const conf = require('parse-strings-in-object')(require('rc')('ytwl'))

class Model {
  async init() {
    if (!conf.cozyUrl) {
      throw new Error('Found no cozyUrl in .ytwlrc file')
    }
    this.client = await createClientInteractive({
      uri: conf.cozyUrl,
      scope: ['ytwl.videos', 'ytwl.channels'],
      oauth: {
        softwareID: 'ytwl'
      }
    })
  }

  async getVideos() {
    const { data } = await this.client.query(Q(VIDEOS_DOCTYPE))
    return data
  }

  async resetVideos() {
    const all = await this.getVideos()
    if (all.length) {
      await this.client.saveAll(all.map(v => ({ ...v, _deleted: true })))
    }
  }

  async setVideos(videos) {
    await this.resetVideos()
    if (videos.length) {
      const finalVideos = videos.map(v => ({
        ..._.omit(v, '_rev'),
        _type: VIDEOS_DOCTYPE
      }))
      const result = await this.client.saveAll(finalVideos)
    }
  }

  async getChannels() {
    const { data } = await this.client.query(Q(CHANNELS_DOCTYPE))
    return data
  }

  async setChannels(channels) {
    const all = await this.getChannels()
    if (all.length) {
      await this.client.saveAll(all.map(v => ({ ...v, _deleted: true })))
    }
    if (channels.length) {
      const result = await this.client.saveAll(
        channels.map(v => ({ ..._.omit(v, '_rev'), _type: CHANNELS_DOCTYPE }))
      )
    }
  }

  async updateChannelsData() {
    const channelsIndex = _(await this.getVideos())
      .groupBy('channel._id')
      .value()
    const channels = await this.getChannels()
    let newChannelsCount = 0
    let channelsUpdatedCount = 0
    for (const channelId in channelsIndex) {
      const dbChannelIndex = channels.findIndex(c => c._id === channelId)
      const newChannelName = _.get(channelsIndex[channelId], '[0].channel.name')
      const values = {
        name: newChannelName
      }
      if (dbChannelIndex > -1) {
        if (channels[dbChannelIndex]?.name !== newChannelName) {
          channelsUpdatedCount++
          Object.assign(channels[dbChannelIndex], values)
        }
      } else {
        newChannelsCount++
        channels.push({
          _id: channelId,
          ...values
        })
      }
    }
    await this.setChannels(channels)
    return {
      newChannelsCount,
      channelsUpdatedCount
    }
  }

  async addNewVids(existingIds, fetchedIndexedById) {
    const toAddIds = _.difference(Object.keys(fetchedIndexedById), existingIds)
    const videos = await this.getVideos()
    for (const id of toAddIds) {
      videos.push({
        ...fetchedIndexedById[id],
        metadata: { importDate: new Date() }
      })
    }
    await this.setVideos(videos)
    return toAddIds.length
  }

  async removeReadVids(existingIds, fetchedIndexedById) {
    const toRemoveIds = _.difference(existingIds, Object.keys(fetchedIndexedById))
    const videos = await this.getVideos()
    _(videos)
      .remove(v => toRemoveIds.includes(v._id))
      .value()
    await this.setVideos(videos)
    return toRemoveIds.length
  }

  async updateVidsData(existingIds, fetchedIndexedById) {
    const videos = await this.getVideos()
    const toUpdateIds = _.intersection(existingIds, Object.keys(fetchedIndexedById))
    let upCount = 0
    for (const id of toUpdateIds) {
      const dbVidIndex = videos.findIndex(v => v._id === id)
      if (findUpdatedData(videos[dbVidIndex], fetchedIndexedById[id])) {
        upCount++
      }
      fetchedIndexedById[id].metadata = {
        importDate: videos[dbVidIndex].metadata.importDate,
        updateDate: new Date()
      }
      Object.assign(videos[dbVidIndex], fetchedIndexedById[id])
    }
    await this.setVideos(videos)
    return upCount
  }

  async getVideoById(_id) {
    return _(await this.getVideos()).find({ _id })
  }
}

function findUpdatedData(oldVid, newVid) {
  const blackListAttributes = [
    'metadata',
    'publicationDate',
    'deleted',
    'id',
    '_type',
    '_rev',
    'cozyMetadata'
  ]
  return (
    JSON.stringify(_.omit(oldVid, blackListAttributes)) !==
    JSON.stringify(_.omit(newVid, blackListAttributes))
  )
}

module.exports = Model
