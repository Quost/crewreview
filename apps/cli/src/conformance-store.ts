import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConformanceResult } from "@crewreview/harness";

/** Results of `doctor --conformance`, per harness and version: a new version has to prove itself again. */
export class ConformanceStore {
  constructor(private readonly file: string) {}

  static in(stateDir: string): ConformanceStore {
    return new ConformanceStore(join(stateDir, "conformance.json"));
  }

  private async all(): Promise<Record<string, ConformanceResult>> {
    try {
      return JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  async get(harness: string, version: string | undefined): Promise<ConformanceResult | undefined> {
    return (await this.all())[`${harness}@${version ?? "?"}`];
  }

  async put(result: ConformanceResult): Promise<void> {
    const all = await this.all();
    all[`${result.harness}@${result.version ?? "?"}`] = result;
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(all, null, 2));
    await Bun.write(this.file, Bun.file(tmp));
  }
}
