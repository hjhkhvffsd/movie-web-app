import axios from 'axios'

import { Request } from '@/core'
import {
  FetchItemArgs,
  FetchItemMovieArgs,
  FetchItemSeriesArgs,
  FetchMovieStreamArgs,
  FetchMovieTranslatorArgs,
  FetchSearchArgs,
  FetchSeriesEpisodesStreamArgs,
  FetchSeriesStreamArgs,
  FetchSeriesTranslatorArgs,
  FetchSeriesTranslatorResponse,
  FetchStreamDetailsArgs,
  FetchStreamDownloadSizeArgs,
  FetchStreamThumbnailArgs,
  FetchTranslatorArgs,
  Item,
  ItemMovie,
  ItemMovieStream,
  ItemSeries,
  ItemSeriesEpisodeStream,
  ItemSeriesSeasonStream,
  ItemSeriesStream,
  SeriesEpisodesStreamResponse,
  StreamResponse,
} from '@/types'

import { db } from './database'
import { PROVIDER_URL, PROXY_URL } from './env'
import { convertDataToDom, parseProxiedCookies, sendProxiedCookies } from './interceptors'
import {
  parseItemDocument,
  parseItemDocumentEpisodes,
  parseSearchDocument,
  parseStream,
  parseStreamSeasons,
} from './parser'
import { bytesToStr } from './utils'

export const html = new Request({
  baseURL: `${PROXY_URL}/${PROVIDER_URL}`,
  responseType: 'document',
  responseEncoding: 'utf8',
  timeout: 10_000,
})
  .useRequest(sendProxiedCookies)
  .useResponse(parseProxiedCookies)
  .useResponse(convertDataToDom)
  .construct()

export async function fetchSearch(args: FetchSearchArgs, retry = 0) {
  try {
    // TODO: Add pagination support
    const { query, signal } = args
    const params = { q: query, do: 'search', subaction: 'search' }
    const { data } = await html.get<Document>('/search/', { params, signal })
    return parseSearchDocument(data)
  } catch (err) {
    if (retry < 3) return await fetchSearch(args, retry + 1)
    throw err
  }
}

export async function fetchItemMovie(args: FetchItemMovieArgs, retry = 0): Promise<ItemMovie> {
  try {
    const { baseItem, translator, signal } = args
    const stream = await fetchMovieStream({
      id: baseItem.id,
      translatorId: translator.id,
      favsId: baseItem.favsId,
      isCamrip: translator.isCamrip,
      isAds: translator.isAds,
      isDirector: translator.isDirector,
      signal,
    })
    const streams: ItemMovieStream[] = baseItem.translators.map((t) => ({
      translatorId: t.id,
      stream: t.id === translator.id ? stream : null,
    }))
    return {
      ...baseItem,
      ogType: 'video.movie',
      itemType: 'movie',
      streams,
    }
  } catch (err) {
    if (retry < 3) return await fetchItemMovie(args, retry + 1)
    throw err
  }
}

export async function fetchItemSeries(args: FetchItemSeriesArgs, retry = 0): Promise<ItemSeries> {
  try {
    const { baseItem, translator, document, signal, season, episode } = args
    const episodesInfo = parseItemDocumentEpisodes(document)
    const { stream, seasons, streamFor } = await fetchSeriesEpisodesStream({
      id: baseItem.id,
      translatorId: translator.id,
      favsId: baseItem.favsId,
      season,
      episode,
      signal,
    })
    const streams: ItemSeriesStream[] = baseItem.translators.map((t) => {
      const translatorId = t.id
      let translatorSeasons: ItemSeriesSeasonStream[] | null = null
      if (translatorId === translator.id) {
        translatorSeasons = seasons.map((s) => ({
          number: s.number,
          title: s.title,
          episodes: s.episodes.map((e) => ({
            number: e.number,
            title: e.title,
            stream: s.number === streamFor.season && e.number === streamFor.episode ? stream : null,
          })),
        }))
      }
      return { translatorId, seasons: translatorSeasons }
    })
    return {
      ...baseItem,
      ogType: 'video.tv_series',
      itemType: 'series',
      episodesInfo,
      streams,
    }
  } catch (err) {
    if (retry < 3) return await fetchItemSeries(args, retry + 1)
    throw err
  }
}

