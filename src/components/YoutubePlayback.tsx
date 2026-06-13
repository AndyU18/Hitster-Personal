import React from 'react';
import { View } from 'react-native';
import YoutubePlayer from 'react-native-youtube-iframe';

export default function YoutubePlayback({
  videoId,
  isPlaying,
  onEnded,
}: {
  videoId: string;
  isPlaying: boolean;
  onEnded: () => void;
}) {
  return (
    <View style={{ width: 0, height: 0, opacity: 0, position: 'absolute' }}>
      <YoutubePlayer
        height={0}
        play={isPlaying}
        videoId={videoId}
        onChangeState={(state: string) => {
          if (state === 'ended') {
            onEnded();
          }
        }}
      />
    </View>
  );
}
