// Casting while a movie is open.
//
// Chromecast (Chrome, Edge, Android Chrome) loads the Google Cast sender and
// hands the receiver a URL. AirPlay (Safari / iOS) uses the video element's
// playback-target picker. Anything else with the Remote Playback API gets
// that. The button stays hidden until one of those routes is actually
// available, and until the URL is one a television can fetch by itself.
//
// Limits, in plain terms:
// - The TV downloads the stream itself. A media element cannot send an
//   Authorization header, so the credential has to already be in the query
//   string (Plex X-Plex-Token, Jellyfin ApiKey, Emby api_key). A private
//   /Videos/ or Plex transcode URL with no credential is not offered.
// - Relative HLS segment URLs do not inherit the master playlist's query
//   string (RFC 3986). A Jellyfin or Plex HLS cast can 401 on every segment
//   even though the master URL has a token. Direct file URLs are preferred
//   when this player was willing to direct-play.
// - The TV has to be able to reach that host. A LAN address works for a
//   television on the same network and fails for one that is not. An https
//   page casting an http stream is often refused by Chromecast; the button
//   still tries, and a warning is logged without the URL (the URL contains
//   the token).
// - The Cast SDK only loads in a secure context (https or localhost) and only
//   in real Chromium. Firefox, Safari, and iOS browsers (CriOS / FxiOS /
//   EdgiOS are WebKit) do not get the script. The desktop app's content
//   security policy blocks gstatic; the script error hides the button.
// - Chrome plays HLS through Media Source Extensions, so the element has a
//   blob address AirPlay cannot send. Chrome uses Chromecast, which is given
//   the real URL. AirPlay is the Safari path, where the element itself is
//   already pointed at the network stream. Do not pause before the AirPlay
//   picker. Chromecast playback is a second player, so the phone pauses
//   locally without cancelling the server transcode (the TV still needs that
//   session). Closing the player stops the encode, which stops the TV.

export interface CastOffer {
  directUrl: string;
  hlsUrl: string;
  directPlayable: boolean;
  title: string;
  currentTime: number;
}

export interface ReceiverMedia {
  url: string;
  contentType: string;
}

export type CastRoute = 'chromecast' | 'airplay' | 'remote';

const CAST_SENDER_URL = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
const CREDENTIAL_KEYS = new Set(['x-plex-token', 'apikey', 'api_key']);

export function mediaCredentialInUrl(url: string): boolean {
  let params: URLSearchParams;
  try {
    params = new URL(url, 'https://cast.invalid').searchParams;
  } catch {
    return false;
  }
  for (const [key, value] of params) {
    if (value && CREDENTIAL_KEYS.has(key.toLowerCase())) return true;
  }
  return false;
}

/** Paths a receiver cannot fetch anonymously. A public file URL is not one of these. */
export function isPrivateMediaPath(url: string): boolean {
  let path = '';
  try {
    path = decodeURIComponent(new URL(url, 'https://cast.invalid').pathname).toLowerCase();
  } catch {
    return true;
  }
  return path.includes('/videos/')
    || path.includes('/video/:/transcode')
    || path.includes('/library/parts/');
}

export function insecureCastFromSecurePage(pageProtocol: string, mediaUrl: string): boolean {
  return pageProtocol === 'https:' && /^http:\/\//i.test(mediaUrl);
}

