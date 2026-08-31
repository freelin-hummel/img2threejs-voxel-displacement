import test from "node:test";
import assert from "node:assert/strict";

import { createVoxelReferenceScene } from "../reference/scene.js";

test("reference scene exposes a SceneProof-compatible scene and camera", async () => {
  const result = await createVoxelReferenceScene({ width: 640, height: 360 });

  assert.equal(result.scene.isScene, true);
  assert.equal(result.camera.isCamera, true);
  assert.equal(result.scene.getObjectByName("voxel-reference-root")?.userData.vxdVersion, 1);
  assert.equal(
    result.scene.getObjectByName("voxel-reference-cubes")?.userData.occupiedCellCount > 0,
    true,
  );
});

test("reference scene consumes final VXD cells without adding displacement", async () => {
  const artifact = {
    kind: "voxel-displacement-data",
    version: 1,
    grid: {
      chunkEdge: 8,
      cellSize: 0.5,
      origin: [-1, -1, -1],
      coordinateSystem: "right-handed-y-up",
      cellOrder: "x-fastest-then-y-then-z",
    },
    attributes: {
      albedo: "rgba8-srgb",
      normal: "octahedral-unorm8x2",
      material: "uint8",
      flags: "uint8",
    },
    chunks: [{
      coordinate: [0, 0, 0],
      cells: [{
        coordinate: [2, 3, 4],
        attributes: { albedo: [32, 96, 160, 255], normal: [0, 1, 0], material: 2, flags: 0 },
      }],
    }],
  };
  const result = await createVoxelReferenceScene({ props: { artifact } });
  const palette = result.scene.getObjectByName("voxel-reference-cubes");
  const mesh = palette?.children[0];
  assert.equal(palette?.userData.occupiedCellCount, 1);
  assert.equal(mesh?.geometry.getAttribute("instanceAlbedo")?.count, 1);
  assert.equal(mesh?.geometry.getAttribute("instanceNormal")?.count, 1);
  assert.deepEqual(mesh?.position.toArray(), [0, 0, 0]);
  const matrix = new (await import("three")).Matrix4();
  mesh.getMatrixAt(0, matrix);
  assert.deepEqual(matrix.elements.slice(12, 15), [0.25, 0.75, 1.25]);
});
