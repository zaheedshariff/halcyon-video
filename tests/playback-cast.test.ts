import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseCastRoute,
  elementHasNetworkSource,
  insecureCastFromSecurePage,
  isCastChromium,
  isPrivateMediaPath,
  mediaCredentialInUrl,
  receiverMedia,
  type CastOffer,
} from '../src/playback-cast.ts';

const PAGE = 'https://halcyon.example/store';

function offer(partial: Partial<CastOffer> = {}): CastOffer {
  return {
    directUrl: '',
    hlsUrl: '',
    directPlayable: false,
    title: 'The Tape',
    currentTime: 12,
    ...partial,
  };
}

test('a credentialed direct file is what the television opens', () => {
  const media = receiverMedia(offer({
    directPlayable: true,
    directUrl: 'http://192.168.1.20:32400/library/parts/5/file.mp4?X-Plex-Token=abc',
    hlsUrl: 'http://192.168.1.20:32400/video/:/transcode/universal/start.m3u8?X-Plex-Token=abc',
  }), PAGE);
  assert.equal(media?.contentType, 'video/mp4');
  assert.match(media?.url ?? '', /library\/parts\/5/);
});

test('unsafe direct play falls through to the credentialed playlist', () => {
  const media = receiverMedia(offer({
    directPlayable: false,
    directUrl: 'https://jellyfin.local/Videos/9/stream?static=true&ApiKey=sek',
    hlsUrl: 'https://jellyfin.local/Videos/9/master.m3u8?ApiKey=sek&PlaySessionId=1',
  }), PAGE);
  assert.equal(media?.contentType, 'application/vnd.apple.mpegurl');
  assert.match(media?.url ?? '', /master\.m3u8/);
});

test('a private stream with no credential is not offered', () => {
  assert.equal(receiverMedia(offer({
    directPlayable: true,
    directUrl: 'https://jellyfin.local/Videos/9/stream?static=true',
    hlsUrl: 'https://jellyfin.local/Videos/9/master.m3u8',
  }), PAGE), null);
  assert.equal(mediaCredentialInUrl('https://host/file.mp4?X-Plex-Token='), false);
  assert.equal(mediaCredentialInUrl('https://host/file.mp4?api_key=emby'), true);
});

test('a public file with no token is castable, including a relative one', () => {
  const absolute = receiverMedia(offer({
    directPlayable: true,
    directUrl: 'https://cdn.example/demo.mp4',
  }), PAGE);
  assert.equal(absolute?.url, 'https://cdn.example/demo.mp4');
  assert.equal(absolute?.contentType, 'video/mp4');
  const relative = receiverMedia(offer({
    directPlayable: true,
    directUrl: '/demo.mp4',
  }), PAGE);
  assert.equal(relative?.url, 'https://halcyon.example/demo.mp4');
  assert.equal(isPrivateMediaPath('https://cdn.example/demo.mp4'), false);
  assert.equal(isPrivateMediaPath('https://plex.local/video/:/transcode/universal/start.m3u8'), true);
});

test('https pages casting http media are called out, and route choice is ordered', () => {
  assert.equal(insecureCastFromSecurePage('https:', 'http://192.168.1.8/movie.mp4'), true);
  assert.equal(insecureCastFromSecurePage('http:', 'http://192.168.1.8/movie.mp4'), false);
  assert.equal(insecureCastFromSecurePage('https:', 'https://cdn.example/a.mp4'), false);
  assert.equal(chooseCastRoute({ chromiumCast: true, airplay: true, remotePlayback: true }), 'chromecast');
  assert.equal(chooseCastRoute({ chromiumCast: false, airplay: true, remotePlayback: true }), 'airplay');
  assert.equal(chooseCastRoute({ chromiumCast: false, airplay: false, remotePlayback: true }), 'remote');
  assert.equal(chooseCastRoute({ chromiumCast: false, airplay: false, remotePlayback: false }), null);
  assert.equal(elementHasNetworkSource('blob:https://halcyon.example/111'), false);
  assert.equal(elementHasNetworkSource('https://cdn.example/a.mp4'), true);
});

test('only real Chromium is offered the Cast sender', () => {
  assert.equal(isCastChromium('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'), true);
  assert.equal(isCastChromium('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36'), true);
  assert.equal(isCastChromium('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'), true);
  assert.equal(isCastChromium('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15'), false);
  assert.equal(isCastChromium('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/120.0 Mobile/15E148 Safari/604.1'), false);
  assert.equal(isCastChromium('Mozilla/5.0 (Android 14; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0'), false);
  assert.equal(isCastChromium('Mozilla/5.0 (iPhone) FxiOS/120.0 Mobile/15E148 Safari/604.1'), false);
});
