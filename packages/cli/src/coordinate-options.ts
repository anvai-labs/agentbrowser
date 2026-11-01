import { type CoordinatePoint, parseCoordinatePoint } from '@agentbrowser/protocol';
import { UsageError } from '@agentbrowser/sdk-typescript';
import type { Command } from 'commander';
export interface CoordinateOptions {
  at?: string;
  capture?: string;
  imageSize?: string;
}
export function withCoordinateOptions(command: Command): Command {
  return command
    .option('--at <x,y>', 'explicit viewport CSS point; one-use action approval required')
    .option('--capture <id>', 'use pixels from this recent viewport PNG; requires --image-size')
    .option('--image-size <width,height>', 'exact delivered PNG dimensions; requires --capture');
}
export function coordinatePoint(options: CoordinateOptions): CoordinatePoint | undefined {
  if (options.at === undefined) {
    if (options.capture !== undefined || options.imageSize !== undefined)
      throw new UsageError('Image coordinates require --at');
    return undefined;
  }
  if ((options.capture === undefined) !== (options.imageSize === undefined))
    throw new UsageError('--capture and --image-size must be paired');
  const pair = (value: string) => {
    if (!/^\d+(?:\.\d+)?,\d+(?:\.\d+)?$/.test(value))
      throw new UsageError(
        'Coordinates and dimensions require two nonnegative finite numbers separated by a comma'
      );
    return value.split(',').map(Number) as [number, number];
  };
  const [x, y] = pair(options.at);
  try {
    if (options.capture !== undefined && options.imageSize !== undefined) {
      const [rasterWidth, rasterHeight] = pair(options.imageSize);
      return parseCoordinatePoint({
        unit: 'image',
        x,
        y,
        captureId: options.capture,
        rasterWidth,
        rasterHeight,
      });
    }
    return parseCoordinatePoint({ unit: 'css', x, y });
  } catch {
    throw new UsageError('Invalid coordinate point or screenshot dimensions');
  }
}
