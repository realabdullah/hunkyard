export type Tile<T> = { item: T; x: number; y: number; w: number; h: number };

/**
 * Squarified treemap (Bruls, Huizing & van Wijk). Lays `items` into a w×h rectangle with areas
 * proportional to `value`, keeping tiles close to square so small files stay clickable.
 */
export const squarify = <T>(items: T[], value: (item: T) => number, w: number, h: number) => {
  const entries = items
    .map((item) => ({ item, value: Math.max(value(item), 0.0001) }))
    .sort((a, b) => b.value - a.value);
  const total = entries.reduce((sum, entry) => sum + entry.value, 0);
  const scale = (w * h) / (total || 1);
  const tiles: Tile<T>[] = [];
  let rect = { x: 0, y: 0, w, h };
  let row: { item: T; area: number }[] = [];
  const worst = (areas: number[], side: number) => {
    const sum = areas.reduce((a, b) => a + b, 0);
    const max = Math.max(...areas);
    const min = Math.min(...areas);
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };
  const flush = () => {
    const sum = row.reduce((a, entry) => a + entry.area, 0);
    if (!sum) return;
    if (rect.w >= rect.h) {
      const width = sum / rect.h;
      let y = rect.y;
      for (const entry of row) {
        const height = entry.area / width;
        tiles.push({ item: entry.item, x: rect.x, y, w: width, h: height });
        y += height;
      }
      rect = { x: rect.x + width, y: rect.y, w: rect.w - width, h: rect.h };
    } else {
      const height = sum / rect.w;
      let x = rect.x;
      for (const entry of row) {
        const width = entry.area / height;
        tiles.push({ item: entry.item, x, y: rect.y, w: width, h: height });
        x += width;
      }
      rect = { x: rect.x, y: rect.y + height, w: rect.w, h: rect.h - height };
    }
    row = [];
  };
  for (const entry of entries) {
    const area = entry.value * scale;
    const side = Math.min(rect.w, rect.h);
    const current = row.map((cell) => cell.area);
    if (row.length && worst([...current, area], side) > worst(current, side)) flush();
    row.push({ item: entry.item, area });
  }
  flush();
  return tiles;
};