export async function fetchItem(args: FetchItemArgs, retry = 0): Promise<Item> {
  try {
    const { signal, fullId, translatorId, season, episode } = args
    const data = await db.getItem(fullId.id, async () => {
      const uri = `/${fullId.typeId}/${fullId.genreId}/${fullId.slug}.html`
      const { data } = await html.get<Document>(uri, { signal })
      return data
    })
    const baseItem = parseItemDocument(data, fullId)
    const translator =
      baseItem.translators.find((t) => t.id === translatorId) || baseItem.translators[0]
    if (baseItem.ogType === 'video.movie') {
      return await fetchItemMovie({ baseItem, translator, signal })
    } else {
      return await fetchItemSeries({
        baseItem,
        translator,
        document: data,
        signal,
        season,
        episode,
      })
    }
  } catch (err) {
    if (retry < 3) return await fetchItem(args, retry + 1)
    throw err
  }
}

export const ajax = new Request({
  baseURL: `${PROXY_URL}/${PROVIDER_URL}`,
  responseType: 'json',
  responseEncoding: 'utf8',
  timeout: 10_000,
})
  .useRequest(sendProxiedCookies)
  .useResponse(parseProxiedCookies)
  .construct()

export async function fetchStreamDownloadSize(args: FetchStreamDownloadSizeArgs, retry = 0) {
  try {
    const size = await db.getStreamSize(args, async () => {
      const quality = args.stream.qualities.find((q) => q.id === args.qualityId)!
      const res = await axios.head(quality.downloadUrl, { signal: args.signal })
      const size = Number(res.headers['Content-Length'] || res.headers['content-length'] || '0')
      return size
    })
    return { id: args.qualityId, downloadSize: size, downloadSizeStr: bytesToStr(size) }
  } catch (err) {
    if (retry < 3) return await fetchStreamDownloadSize(args, retry + 1)
    throw err
  }
}

export async function fetchStreamThumbnails(args: FetchStreamThumbnailArgs, retry = 0) {
  try {
    const thumbnails = await db.getStreamThumbnail(args, async () => {
      const { data } = await ajax.get<string>(args.stream.thumbnailsUrl, { signal: args.signal })
      return data
    })
    return thumbnails
  } catch (err) {
    if (retry < 3) return await fetchStreamThumbnails(args, retry + 1)
    throw err
  }
}

export async function fetchStreamDetails(args: FetchStreamDetailsArgs, retry = 0) {
  try {
    const thumbnailsPromise = fetchStreamThumbnails(args)
    const promises = args.stream.qualities.map((q) =>
      fetchStreamDownloadSize({ ...args, qualityId: q.id }),
    )
    const [sizes, thumbnails] = await Promise.all([Promise.all(promises), thumbnailsPromise])
    return { thumbnails, sizes }
  } catch (err) {
    if (retry < 3) return await fetchStreamDetails(args, retry + 1)
    throw err
  }
}

export async function fetchMovieStream(args: FetchMovieStreamArgs, retry = 0) {
  try {
    const { id, translatorId, favsId, isCamrip, isAds, isDirector, signal } = args
    const data = await db.getAjaxMovie(args, async () => {
      const params = new URLSearchParams({
        id: String(id),
        translator_id: String(translatorId),
        favs: favsId,
        is_camrip: String(Number(isCamrip)),
        is_ads: String(Number(isAds)),
        is_director: String(Number(isDirector)),
        action: 'get_movie',
      })
      const { data } = await ajax.post<StreamResponse>(
        `/ajax/get_cdn_series/?t=${Date.now()}`,
        params,
        { signal },
      )
      if (!data.success)
        throw new Error(data.message || 'Unable to get movie stream details. Try again later.')
      return data
    })
    return parseStream(data)
  } catch (err) {
    if (retry < 3) return await fetchMovieStream(args, retry + 1)
    throw err
  }
}

export async function fetchSeriesStream(args: FetchSeriesStreamArgs, retry = 0) {
  try {
    const { id, translatorId, favsId, season, episode, signal } = args
    const params = new URLSearchParams({
      id: String(id),
      translator_id: String(translatorId),
      favs: favsId,
      season: String(season),
      episode: String(episode),
      action: 'get_stream',
    })
    const { data } = await ajax.post<StreamResponse>(
      `/ajax/get_cdn_series/?t=${Date.now()}`,
      params,
      { signal },
    )
    if (!data.success)
      throw new Error(data.message || 'Unable to get episode stream details. Try again later.')
    return parseStream(data)
  } catch (err) {
    if (retry < 3) return await fetchSeriesStream(args, retry + 1)
    throw err
  }
}

