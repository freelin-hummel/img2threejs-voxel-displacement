import * as THREE from "three";

const CHUNK_EDGE = 8;
const DEFAULT_CELL_SIZE = 0.125;

function finite(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normaliseNormal(value) {
  const x = finite(value?.[0], 0);
  const y = finite(value?.[1], 0);
  const z = finite(value?.[2], 1);
  const length = Math.hypot(x, y, z) || 1;
  return new THREE.Vector3(x / length, y / length, z / length);
}

function normaliseColor(value) {
  const channels = Array.isArray(value) ? value : [190, 190, 190, 255];
  return channels.slice(0, 4).map((channel, index) => {
    const fallback = index === 3 ? 255 : 190;
    return Math.max(0, Math.min(255, Math.round(finite(channel, fallback))));
  });
}

function demoDocument() {
  const cells = [];
  const radius = 5.25;
  for (let z = -6; z <= 6; z += 1) {
    for (let y = -6; y <= 6; y += 1) {
      for (let x = -6; x <= 6; x += 1) {
        const distance = Math.hypot(x * 1.05, y, z);
        const shoulder = Math.hypot(x * 0.7, z * 0.85);
        const inBody = distance <= radius && (y > -5 || shoulder < 4.2);
        const inCap = y > 3.1 && distance < 4.8;
        if (!inBody && !inCap) continue;
        const shade = Math.max(58, Math.min(235, Math.round(172 + y * 7 - z * 3)));
        cells.push({
          coordinate: [x + 6, y + 6, z + 6],
          attributes: {
            albedo: [shade, Math.round(shade * 0.68), Math.round(shade * 0.34), 255],
            normal: [x, y * 0.8, z],
            material: 0,
            flags: 0,
          },
        });
      }
    }
  }
  return {
    kind: "voxel-displacement-data",
    version: 1,
    grid: {
      chunkEdge: CHUNK_EDGE,
      cellSize: DEFAULT_CELL_SIZE,
      origin: [-0.875, -0.875, -0.875],
      coordinateSystem: "right-handed-y-up",
      cellOrder: "x-fastest-then-y-then-z",
    },
    attributes: {
      albedo: "rgba8-srgb",
      normal: "octahedral-unorm8x2",
      material: "uint8",
      flags: "uint8",
    },
    chunks: [{ coordinate: [0, 0, 0], cells }],
  };
}

function documentFromProps(props) {
  const candidate = props?.artifact?.vxd ?? props?.artifact ?? props?.vxd ?? props;
  return candidate?.kind === "voxel-displacement-data" && Array.isArray(candidate.chunks)
    ? candidate
    : demoDocument();
}

function occupiedCells(document) {
  const origin = document.grid?.origin ?? [0, 0, 0];
  const cellSize = finite(document.grid?.cellSize, DEFAULT_CELL_SIZE);
  const chunkEdge = finite(document.grid?.chunkEdge, CHUNK_EDGE);
  const cells = [];
  for (const chunk of document.chunks ?? []) {
    const chunkCoordinate = chunk.coordinate ?? [0, 0, 0];
    for (const cell of chunk.cells ?? []) {
      const local = cell.coordinate ?? [0, 0, 0];
      const coordinate = [
        finite(chunkCoordinate[0], 0) * chunkEdge + finite(local[0], 0),
        finite(chunkCoordinate[1], 0) * chunkEdge + finite(local[1], 0),
        finite(chunkCoordinate[2], 0) * chunkEdge + finite(local[2], 0),
      ];
      cells.push({
        position: new THREE.Vector3(
          finite(origin[0], 0) + (coordinate[0] + 0.5) * cellSize,
          finite(origin[1], 0) + (coordinate[1] + 0.5) * cellSize,
          finite(origin[2], 0) + (coordinate[2] + 0.5) * cellSize,
        ),
        color: normaliseColor(cell.attributes?.albedo),
        normal: normaliseNormal(cell.attributes?.normal),
      });
    }
  }
  return { cells, cellSize };
}

function makeVoxelMesh(document) {
  const { cells, cellSize } = occupiedCells(document);
  const geometry = new THREE.BoxGeometry(cellSize, cellSize, cellSize);
  const material = new THREE.MeshStandardMaterial({
    color: 0xc28d54,
    roughness: 0.82,
    metalness: 0.04,
    flatShading: true,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, cells.length));
  mesh.name = "voxel-reference-cubes";
  mesh.userData.sceneproofId = "voxel-reference-cubes";
  const transform = new THREE.Object3D();
  const instanceAlbedo = new Float32Array(Math.max(1, cells.length) * 4);
  const instanceNormals = new Float32Array(Math.max(1, cells.length) * 3);
  for (let index = 0; index < cells.length; index += 1) {
    transform.position.copy(cells[index].position);
    transform.updateMatrix();
    mesh.setMatrixAt(index, transform.matrix);
    instanceAlbedo[index * 4] = cells[index].color[0] / 255;
    instanceAlbedo[index * 4 + 1] = cells[index].color[1] / 255;
    instanceAlbedo[index * 4 + 2] = cells[index].color[2] / 255;
    instanceAlbedo[index * 4 + 3] = cells[index].color[3] / 255;
    instanceNormals[index * 3] = cells[index].normal.x;
    instanceNormals[index * 3 + 1] = cells[index].normal.y;
    instanceNormals[index * 3 + 2] = cells[index].normal.z;
  }
  if (cells.length === 0) {
    transform.position.set(0, -10000, 0);
    transform.updateMatrix();
    mesh.setMatrixAt(0, transform.matrix);
  }
  mesh.count = Math.max(1, cells.length);
  geometry.setAttribute("instanceAlbedo", new THREE.InstancedBufferAttribute(instanceAlbedo, 4));
  geometry.setAttribute("instanceNormal", new THREE.InstancedBufferAttribute(instanceNormals, 3));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.userData.occupiedCellCount = cells.length;
  mesh.userData.cellSize = cellSize;
  mesh.userData.albedoAttribute = "instanceAlbedo (sRGB RGBA8 normalized)";
  mesh.userData.normalAttribute = "instanceNormal";
  return mesh;
}

/**
 * SceneProof-compatible source export and the reference scene used by the manual browser page.
 * It is deliberately an InstancedMesh proxy renderer: CPU voxelization is authoritative for cell
 * placement, while GPU traversal and WebGPU acceleration remain a later milestone.
 */
export async function createVoxelReferenceScene({ width = 1280, height = 720, props = {} } = {}) {
  const document = documentFromProps(props);
  const scene = new THREE.Scene();
  scene.name = "voxel-reference-scene";
  scene.background = new THREE.Color("#10141c");

  const root = new THREE.Group();
  root.name = "voxel-reference-root";
  root.userData.sceneproofId = "voxel-reference-root";
  root.userData.vxdKind = document.kind;
  root.userData.vxdVersion = document.version;
  root.add(makeVoxelMesh(document));
  scene.add(root);

  scene.add(new THREE.HemisphereLight(0xbfd7ff, 0x283040, 2.4));
  const key = new THREE.DirectionalLight(0xffe2bd, 2.2);
  key.position.set(3, 6, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x7aa7ff, 0.8);
  fill.position.set(-4, 1, -3);
  scene.add(fill);
  scene.add(new THREE.AmbientLight(0x6f86aa, 1.1));

  const camera = new THREE.PerspectiveCamera(34, width / Math.max(1, height), 0.01, 1000);
  camera.position.set(2.8, 2.4, 3.8);
  camera.lookAt(0, 0, 0);

  const rotate = (timeMs) => {
    root.rotation.y = (finite(timeMs, 0) / 5000) * Math.PI * 2;
    root.updateMatrixWorld(true);
  };
  return {
    scene,
    camera,
    ready: Promise.resolve(),
    seek: async (timeMs) => rotate(timeMs),
    actions: { reset: async () => rotate(0) },
  };
}
