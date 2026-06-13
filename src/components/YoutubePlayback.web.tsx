import React from 'react';

export default function YoutubePlayback({
  videoId,
  isPlaying,
  onEnded,
}: {
  videoId: string;
  isPlaying: boolean;
  onEnded: () => void;
}) {
  if (!isPlaying) return null;

  const IFrameWeb = 'iframe' as any;

  return (
    <IFrameWeb
      src={`https://www.youtube.com/embed/${videoId}?autoplay=1&controls=0`}
      style={{ width: 0, height: 0, border: 'none', position: 'absolute' }}
      allow="autoplay"
    />
  );
}
