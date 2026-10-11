/**
 * Node-side view of import.meta for `tsc -p tsconfig.pipeline.json`. src/games/registry.ts reads
 * import.meta.env.BASE_URL, which Vite replaces in site builds; under plain Node (pipeline, scripts)
 * import.meta.env does not exist and the registry falls back to the deployed base. The site build
 * gets the real declaration from astro/client (src/env.d.ts), so this file is only in the pipeline check.
 */
interface ImportMeta {
  readonly env?: { readonly BASE_URL?: string };
}
