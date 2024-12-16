import { resolve, join, dirname } from "node:path";
import { mkdirSync, renameSync, existsSync, copyFileSync, readdirSync } from "node:fs";
import Logger from "./util/logger";
import * as darwin from "./util/darwin";

const logger = new Logger("core/persist");

export default async function persist(asarPath: string) {
  try {
    hookUpdaterForPersistence(asarPath);
  } catch (e) {
    logger.error(`Failed to persist moonlight: ${e}`);
  }
}

function postPersistSign(bundlePath: string) {
  if (process.platform !== "darwin") {
    logger.error("Ignoring call to postPersistSign because we're not on Darwin");
    return;
  }

  logger.debug("Inferred bundle path:", bundlePath);

  if (darwin.verifySync(bundlePath, { verbosityLevel: 3 })) {
    logger.warn("Bundle is currently passing code signing, no need to sign");
    return;
  } else {
    logger.debug("Bundle no longer passes code signing (this is expected)");
  }

  darwin.signSync(bundlePath, {
    deep: true,
    force: true,
    // TODO: let this be configurable
    identity: "moonlight",
    verbosityLevel: 3
  });

  if (darwin.verifySync(bundlePath, { verbosityLevel: 3 })) {
    logger.info("Bundle signed succesfully!");
  } else {
    logger.error("Bundle didn't pass code signing even after signing, the app might be broken now :(");
  }
}

function hookUpdaterForPersistence(asarPath: string) {
  const updaterModule = require(join(asarPath, "common", "updater"));
  const updater = updaterModule.Updater;

  const currentAppDir = join(dirname(asarPath), "app");

  const realEmit = updater.prototype.emit;
  updater.prototype.emit = function (event: string, ...args: any[]) {
    if (event === "host-updated") {
      const versions = this.queryCurrentVersionsSync();

      const newRootDir = join(this.rootPath, "app-" + versions.current_host.map((v: number) => v.toString()).join("."));
      logger.info(`Persisting moonlight - new root dir: ${newRootDir}`);

      const newResources = join(newRootDir, "resources");

      // app.asar -> _app.asar
      const newAsar = join(newResources, "app.asar");
      const newRenamedAsar = join(newResources, "_app.asar");
      if (!existsSync(newRenamedAsar)) renameSync(newAsar, newRenamedAsar);

      // copy the already existing app dir so we don't have to figure out the moonlight dir
      const newAppDir = join(newResources, "app");
      if (!existsSync(newAppDir)) mkdirSync(newAppDir);

      for (const file of readdirSync(currentAppDir)) {
        copyFileSync(join(currentAppDir, file), join(newAppDir, file));
      }

      // on darwin, making changes disrupted the code signature on the app
      // bundle, so we need to re-sign
      if (process.platform === "darwin") {
        // the asar is at Discord.app/Contents/Resources/app.asar
        const inferredBundlePath = resolve(join(dirname(asarPath), "..", ".."));
        postPersistSign(inferredBundlePath);
      }
    }

    return realEmit.call(this, event, ...args);
  };
}
