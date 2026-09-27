import { Type } from '@sinclair/typebox';

const OPERATION_ID_PATTERN = '^[a-zA-Z0-9_-]{1,128}$';
export const CONTROL_OPERATION_ID = new RegExp(OPERATION_ID_PATTERN);
export const OperationIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: OPERATION_ID_PATTERN,
});
