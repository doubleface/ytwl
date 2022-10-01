const FileSync = require('lowdb/adapters/FileSync')
const path = require('path')
const low = require('lowdb')
const _ = require('lodash')

class Model {
  constructor() {
    const adapter = new FileSync(path.join(__dirname, '..', 'data/youtube.json'))
    this.db = low(adapter)
    this.db.defaults({ videos: [], channels: [] }).write()
  }

  async getVideos() {
    return this.db.get('videos').value()
  }

  async setVideos(videos) {
    this.db.set('videos', videos).write()
  }

  async getChannels() {
    return this.db.get('channels').value()
  }

  async setChannels(channels) {
    this.db.set('channels', channels).write()
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
      videos.push({ ...fetchedIndexedById[id], metadata: { importDate: new Date() } })
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
  const blackListAttributes = ['metadata', 'publicationDate']
  return (
    JSON.stringify(_.omit(oldVid, blackListAttributes)) !==
    JSON.stringify(_.omit(newVid, blackListAttributes))
  )
}

module.exports = Model