export async function fetchSeriesEpisodesStream(args: FetchSeriesEpisodesStreamArgs, retry = 0) {
  try {
    const { id, translatorId, favsId, season, episode, signal } = args
    const params = new URLSearchParams({
      id: String(id),
      translator_id: String(translatorId),
      favs: favsId,
      action: 'get_episodes',
    })
    if (typeof season === 'number') params.append('season', String(season))
    if (typeof episode === 'number') params.append('episode', String(episode))
    const { data } = await ajax.post<SeriesEpisodesStreamResponse>(
      `/ajax/get_cdn_series/?t=${Date.now()}`,
      params,
      { signal },
    )
    if (!data.success)
      throw new Error(data.message || 'Unable to get episodes list. Try again later.')
    const seasons = parseStreamSeasons(data.seasons, data.episodes)
    const stream = parseStream(data)
    return {
      seasons,
      stream,
      streamFor: {
        season: season || seasons[0].number,
        episode: episode || seasons[0].episodes[0].number,
      },
    }
  } catch (err) {
    if (retry < 3) return await fetchSeriesEpisodesStream(args, retry + 1)
    throw err
  }
}

export async function fetchMovieTranslator(args: FetchMovieTranslatorArgs, retry = 0) {
  try {
    const { item, translatorId, signal } = args
    const foundStream = item.streams.find((s) => s.translatorId === translatorId)!.stream
    if (foundStream) return { type: 'movie' as const }
    const translator = item.translators.find((t) => t.id === translatorId)!
    const stream = await fetchMovieStream({
      id: item.id,
      favsId: item.favsId,
      translatorId,
      isCamrip: translator.isCamrip,
      isAds: translator.isAds,
      isDirector: translator.isDirector,
      signal,
    })
    return { type: 'movie' as const, stream }
  } catch (err) {
    if (retry < 3) return await fetchMovieTranslator(args, retry + 1)
    throw err
  }
}

export async function fetchSeriesTranslator(args: FetchSeriesTranslatorArgs, retry = 0) {
  try {
    const { item, translatorId, state, signal } = args
    const stateTo = { season: state.season!, episode: state.episode! }
    let initial: FetchSeriesTranslatorResponse['initial']
    let seasons = item.streams.find((s) => s.translatorId === translatorId)!.seasons!
    if (!seasons) {
      // Translator not fetched yet
      const res = await fetchSeriesEpisodesStream({
        id: item.id,
        translatorId,
        favsId: item.favsId,
        signal,
      })
      const { seasons: newSeasons, stream, streamFor } = res
      seasons = newSeasons.map((s) => ({
        number: s.number,
        title: s.title,
        episodes: s.episodes.map((e) => ({
          number: e.number,
          title: e.title,
          stream: s.number === streamFor.season && e.number === streamFor.episode ? stream : null,
        })),
      }))
      initial = seasons
    }
    let season = seasons.find((s) => s.number === stateTo.season)
    let episode: ItemSeriesEpisodeStream | undefined
    if (!season) {
      // Season doesn't exists on this translator,
      // reset to first available season
      season = seasons[0]
      stateTo.season = season.number
      // and episode
      episode = season.episodes[0]
      stateTo.episode = episode.number
    } else {
      // Season exists, search for episode
      episode = season.episodes.find((e) => e.number === stateTo.episode)
    }
    if (!episode) {
      // Episode doesn't exists on this translator,
      // reset to first available episode
      episode = season.episodes[0]
      stateTo.episode = episode.number
    }
    let next: FetchSeriesTranslatorResponse['next']
    if (!episode.stream) {
      // Stream not fetched yet, start fetching
      const stream = await fetchSeriesStream({
        id: item.id,
        translatorId,
        favsId: item.favsId,
        season: stateTo.season,
        episode: stateTo.episode,
        signal,
      })
      next = { stream, streamFor: stateTo }
    }
    return {
      type: 'series' as const,
      stateTo,
      initial,
      next,
    }
  } catch (err) {
    if (retry < 3) return await fetchSeriesTranslator(args, retry + 1)
    throw err
  }
}

export async function fetchTranslator(args: FetchTranslatorArgs, retry = 0) {
  try {
    const { item, translatorId, state, signal } = args
    if (item.itemType === 'series') {
      return await fetchSeriesTranslator({ item, translatorId, signal, state })
    } else {
      return await fetchMovieTranslator({ item, translatorId, signal })
    }
  } catch (err) {
    if (retry < 3) return await fetchTranslator(args, retry + 1)
    throw err
  }
}
