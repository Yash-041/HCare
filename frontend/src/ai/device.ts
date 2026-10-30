/** What this device can run, used to pick model sizes and backends. */

export interface DeviceProfile {
  webgpu: boolean;
  /** WebGPU with 16-bit float shaders (needed for the q4f16 LLM build). */
  webgpuF16: boolean;
  /** GB, rounded down by the browser (Chrome only; undefined elsewhere). */
  memoryGb: number | undefined;
  cores: number;
  lowEnd: boolean;
}

let cached: Promise<DeviceProfile> | null = null;

export function deviceProfile(): Promise<DeviceProfile> {
  cached ??= (async () => {
    let webgpu = false;
    let webgpuF16 = false;
    try {
      type Adapter = { features: { has(f: string): boolean } };
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<Adapter | null> } }).gpu;
      const adapter = gpu ? await gpu.requestAdapter() : null;
      webgpu = !!adapter;
      webgpuF16 = !!adapter?.features.has("shader-f16");
    } catch {
      webgpu = false;
    }
    const memoryGb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    const cores = navigator.hardwareConcurrency || 2;
    return { webgpu, webgpuF16, memoryGb, cores, lowEnd: (memoryGb !== undefined && memoryGb <= 3) || cores <= 4 };
  })();
  return cached;
}
