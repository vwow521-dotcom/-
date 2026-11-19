import type { DoorbellKind } from "../doorbells/types.js";

export interface ProductCli {
  packageDir: string;
  node: string;
  proxy: string;
  port: number;
  refresh: boolean;
  project?: string;
  ok(message: string): void;
  bad(message: string): void;
  info(message: string): void;
  writeFile(file: string, content: string, description: string): void;
  removeFile(file: string, description: string): void;
}

export interface ProductProfile {
  readonly ids: readonly string[];
  readonly doorbells: readonly DoorbellKind[];
  readonly setupHint?: string;
  setup(cli: ProductCli): void;
  uninstall(cli: ProductCli): void;
  doctor(cli: ProductCli): void;
}
