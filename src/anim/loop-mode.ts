type LoopMode = 'none' | 'repeat' | 'pingpong';

// the viewer builds a looping spline only for 'repeat'; 'none' and 'pingpong' clamp at the outer keys
const loopModeMatchesTimeline = (mode: LoopMode, timelineLoop: boolean) => (mode === 'repeat') === timelineLoop;

export { LoopMode, loopModeMatchesTimeline };
