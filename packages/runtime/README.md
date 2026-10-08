# @pix3/runtime

The Pix3 engine. Ships TypeScript sources; projects compile them with their own bundler (Vite).

### Hybrid ECS runtime hooks

The runtime stays scene-graph-first, but now exposes `ECSService` for project-owned ECS worlds.

- `SceneService.getECSService()` returns the active runtime ECS coordinator.
- Systems can register `update` and `fixedUpdate` phases.
- `SceneRunner` executes ECS fixed steps before regular node/script `tick()` calls.

### Instanced rendering bridge

Use `InstancedMesh3D` when ECS data needs to drive large numbers of render instances efficiently.

- Bulk writes support packed matrices or SoA transform arrays.
- GPU uploads are batched until end-of-frame `flush()`.
- Runtime raycasts preserve the owning node and expose `instanceId` for instanced hits.