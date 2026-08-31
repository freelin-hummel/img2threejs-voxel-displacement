import {
  VXD_ATTRIBUTE_ENCODING,
  VXD_CELL_ORDER,
  VXD_CHUNK_CELL_COUNT,
  VXD_CHUNK_EDGE,
  VXD_COORDINATE_SYSTEM,
  VXD_KIND,
  VXD_VERSION,
  type VxdChunkV1,
  type VxdDocumentV1,
} from "./contracts.js";

export type VxdValidationSeverity = "error" | "warning";

export interface VxdValidationIssue {
  readonly severity: VxdValidationSeverity;
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface VxdValidationResult {
  readonly ok: boolean;
  readonly errors: readonly VxdValidationIssue[];
  readonly warnings: readonly VxdValidationIssue[];
}

export class VxdValidationError extends Error {
  readonly issues: readonly VxdValidationIssue[];

  constructor(message: string, issues: readonly VxdValidationIssue[]) {
    super(message);
    this.name = "VxdValidationError";
    this.issues = issues;
  }
}

type MutableValidation = {
  errors: VxdValidationIssue[];
  warnings: VxdValidationIssue[];
};

const INT32_MIN = -0x8000_0000;
const INT32_MAX = 0x7fff_ffff;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(
  target: MutableValidation,
  severity: VxdValidationSeverity,
  code: string,
  path: string,
  message: string,
): void {
  target[severity === "error" ? "errors" : "warnings"].push({ severity, code, path, message });
}

function validateTuple(
  value: unknown,
  path: string,
  target: MutableValidation,
  predicate: (item: number) => boolean,
  message: string,
): value is readonly [number, number, number] {
  if (
    !Array.isArray(value)
    || value.length !== 3
    || value.some((item) => typeof item !== "number" || !Number.isFinite(item) || !predicate(item))
  ) {
    issue(target, "error", "invalid-vector", path, message);
    return false;
  }
  return true;
}

function validateByteTuple(value: unknown, path: string, target: MutableValidation): boolean {
  if (
    !Array.isArray(value)
    || value.length !== 4
    || value.some((item) => !Number.isInteger(item) || item < 0 || item > 255)
  ) {
    issue(target, "error", "invalid-rgba8", path, "must be four integer channels from 0 to 255");
    return false;
  }
  return true;
}

function validateAttributes(value: unknown, path: string, target: MutableValidation): void {
  if (!isRecord(value)) {
    issue(target, "error", "invalid-attributes", path, "must be an attribute object");
    return;
  }

  validateByteTuple(value.albedo, `${path}.albedo`, target);
  if (validateTuple(
    value.normal,
    `${path}.normal`,
    target,
    () => true,
    "must be a finite three-component unit vector",
  )) {
    const [x, y, z] = value.normal;
    const length = Math.hypot(x, y, z);
    if (length === 0 || Math.abs(length - 1) > 1e-4) {
      issue(
        target,
        "error",
        "non-unit-normal",
        `${path}.normal`,
        `must have unit length within 1e-4; received ${length}`,
      );
    }
  }

  if ("displacement" in value) {
    issue(
      target,
      "error",
      "unsupported-displacement",
      `${path}.displacement`,
      "is not a VXD v1 cell attribute; displacement inputs must be resolved into final occupied coordinates",
    );
  }
  if (!Number.isInteger(value.material) || Number(value.material) < 0 || Number(value.material) > 255) {
    issue(
      target,
      "error",
      "invalid-material",
      `${path}.material`,
      "must be an unsigned 8-bit material slot from 0 to 255",
    );
  }
  if (!Number.isInteger(value.flags) || Number(value.flags) < 0 || Number(value.flags) > 255) {
    issue(
      target,
      "error",
      "invalid-flags",
      `${path}.flags`,
      "must be an unsigned 8-bit flag field from 0 to 255",
    );
  }
}

function chunkKey(value: readonly number[]): string {
  return `${value[0]},${value[1]},${value[2]}`;
}

function validateChunkInto(value: unknown, path: string, target: MutableValidation): void {
  if (!isRecord(value)) {
    issue(target, "error", "invalid-chunk", path, "must be a chunk object");
    return;
  }

  validateTuple(
    value.coordinate,
    `${path}.coordinate`,
    target,
    (item) => Number.isInteger(item) && item >= INT32_MIN && item <= INT32_MAX,
    "must contain three signed 32-bit integers",
  );

  if (!Array.isArray(value.cells)) {
    issue(target, "error", "invalid-cells", `${path}.cells`, "must be an array");
    return;
  }
  if (value.cells.length > VXD_CHUNK_CELL_COUNT) {
    issue(
      target,
      "error",
      "chunk-overflow",
      `${path}.cells`,
      `cannot contain more than ${VXD_CHUNK_CELL_COUNT} occupied cells`,
    );
  }
  if (value.cells.length === 0) {
    issue(target, "warning", "empty-chunk", `${path}.cells`, "empty chunks are valid but need not be stored");
  }

  const occupied = new Set<string>();
  value.cells.forEach((cell, cellIndex) => {
    const cellPath = `${path}.cells[${cellIndex}]`;
    if (!isRecord(cell)) {
      issue(target, "error", "invalid-cell", cellPath, "must be an occupied-cell object");
      return;
    }
    if (validateTuple(
      cell.coordinate,
      `${cellPath}.coordinate`,
      target,
      (item) => Number.isInteger(item) && item >= 0 && item < VXD_CHUNK_EDGE,
      `must contain three integers from 0 to ${VXD_CHUNK_EDGE - 1}`,
    )) {
      const key = chunkKey(cell.coordinate);
      if (occupied.has(key)) {
        issue(target, "error", "duplicate-cell", `${cellPath}.coordinate`, `duplicates occupied cell ${key}`);
      }
      occupied.add(key);
    }
    validateAttributes(cell.attributes, `${cellPath}.attributes`, target);
  });
}

function resultOf(target: MutableValidation): VxdValidationResult {
  return {
    ok: target.errors.length === 0,
    errors: target.errors,
    warnings: target.warnings,
  };
}

export function validateChunkV1(value: unknown): VxdValidationResult {
  const target: MutableValidation = { errors: [], warnings: [] };
  validateChunkInto(value, "chunk", target);
  return resultOf(target);
}

export function assertValidChunkV1(value: unknown): asserts value is VxdChunkV1 {
  const result = validateChunkV1(value);
  if (!result.ok) {
    throw new VxdValidationError(
      `invalid VXD v1 chunk: ${result.errors.map((entry) => `${entry.path}: ${entry.message}`).join("; ")}`,
      result.errors,
    );
  }
}

function validateLiteral(
  value: unknown,
  expected: unknown,
  code: string,
  path: string,
  target: MutableValidation,
): void {
  if (value !== expected) {
    issue(target, "error", code, path, `must be ${JSON.stringify(expected)}`);
  }
}

export function validateDocumentV1(value: unknown): VxdValidationResult {
  const target: MutableValidation = { errors: [], warnings: [] };
  if (!isRecord(value)) {
    issue(target, "error", "invalid-document", "document", "must be an object");
    return resultOf(target);
  }

  validateLiteral(value.kind, VXD_KIND, "invalid-kind", "document.kind", target);
  validateLiteral(value.version, VXD_VERSION, "invalid-version", "document.version", target);

  if (!isRecord(value.grid)) {
    issue(target, "error", "invalid-grid", "document.grid", "must be an object");
  } else {
    validateLiteral(value.grid.chunkEdge, VXD_CHUNK_EDGE, "invalid-chunk-edge", "document.grid.chunkEdge", target);
    validateLiteral(
      value.grid.coordinateSystem,
      VXD_COORDINATE_SYSTEM,
      "invalid-coordinate-system",
      "document.grid.coordinateSystem",
      target,
    );
    validateLiteral(value.grid.cellOrder, VXD_CELL_ORDER, "invalid-cell-order", "document.grid.cellOrder", target);
    if (typeof value.grid.cellSize !== "number" || !Number.isFinite(value.grid.cellSize) || value.grid.cellSize <= 0) {
      issue(target, "error", "invalid-cell-size", "document.grid.cellSize", "must be a positive finite number");
    }
    validateTuple(
      value.grid.origin,
      "document.grid.origin",
      target,
      () => true,
      "must contain three finite numbers",
    );
  }

  if (!isRecord(value.attributes)) {
    issue(target, "error", "invalid-encoding", "document.attributes", "must be an object");
  } else {
    for (const [channel, encoding] of Object.entries(VXD_ATTRIBUTE_ENCODING)) {
      validateLiteral(
        value.attributes[channel],
        encoding,
        "invalid-encoding",
        `document.attributes.${channel}`,
        target,
      );
    }
  }

  if (!Array.isArray(value.chunks)) {
    issue(target, "error", "invalid-chunks", "document.chunks", "must be an array");
    return resultOf(target);
  }
  if (value.chunks.length === 0) {
    issue(target, "warning", "empty-document", "document.chunks", "a document with no chunks contains no surface data");
  }

  const coordinates = new Set<string>();
  let previous: readonly number[] | undefined;
  value.chunks.forEach((chunk, index) => {
    const path = `document.chunks[${index}]`;
    validateChunkInto(chunk, path, target);
    if (!isRecord(chunk) || !Array.isArray(chunk.coordinate) || chunk.coordinate.length !== 3) return;
    const tuple = chunk.coordinate;
    if (!tuple.every(
      (item) => typeof item === "number"
        && Number.isFinite(item)
        && Number.isInteger(item)
        && item >= INT32_MIN
        && item <= INT32_MAX,
    )) return;
    const coordinate = tuple as [number, number, number];
    const key = chunkKey(coordinate);
    if (coordinates.has(key)) {
      issue(target, "error", "duplicate-chunk", `${path}.coordinate`, `duplicates chunk coordinate ${key}`);
    }
    coordinates.add(key);
    if (previous !== undefined) {
      const [x, y, z] = coordinate;
      const previousX = previous[0]!;
      const previousY = previous[1]!;
      const previousZ = previous[2]!;
      const canonical = z > previousZ
        || (z === previousZ && y > previousY)
        || (z === previousZ && y === previousY && x >= previousX);
      if (!canonical) {
        issue(
          target,
          "warning",
          "noncanonical-chunk-order",
          path,
          "chunks should be ordered by z, then y, then x for stable document serialization",
        );
      }
    }
    previous = coordinate;
  });

  return resultOf(target);
}

export function assertValidDocumentV1(value: unknown): asserts value is VxdDocumentV1 {
  const result = validateDocumentV1(value);
  if (!result.ok) {
    throw new VxdValidationError(
      `invalid VXD v1 document: ${result.errors.map((entry) => `${entry.path}: ${entry.message}`).join("; ")}`,
      result.errors,
    );
  }
}
