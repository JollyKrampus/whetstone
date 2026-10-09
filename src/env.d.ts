/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Root of pipeline output used at build time (CI: "data"). Read by src/lib/datadir.ts via process.env. */
  readonly WHETSTONE_DATA_DIR?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
