/**
 * `<prefix>-<ms>-<random>`: the id of a node or component the editor creates. The random part
 * keeps two made in the same millisecond (a multi-add, a duplicate) apart.
 */
export const uniqueId = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

/** A new component instance id on `nodeId` (`box-core:spin-…`). */
export const newComponentId = (nodeId: string, componentType: string): string =>
  uniqueId(`${nodeId}-${componentType}`);
