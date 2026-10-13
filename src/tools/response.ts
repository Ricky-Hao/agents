import { types } from 'node:util';
import type { PTCToolResult } from '@/types';

type Result = Pick<PTCToolResult, 'result' | 'is_error' | 'error_message'>;
const INSPECTION_ERROR = 'Tool response could not be inspected safely.';
/** Inspection budget only; larger content is preserved without flattening. */
const MAX_CONTENT_BLOCKS = 4096;

function read(value: unknown, key: PropertyKey): unknown {
  if (value == null || typeof value !== 'object') return undefined;
  if (types.isProxy(value)) throw new Error(INSPECTION_ERROR);
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor == null) return undefined;
  if (!('value' in descriptor)) throw new Error(INSPECTION_ERROR);
  return descriptor.value;
}

function array(value: unknown): value is unknown[] {
  if (value != null && typeof value === 'object' && types.isProxy(value)) {
    throw new Error(INSPECTION_ERROR);
  }
  return Array.isArray(value);
}

function messageFields(value: unknown): object | undefined {
  let fields: unknown;
  if (
    read(value, 'type') === 'tool' &&
    read(value, 'lc_direct_tool_output') === true
  ) {
    fields = value;
  } else if (read(value, 'lc') === 1 && read(value, 'type') === 'constructor') {
    const id = read(value, 'id');
    if (
      !array(id) ||
      id.length !== 3 ||
      read(id, '0') !== 'langchain_core' ||
      read(id, '1') !== 'messages' ||
      read(id, '2') !== 'ToolMessage'
    )
      return undefined;
    fields = read(value, 'kwargs');
  }
  if (
    fields == null ||
    typeof fields !== 'object' ||
    typeof read(fields, 'tool_call_id') !== 'string'
  )
    return undefined;
  const content = read(fields, 'content');
  if (typeof content !== 'string' && !array(content)) return undefined;
  return fields;
}

function protocolError(value: unknown, mcp: boolean): boolean {
  const fields = messageFields(value);
  if (fields != null) return read(fields, 'status') === 'error';
  if (!mcp) return false;
  if (read(value, 'isError') === true && array(read(value, 'content')))
    return true;
  if (read(value, 'jsonrpc') !== '2.0' || read(value, 'result') !== undefined)
    return false;
  const id = read(value, 'id');
  const error = read(value, 'error');
  return (
    (id === null || typeof id === 'string' || typeof id === 'number') &&
    Number.isInteger(read(error, 'code')) &&
    typeof read(error, 'message') === 'string'
  );
}

function parseText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return text;
  }
}

function textContent(value: unknown): string | undefined {
  if (!array(value)) {
    return read(value, 'type') === 'text' &&
      typeof read(value, 'text') === 'string'
      ? (read(value, 'text') as string)
      : undefined;
  }
  if (value.length === 0 || value.length > MAX_CONTENT_BLOCKS) return undefined;
  const texts: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const block = read(value, String(index));
    if (read(block, 'type') !== 'text') return undefined;
    const text = read(block, 'text');
    if (typeof text !== 'string') return undefined;
    texts.push(text);
  }
  return texts.join('\n');
}

/** Only the legacy empty artifact carriers may be omitted. */
function emptyArtifact(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value !== 'object' || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length === 0) return true;
  if (keys.length !== 1 || keys[0] !== 'artifacts') return false;
  const artifacts = read(value, 'artifacts');
  return array(artifacts) && artifacts.length === 0;
}

function messageContent(value: unknown): unknown {
  const fields = messageFields(value);
  if (fields == null) return value;
  const status = read(fields, 'status');
  if (status != null && status !== 'success') return value;
  if (!emptyArtifact(read(fields, 'artifact'))) return value;
  return read(fields, 'content');
}

/**
 * Adapts only known transport envelopes. Tool text, business records and
 * structuredContent are never recursively interpreted as protocol status.
 * Error payloads remain intact; summaries deliberately contain no tool content.
 */
export function normalizeProgrammaticToolResponse(
  value: unknown,
  mcp = false
): Result {
  try {
    // Only an explicit protocol envelope in the first pair position carries status;
    // the artifact may itself have a `type` without making this a content-block array.
    const tuple = mcp && array(value) && value.length === 2;
    const first = tuple ? read(value, '0') : undefined;
    if (protocolError(value, mcp) || (tuple && protocolError(first, mcp))) {
      return {
        result: value,
        is_error: true,
        error_message: 'Tool reported an error.',
      };
    }
    if (!mcp) return { result: value, is_error: false };
    const fields = messageFields(value);
    if (fields != null)
      return { result: messageContent(value), is_error: false };
    // Preserve opaque CallToolResult objects, including structuredContent/_meta.
    if (!array(value)) {
      const text = textContent(value);
      return {
        result: text === undefined ? value : parseText(text),
        is_error: false,
      };
    }
    const text = textContent(value);
    if (text !== undefined) return { result: parseText(text), is_error: false };
    // Content blocks are not tuples, and rich arrays must not lose later blocks.
    if (
      value.length !== 2 ||
      typeof read(read(value, '1'), 'type') === 'string' ||
      !emptyArtifact(read(value, '1'))
    ) {
      return { result: value, is_error: false };
    }
    const content = read(value, '0');
    if (messageFields(content) != null)
      return { result: messageContent(content), is_error: false };
    if (typeof content === 'string')
      return { result: parseText(content), is_error: false };
    const innerText = textContent(content);
    if (innerText !== undefined)
      return { result: parseText(innerText), is_error: false };
    if (array(content)) return { result: value, is_error: false };
    return { result: content, is_error: false };
  } catch {
    return { result: null, is_error: true, error_message: INSPECTION_ERROR };
  }
}
