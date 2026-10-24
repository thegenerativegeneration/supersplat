type Rgb = readonly [number, number, number];

// Colours shared by the timeline markers and the 3D path line, as sRGB in 0..1.
// Detour keys: light sky blue, apart from the orange user keys and the red
// blocked marks, readable on the dark timeline and over most scans.
const AUTO_KEY_COLOR: Rgb = [0.3, 0.75, 1];
const BLOCKED_COLOR: Rgb = [1, 0.2, 0.2];

// "r, g, b" in 0..255, for CSS rgb() and rgba()
const cssChannels = (color: Rgb) => color.map(c => Math.round(c * 255)).join(', ');

export { AUTO_KEY_COLOR, BLOCKED_COLOR, cssChannels };
export type { Rgb };
