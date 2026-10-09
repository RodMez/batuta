export const CORE_VERSION = "0.1.0";

export interface CoreInfo {
  name: string;
  version: string;
}

export function getCoreInfo(): CoreInfo {
  return {
    name: "@batuta/core",
    version: CORE_VERSION,
  };
}
