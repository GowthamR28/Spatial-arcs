export interface Palette {
  id: string;
  name: string;
  colors: string[];
}

// Each ramp is used to build the node/edge color scales via
// d3.interpolateRgbBasis, which walks the full list of stops (not just a
// fixed 3-color gradient) — so a 5-stop or 10-stop palette both just work.
export const PALETTES: Palette[] = [
  { id: 'ruby', name: 'Ruby', colors: ['#590d22', '#800f2f', '#a4133c', '#c9184a', '#ff4d6d', '#ff758f', '#ff8fa3', '#ffb3c1', '#ffccd5', '#fff0f3'] },
  { id: 'ember', name: 'Ember', colors: ['#03071e', '#370617', '#6a040f', '#9d0208', '#d00000', '#dc2f02', '#e85d04', '#f48c06', '#faa307', '#ffba08'] },
  { id: 'sage', name: 'Sage', colors: ['#386641', '#6a994e', '#a7c957', '#f2e8cf', '#bc4749'] },
  { id: 'violet', name: 'Violet', colors: ['#10002b', '#240046', '#3c096c', '#5a189a', '#7b2cbf', '#9d4edd', '#c77dff', '#e0aaff'] },
  { id: 'seafoam', name: 'Seafoam', colors: ['#99e2b4', '#88d4ab', '#78c6a3', '#67b99a', '#56ab91', '#469d89', '#358f80', '#248277', '#14746f', '#036666'] },
  { id: 'amber', name: 'Amber', colors: ['#ff7b00', '#ff8800', '#ff9500', '#ffa200', '#ffaa00', '#ffb700', '#ffc300', '#ffd000', '#ffdd00', '#ffea00'] },
  { id: 'ocean', name: 'Ocean', colors: ['#800016', '#a0001c', '#c00021', '#ff002b', '#407ba7', '#004e89', '#002962', '#00043a'] },
];

export const DEFAULT_PALETTE_ID = 'ruby';

function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) || 0;
  const g = parseInt(hex.slice(3, 5), 16) || 0;
  const b = parseInt(hex.slice(5, 7), 16) || 0;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// Some ramps are listed dark→light, some light→dark, some diverging. We
// always want low value = light, high value = dark (confirmed: "highest
// trip should be the darkest"), so reorient by comparing endpoint luminance
// rather than relying on how each list happened to be typed out.
export function orientLightToDark(colors: string[]): string[] {
  if (colors.length < 2) return colors;
  const first = luminance(colors[0]);
  const last = luminance(colors[colors.length - 1]);
  return first < last ? [...colors].reverse() : colors;
}

export function getPalette(id: string): Palette {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0];
}
