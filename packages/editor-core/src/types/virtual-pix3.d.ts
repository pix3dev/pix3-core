// Virtual modules the editor imports from `@pix3/vite-plugin` (externals of the dist build).

declare module 'virtual:pix3/spine-loader' {
  /** The optional Spine runtime, or null when the project does not install it (plan §B.2). */
  export const loadSpine: () => Promise<unknown>;
}
