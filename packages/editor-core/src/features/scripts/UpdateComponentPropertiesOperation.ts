import type {
  Operation,
  OperationCommit,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import { UpdateComponentPropertyOperation } from './UpdateComponentPropertyOperation';

export interface UpdateComponentPropertiesParams {
  nodeId: string;
  componentId: string;
  /** Each property's new value, applied in order. */
  values: ReadonlyArray<{ propertyName: string; value: unknown }>;
  /** History label (default "Update N properties"). */
  label?: string;
}

/**
 * Several properties of one component as ONE undo step — the inspector's "Revert N changes".
 * Each entry runs the single-property operation (same coercion, validation and dirty marking);
 * undo walks them back in reverse.
 */
export class UpdateComponentPropertiesOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'scripts.update-component-properties',
    title: 'Update Component Properties',
    description: 'Update several script component properties on a node as one step',
    affectsNodeStructure: false,
    tags: ['scripts', 'component', 'property'],
  };

  constructor(private readonly params: UpdateComponentPropertiesParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const commits: OperationCommit[] = [];
    for (const entry of this.params.values) {
      const result = await new UpdateComponentPropertyOperation({
        nodeId: this.params.nodeId,
        componentId: this.params.componentId,
        propertyName: entry.propertyName,
        value: entry.value,
      }).perform(context);
      if (result.didMutate && result.commit) {
        commits.push(result.commit);
      }
    }
    if (commits.length === 0) {
      return { didMutate: false };
    }
    return {
      didMutate: true,
      commit: {
        label: this.params.label ?? `Update ${commits.length} properties`,
        beforeSnapshot: context.snapshot,
        undo: async () => {
          for (const commit of [...commits].reverse()) await commit.undo();
        },
        redo: async () => {
          for (const commit of commits) await commit.redo();
        },
      },
    };
  }
}