export function elementHasNetworkSource(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

/** Chromium that can load the Cast sender. iOS browsers are WebKit even when branded Chrome. */
export function isCastChromium(userAgent: string): boolean {
  if (/CriOS|FxiOS|EdgiOS|OPiOS/i.test(userAgent)) return false;
  if (/Firefox/i.test(userAgent)) return false;
  if (/Edg\//.test(userAgent)) return true;
  return /Chromium|Chrome/i.test(userAgent);
}

export function chooseCastRoute(available: {
  chromiumCast: boolean;
  airplay: boolean;
  remotePlayback: boolean;
}): CastRoute | null {
  if (available.chromiumCast) return 'chromecast';
  if (available.airplay) return 'airplay';
  if (available.remotePlayback) return 'remote';
  return null;
}

function absoluteHttpUrl(url: string, pageUrl?: string): string | null {
  if (!url) return null;
  const base = pageUrl ?? (typeof location !== 'undefined' ? location.href : '');
  let absolute = url;
  if (!/^https?:\/\//i.test(url)) {
    if (!base) return null;
    try { absolute = new URL(url, base).href; } catch { return null; }
  }
  return /^https?:\/\//i.test(absolute) ? absolute : null;
}

function castableUrl(url: string, pageUrl?: string): string | null {
  const absolute = absoluteHttpUrl(url, pageUrl);
  if (!absolute) return null;
  if (isPrivateMediaPath(absolute) && !mediaCredentialInUrl(absolute)) return null;
  return absolute;
}

function contentTypeFor(url: string): string {
  const path = url.split('?')[0].toLowerCase();
  if (path.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (path.endsWith('.webm')) return 'video/webm';
  if (path.endsWith('.mkv')) return 'video/x-matroska';
  if (path.endsWith('.mov')) return 'video/quicktime';
  return 'video/mp4';
}

/** The URL a television should open, or null when nothing on offer is fetchable. */
export function receiverMedia(offer: CastOffer, pageUrl?: string): ReceiverMedia | null {
  if (offer.directPlayable) {
    const direct = castableUrl(offer.directUrl, pageUrl);
    if (direct) return { url: direct, contentType: contentTypeFor(direct) };
  }
  const hls = castableUrl(offer.hlsUrl, pageUrl);
  if (hls) return { url: hls, contentType: 'application/vnd.apple.mpegurl' };
  return null;
}

interface CastMediaInfo {
  streamType: string;
  metadata: { title?: string };
}

interface ChromeCastNamespace {
  AutoJoinPolicy: { ORIGIN_SCOPED: string };
  media: {
    DEFAULT_MEDIA_RECEIVER_APP_ID: string;
    StreamType: { BUFFERED: string };
    MediaInfo: new (contentId: string, contentType: string) => CastMediaInfo;
    GenericMediaMetadata: new () => { title?: string };
    LoadRequest: new (info: CastMediaInfo) => { currentTime: number };
  };
}

interface CastSession {
  loadMedia(request: { currentTime: number }): Promise<unknown>;
}

interface CastContext {
  setOptions(options: { receiverApplicationId: string; autoJoinPolicy: string }): void;
  getCastState(): string;
  requestSession(): Promise<unknown>;
  getCurrentSession(): CastSession | null;
  endCurrentSession(stopCasting: boolean): void;
  addEventListener(type: string, listener: (event: { sessionState?: string }) => void): void;
}

interface CastFramework {
  CastContext: { getInstance(): CastContext };
  CastContextEventType: { CAST_STATE_CHANGED: string; SESSION_STATE_CHANGED: string };
  CastState: { NO_DEVICES_AVAILABLE: string };
  SessionState: { SESSION_ENDED: string; SESSION_ENDING: string };
}

interface RemotePlaybackLike extends EventTarget {
  watchAvailability(callback: (available: boolean) => void): Promise<number>;
  prompt(): Promise<void>;
}

type CastWindow = Window & {
  __onGCastApiAvailable?: (available: boolean) => void;
  chrome?: { cast?: ChromeCastNamespace };
  cast?: { framework?: CastFramework };
};

export interface PlaybackCast {
  sync(): void;
  stop(): void;
}

/**
 * Wire the cast button. requestSession is called from the click handler
 * itself; the Cast SDK drops the gesture if that call is deferred.
 */
export function installPlaybackCast(
  video: HTMLVideoElement,
  button: HTMLButtonElement,
  read: () => CastOffer | null,
  hooks: { log?: (message: string) => void; onActive?: (active: boolean, route: CastRoute) => void } = {},
): PlaybackCast {
  let route: CastRoute | null = null;
  let offerOk = false;
  let active = false;
  let airplayAvailable = false;
  let remoteAvailable = false;
  let castContext: CastContext | null = null;
  let castFramework: CastFramework | null = null;
  let insecureWarned = false;

  button.hidden = true;

  const prefer = () => {
    const castReady = !!castContext && !!castFramework
      && castContext.getCastState() !== castFramework.CastState.NO_DEVICES_AVAILABLE;
    const src = video.currentSrc || video.src || '';
    route = chooseCastRoute({
      chromiumCast: castReady,
      airplay: airplayAvailable,
      remotePlayback: remoteAvailable && elementHasNetworkSource(src),
    });
    button.hidden = !(offerOk && route);
    button.setAttribute('aria-label', route === 'airplay' ? 'AirPlay' : 'Cast');
    if (!active) button.classList.remove('is-casting');
  };

  const warnInsecure = (url: string) => {
    if (insecureWarned || typeof location === 'undefined') return;
    if (!insecureCastFromSecurePage(location.protocol, url)) return;
    insecureWarned = true;
    hooks.log?.('[Player] cast target is an http address opened from https; the TV may refuse it');
  };

  button.addEventListener('click', () => {
    if (active && route === 'chromecast') {
      endChromecast();
      return;
    }
    const offer = read();
    if (!offer || !route) return;
    const media = receiverMedia(offer);
    if (!media) return;
    if (route === 'chromecast') startChromecast(media, offer);
    else if (route === 'airplay') startAirPlay(media.url);
    else startRemote();
  });

  video.addEventListener('webkitplaybacktargetavailabilitychanged', (event) => {
    airplayAvailable = (event as Event & { availability?: string }).availability === 'available';
    prefer();
  });
  video.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', () => {
    const wireless = !!(video as HTMLVideoElement & { webkitCurrentPlaybackTargetIsWireless?: boolean }).webkitCurrentPlaybackTargetIsWireless;
    active = wireless;
    button.classList.toggle('is-casting', active);
    hooks.onActive?.(active, 'airplay');
  });

  const remote = (video as HTMLVideoElement & { remote?: RemotePlaybackLike }).remote;
  if (remote && typeof remote.watchAvailability === 'function') {
    remote.addEventListener('connect', () => {
      active = true;
      button.classList.add('is-casting');
      hooks.onActive?.(true, 'remote');
    });
    remote.addEventListener('disconnect', () => {
      if (route === 'chromecast') return;
      active = false;
      button.classList.remove('is-casting');
      hooks.onActive?.(false, 'remote');
    });
    void remote.watchAvailability((available) => {
      remoteAvailable = available;
      prefer();
    }).catch(() => {
      remoteAvailable = false;
      prefer();
    });
  }

  if (typeof navigator !== 'undefined' && isCastChromium(navigator.userAgent) && window.isSecureContext !== false) {
    void loadCastFramework();
  }

  return {
    sync() {
      const offer = read();
      const media = offer ? receiverMedia(offer) : null;
      offerOk = !!media;
      if (media) warnInsecure(media.url);
      prefer();
    },
    stop() {
      endChromecast();
    },
  };

  function endChromecast() {
    const was = active && route === 'chromecast';
    active = false;
    button.classList.remove('is-casting');
    try { castContext?.endCurrentSession(true); } catch { /* session already gone */ }
    if (was) hooks.onActive?.(false, 'chromecast');
  }

  function startAirPlay(url: string) {
    warnInsecure(url);
    const picker = (video as HTMLVideoElement & { webkitShowPlaybackTargetPicker?: () => void }).webkitShowPlaybackTargetPicker;
    picker?.call(video);
  }

  function startRemote() {
    const playback = (video as HTMLVideoElement & { remote?: RemotePlaybackLike }).remote;
    if (!playback || typeof playback.prompt !== 'function') return;
    void playback.prompt().catch(() => { /* cancelled, or no device */ });
  }

  function startChromecast(media: ReceiverMedia, offer: CastOffer) {
    const chromeCast = (window as CastWindow).chrome?.cast;
    const ctx = castContext;
    if (!chromeCast || !ctx) return;
    warnInsecure(media.url);
    // Called directly from the click, before this promise resolves.
    const pending = ctx.requestSession();
    void pending.then(() => {
      const session = ctx.getCurrentSession();
      if (!session) throw new Error('no cast session');
      const info = new chromeCast.media.MediaInfo(media.url, media.contentType);
      info.streamType = chromeCast.media.StreamType.BUFFERED;
      const metadata = new chromeCast.media.GenericMediaMetadata();
      metadata.title = offer.title;
      info.metadata = metadata;
      const request = new chromeCast.media.LoadRequest(info);
      request.currentTime = Number.isFinite(offer.currentTime) ? Math.max(0, offer.currentTime) : 0;
      return session.loadMedia(request);
    }).then(() => {
      active = true;
      button.classList.add('is-casting');
      hooks.onActive?.(true, 'chromecast');
    }).catch(() => {
      hooks.log?.('[Player] cast did not start');
    });
  }

  function loadCastFramework(): Promise<boolean> {
    const win = window as CastWindow;
    if (win.cast?.framework && win.chrome?.cast) return Promise.resolve(attach(win));
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => resolve(false), 8000);
      win.__onGCastApiAvailable = (available: boolean) => {
        window.clearTimeout(timer);
        resolve(available ? attach(win) : false);
      };
      const script = document.createElement('script');
      script.src = CAST_SENDER_URL;
      script.async = true;
      script.onerror = () => {
        window.clearTimeout(timer);
        resolve(false);
      };
      document.head.appendChild(script);
    });
  }

  function attach(win: CastWindow): boolean {
    try {
      const framework = win.cast?.framework;
      const chromeCast = win.chrome?.cast;
      if (!framework || !chromeCast) return false;
      const ctx = framework.CastContext.getInstance();
      ctx.setOptions({
        receiverApplicationId: chromeCast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: chromeCast.AutoJoinPolicy.ORIGIN_SCOPED,
      });
      castFramework = framework;
      castContext = ctx;
      ctx.addEventListener(framework.CastContextEventType.CAST_STATE_CHANGED, () => prefer());
      ctx.addEventListener(framework.CastContextEventType.SESSION_STATE_CHANGED, (event) => {
        const ended = event.sessionState === framework.SessionState.SESSION_ENDED
          || event.sessionState === framework.SessionState.SESSION_ENDING;
        if (!ended || !active) return;
        active = false;
        button.classList.remove('is-casting');
        hooks.onActive?.(false, 'chromecast');
      });
      return true;
    } catch {
      return false;
    }
  }
}
