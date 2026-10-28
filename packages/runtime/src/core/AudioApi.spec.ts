import { describe, expect, it, vi } from 'vitest';
import { SceneService } from './SceneService';
import { AUDIO_REQUEST_LOG_LIMIT } from './AudioApi';
import { AudioPlayer } from '../nodes/AudioPlayer';

describe('scene.audio.requested (core-tests/game17)', () => {
  it('journals every clip and sfx asked for, with the frame, even when nothing is audible', async () => {
    const service = new SceneService();
    let frame = 3;
    service.setDelegate({
      getFrameNumber: () => frame,
      getAssetLoader: () => null,
      getAudioService: () => null,
    } as unknown as Parameters<SceneService['setDelegate']>[0]);

    await service.audio.play('res://audio/match.ogg');
    frame = 7;
    service.audio.sfx('score');

    expect(service.audio.requested()).toEqual({
      total: 2,
      last: [
        { sound: 'res://audio/match.ogg', frame: 3 },
        { sound: 'sfx:score', frame: 7 },
      ],
    });
  });

  it('keeps the last entries and counts all of them', () => {
    const service = new SceneService();
    for (let i = 0; i < AUDIO_REQUEST_LOG_LIMIT + 5; i++) service.audio.sfx('tap');
    const journal = service.audio.requested();
    expect(journal.total).toBe(AUDIO_REQUEST_LOG_LIMIT + 5);
    expect(journal.last).toHaveLength(AUDIO_REQUEST_LOG_LIMIT);
  });

  it('journals an AudioPlayer node that reaches the AudioService directly', async () => {
    const service = new SceneService();
    service.setDelegate({
      getFrameNumber: () => 12,
      getAssetLoader: () => null,
      getAudioService: () => null,
    } as unknown as Parameters<SceneService['setDelegate']>[0]);
    const player = new AudioPlayer({
      id: 'music',
      name: 'Music',
      audioTrack: 'res://audio/theme.ogg',
    });
    player.scene = service;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await player.play();
    warn.mockRestore();
    expect(service.audio.requested().last).toEqual([{ sound: 'res://audio/theme.ogg', frame: 12 }]);
  });
});
