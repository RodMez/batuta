import { describe, expect, it } from "vitest";
import { CORE_VERSION, getCoreInfo } from "../src/index.js";

describe("@batuta/core", () => {
  it("expone la versión del núcleo y su información básica", () => {
    expect(CORE_VERSION).toBe("0.1.0");
    const info = getCoreInfo();
    expect(info.name).toBe("@batuta/core");
    expect(info.version).toBe("0.1.0");
  });
});
