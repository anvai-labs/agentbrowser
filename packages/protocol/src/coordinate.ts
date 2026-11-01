import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const position = Type.Number({ minimum: 0, maximum: 65536 });
const dimension = Type.Number({ exclusiveMinimum: 0, maximum: 65536 });
export const ViewportCaptureSchema = Type.Object(
  {
    captureId: Type.String({ minLength: 1, maxLength: 128 }),
    createdAt: Type.Number({ minimum: 0 }),
    kind: Type.Literal('viewport-png'),
    cssWidth: dimension,
    cssHeight: dimension,
    rasterWidth: Type.Integer({ minimum: 1, maximum: 65536 }),
    rasterHeight: Type.Integer({ minimum: 1, maximum: 65536 }),
    devicePixelRatio: Type.Number({ exclusiveMinimum: 0, maximum: 32 }),
    pageZoom: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 10 })),
    visualScale: Type.Number({ exclusiveMinimum: 0, maximum: 10 }),
    visualOffsetX: Type.Number(),
    visualOffsetY: Type.Number(),
    scrollX: Type.Number(),
    scrollY: Type.Number(),
  },
  { additionalProperties: false }
);
export type ViewportCapture = Static<typeof ViewportCaptureSchema>;
export function parseViewportCapture(input: unknown): ViewportCapture {
  if (!Value.Check(ViewportCaptureSchema, input)) throw new Error('Invalid viewport capture');
  return { ...input };
}
export const CoordinatePointSchema = Type.Union([
  Type.Object(
    { unit: Type.Literal('css'), x: position, y: position },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      unit: Type.Literal('image'),
      x: position,
      y: position,
      captureId: Type.String({ minLength: 1, maxLength: 128 }),
      rasterWidth: Type.Integer({ minimum: 1, maximum: 65536 }),
      rasterHeight: Type.Integer({ minimum: 1, maximum: 65536 }),
    },
    { additionalProperties: false }
  ),
]);
export type CoordinatePoint = Static<typeof CoordinatePointSchema>;
export function parseCoordinatePoint(input: unknown): CoordinatePoint {
  if (!Value.Check(CoordinatePointSchema, input)) throw new Error('Invalid coordinate point');
  return { ...input };
}
export function mapScreenshotPoint(
  capture: ViewportCapture,
  x: number,
  y: number
): { x: number; y: number } {
  if (
    !Value.Check(ViewportCaptureSchema, capture) ||
    capture.visualScale !== 1 ||
    capture.visualOffsetX !== 0 ||
    capture.visualOffsetY !== 0
  )
    throw new Error('Unqualified viewport transform');
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    y < 0 ||
    x >= capture.rasterWidth ||
    y >= capture.rasterHeight
  )
    throw new Error('Point is outside the delivered viewport image');
  return {
    x: (x * capture.cssWidth) / capture.rasterWidth,
    y: (y * capture.cssHeight) / capture.rasterHeight,
  };
}
