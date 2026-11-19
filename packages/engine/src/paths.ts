import { homedir } from "node:os";
import { join } from "node:path";

export interface AppDirs {
  config: string;
  data: string;
  state: string;
  cache: string;
}

/** Where Crewreview keeps things on each OS. `CREWREVIEW_HOME` puts everything in one folder (tests, portable use). */
export function appDirs(env: Record<string, string | undefined> = process.env, platform = process.platform): AppDirs {
  if (env.CREWREVIEW_HOME) {
    const h = env.CREWREVIEW_HOME;
    return { config: h, data: join(h, "data"), state: join(h, "state"), cache: join(h, "cache") };
  }
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  if (platform === "darwin") {
    const support = join(home, "Library", "Application Support", "Crewreview");
    return {
      config: join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "crewreview"),
      data: support,
      state: join(support, "state"),
      cache: join(home, "Library", "Caches", "Crewreview"),
    };
  }
  if (platform === "win32") {
    const roaming = env.APPDATA ?? join(home, "AppData", "Roaming");
    const local = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return {
      config: join(roaming, "Crewreview"),
      data: join(local, "Crewreview"),
      state: join(local, "Crewreview", "state"),
      cache: join(local, "Crewreview", "cache"),
    };
  }
  return {
    config: join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "crewreview"),
    data: join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "crewreview"),
    state: join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "crewreview"),
    cache: join(env.XDG_CACHE_HOME ?? join(home, ".cache"), "crewreview"),
  };
}

export function configFile(dirs: AppDirs = appDirs()): string {
  return join(dirs.config, "config.toml");
}
