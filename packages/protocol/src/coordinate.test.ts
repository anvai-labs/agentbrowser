import { expect, it } from 'vitest';
import { mapScreenshotPoint, parseCoordinatePoint } from './coordinate.js';
import { decodeWireAction } from './wire-action.js';

const capture = {
  captureId: 'cap_1234',
  createdAt: 1,
  cssWidth: 800,
  cssHeight: 600,
  rasterWidth: 1600,
  rasterHeight: 1200,
  devicePixelRatio: 2,
  visualScale: 1,
  visualOffsetX: 0,
  visualOffsetY: 0,
  scrollX: 0,
  scrollY: 100,
  kind: 'viewport-png' as const,
};
it('maps delivered raster pixels once across DPR/page zoom without adding page scroll', () => {
  expect(mapScreenshotPoint(capture, 400, 200)).toEqual({ x: 200, y: 100 });
  expect(mapScreenshotPoint({ ...capture, cssWidth: 640, cssHeight: 480 }, 400, 200)).toEqual({
    x: 160,
    y: 80,
  });
});
it('refuses unqualified pinch/offset, wrong dimensions and out-of-bounds points', () => {
  for (const c of [
    { ...capture, visualScale: 1.2 },
    { ...capture, visualOffsetX: 1 },
    { ...capture, visualOffsetY: 1 },
  ])
    expect(() => mapScreenshotPoint(c, 1, 1)).toThrow();
  for (const [x, y] of [
    [1600, 0],
    [-1, 0],
    [0, 1200],
    [Number.NaN, 0],
  ])
    expect(() => mapScreenshotPoint(capture, x, y)).toThrow();
  expect(() => parseCoordinatePoint({ x: 1, y: 2, unit: 'image', captureId: 'c' })).toThrow();
  expect(() => parseCoordinatePoint({ x: 1, y: 2, unit: 'css', unknown: true })).toThrow();
});
it('keeps semantic refs distinct and requires verified bytes for coordinate upload', () => {
  expect(decodeWireAction({ action: 'clickAt', at: { unit: 'css', x: 20, y: 30 } }).ok).toBe(true);
  expect(
    decodeWireAction({
      action: 'clickAt',
      target: { ref: 'e1_0' },
      at: { unit: 'css', x: 20, y: 30 },
    }).ok
  ).toBe(false);
  expect(
    decodeWireAction({
      action: 'uploadAt',
      at: { unit: 'css', x: 20, y: 30 },
      paths: ['/tmp/a.txt'],
    }).ok
  ).toBe(false);
  expect(
    decodeWireAction({
      action: 'uploadAt',
      at: { unit: 'css', x: 20, y: 30 },
      paths: ['/tmp/a.txt'],
      sha256: 'a'.repeat(64),
    }).ok
  ).toBe(true);
});
