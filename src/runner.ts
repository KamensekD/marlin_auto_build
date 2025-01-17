import {mkdir, rm, writeFile, readFile, cp, copyFile} from "fs/promises";
import {randomInt, createHash} from "crypto";
import chalk from "chalk";
import dayjs from "dayjs";
import semver from "semver";
import {getLatestStable, getLatestNightly, createRelease, uploadAsset} from "./github";
import {loadBuilds, BuildSchema} from "./prepare";
import {processBuild} from "./build";
import {registerQuote} from "./quote";
import {downloadStable, downloadNightly} from "./system";

const devMode = process.argv[2] === "--dev";
if (devMode) {
    console.log(chalk.yellow("Running in devMode. Repo will not be modified and releases won't be created"));
}

(async function main() {
    const latestStable = await getLatestStable();
    const latestNightly = await getLatestNightly();
    if (!devMode) {
        await dirSetupBefore();
    }
    await dirSetup();
    registerQuote();
    const builds = await loadBuilds();

    if (Object.keys(builds).length === 0) {
        console.log(chalk.green("nothing to do, bye"));
        return;
    }

    const [ignoreStable, stableBuilds] = await shouldBuild(latestStable, "stable", builds);
    const [ignoreNightly, nightlyBuilds] = await shouldBuild(latestNightly, "nightly", builds);

    if (ignoreStable && ignoreNightly) {
        console.log(chalk.green("nothing to do, bye"));
        return;
    }

    if (!ignoreStable) {
        console.log(chalk.green(`downloading stable ${chalk.underline(latestStable)}`));
        await downloadStable(latestStable);
        await doBuild(latestStable, "stable", stableBuilds);

    }

    if (!ignoreNightly) {
        console.log(chalk.green(`downloading nightly ${chalk.underline(latestNightly)}`));
        await downloadNightly();
        await doBuild(latestNightly, "nightly", nightlyBuilds);
    }

    if (!devMode) {
        await dirSetupAfter();
    }

    console.log(chalk.green("all done!"));
})().catch(function(err) {
    console.error(chalk.red(err.message));
    process.exit(1);
});

// copies the trackers + builds from the main repo
async function dirSetupBefore() {
    try {
        await copyFile("../last_stable.json", "./last_stable.json");
    } catch (_e) {} // eslint-disable-line
    try {
        await copyFile("../last_nightly.json", "./last_nightly.json");
    } catch (_e) {} // eslint-disable-line
    await cp("../builds", "./builds", {recursive: true});
}

async function dirSetup() {
    try {
        await rm("./dist", {recursive: true, force: true});
    } catch (_e) {} // eslint-disable-line
    await mkdir("./dist");
    await mkdir("./dist/assets");
}

// copies back the updated trackers + autoGeneratedConfigs to the main repo
async function dirSetupAfter() {
    try {
        await copyFile("./last_stable.json", "../last_stable.json");
    } catch (_e) {} // eslint-disable-line
    try {
        await copyFile("./last_nightly.json", "../last_nightly.json");
    } catch (_e) {} // eslint-disable-line
    await cp("./autogeneratedConfigs", "../autogeneratedConfigs", {recursive: true});
}

type BuildDefs = {
    [key: string]: {
        version: string,
        md5: string,
        build: BuildSchema,
        action: "create" | "update" | "ignore",
        assetId?: number
    }
};

async function shouldBuild(
    latestVersion: string,
    kind: "stable" | "nightly",
    loadedBuilds: {[key: string]: BuildSchema}
): Promise<[boolean, BuildDefs]> {
    const newBuilds: BuildDefs = {};
    try {
        console.log(chalk.green(`checking builds for ${chalk.underline(kind)} release`));
        const trackedBuilds: {[key: string]: {version: string, md5: string, assetId: number}} = require(`../last_${kind}.json`);
        for (const [buildName, loadedBuild] of Object.entries(loadedBuilds)) {
            const hash = createHash("md5");
            hash.update(await readFile(buildName));
            const md5 = hash.digest("hex");
            //skip disabled builds
            if (loadedBuild.active === false || (loadedBuild.only && loadedBuild.only !== kind)) {
                //If they were enabled before we don't want to lose their info so we still need to add them to the tracker
                newBuilds[buildName] = {
                    version: latestVersion,
                    md5,
                    build: loadedBuild,
                    action: "ignore",
                    //can be undefined
                    assetId: trackedBuilds[buildName].assetId
                };
                console.log(chalk.cyan(`[disabled] ${chalk.underline(buildName)}`));
                continue;
            }
            //skip versions less than min_version if set (only in stable)
            if (kind === "stable" && loadedBuild.min_version) {
                if (!semver.valid(loadedBuild.min_version)) {
                    throw new Error(`${buildName}->min_version: ${loadedBuild.min_version} is not a valid semver string`);
                }
                //marlin versions have an extra digit which we have to remove to be valid semver (2.1.1.1 -> 2.1.1)
                const parsedLatest = semver.coerce(latestVersion);
                if (parsedLatest && semver.lt(parsedLatest, loadedBuild.min_version)) {
                    console.log(chalk.cyan(`[ignored] ${chalk.underline(buildName)}`));
                    continue;
                }
            }
            if (!trackedBuilds[buildName]) {
                //it's a new build
                newBuilds[buildName] = {version: latestVersion, md5, build: loadedBuild, action: "create"};
                console.log(chalk.cyan(`[new build added] ${chalk.underline(buildName)}`));
            } else if (trackedBuilds[buildName] && trackedBuilds[buildName].version !== latestVersion) {
                //existing build but on older version
                newBuilds[buildName] = {version: latestVersion, md5, build: loadedBuild, action: "create"};
                console.log(chalk.cyan(`[needs update] ${chalk.underline(buildName)}`));
            } else if (trackedBuilds[buildName] && md5 !== trackedBuilds[buildName].md5) {
                //build's schema was changed
                newBuilds[buildName] = {version: latestVersion, md5, build: loadedBuild, action: "update", assetId: trackedBuilds[buildName].assetId};
                console.log(chalk.cyan(`[build changed] ${chalk.underline(buildName)}`));
            } else {
                //up to date
                newBuilds[buildName] = {version: latestVersion, md5, build: loadedBuild, action: "ignore", assetId: trackedBuilds[buildName].assetId};
                console.log(chalk.cyan(`[up-to-date] ${chalk.underline(buildName)}`));
            }
        }
    } catch (_e) {
        //tracker does not exist, probably the first run
        for (const [buildName, loadedBuild] of Object.entries(loadedBuilds)) {
            //skip disabled builds
            if (loadedBuild.active === false || (loadedBuild.only && loadedBuild.only !== kind)) {
                console.log(chalk.cyan(`[disabled] ${chalk.underline(buildName)}`));
                continue;
            }
            //skip versions less than min_version if set (only in stable)
            if (kind === "stable" && loadedBuild.min_version) {
                if (!semver.valid(loadedBuild.min_version)) {
                    throw new Error(`${buildName}->min_version: ${loadedBuild.min_version} is not a valid semver string`);
                }
                //marlin versions have an extra digit which we have to remove to be valid semver (2.1.1.1 -> 2.1.1)
                const parsedLatest = semver.coerce(latestVersion);
                if (parsedLatest && semver.lt(parsedLatest, loadedBuild.min_version)) {
                    console.log(chalk.cyan(`[ignored] ${chalk.underline(buildName)}`));
                    continue;
                }
            }
            const hash = createHash("md5");
            hash.update(await readFile(buildName));
            const md5 = hash.digest("hex");
            newBuilds[buildName] = {version: latestVersion, md5, build: loadedBuild, action: "create"};
            console.log(chalk.cyan(`[new build added] ${chalk.underline(buildName)}`));
        }
    }

    const ignore = Object.values(newBuilds).every(b => b.action === "ignore");

    return [ignore, newBuilds];
}

async function doBuild(latestVersion: string, kind: "stable" | "nightly", buildDefs: BuildDefs) {
    const currentDate = dayjs().format("YYYYMMDD");
    const currentDateTime = dayjs().format("YYYYMMDDHHmm");
    const timestamp = dayjs().unix();
    const assets: {buildName: string, filename: string, buildPath: string, action: "create" | "update", assetId?: number}[] = [];

    for (const [buildName, buildDef] of Object.entries(buildDefs)) {
        if (buildDef.action === "ignore") continue;
        console.log(chalk.green(`building ${chalk.underline(buildName)}`));
        const buildPath = await processBuild(buildName, buildDef.build, kind, latestVersion);
        if (!buildPath) continue;
        let filename = buildDef.build.meta[`${kind}_name`]
            .replace("{{marlin_version}}", latestVersion)
            .replace("{{current_date}}", currentDate)
            .replace("{{timestamp}}", timestamp.toString())
            .replace("{{uid}}", randomInt(100000, 999999).toString());
        if (!filename.endsWith(".bin")) filename += ".bin";
//console.log(`Add asset: buildName:${buildName}, filename:${filename}, buildPath:${buildPath}, assetId:${assetId}`);
console.log(`[@Debug]Add asset: buildName:${buildName}, filename:${filename}, buildPath:${buildPath}`);
        assets.push({buildName, filename, buildPath, action: buildDef.action, assetId: buildDef.assetId});
    }

    if (devMode) return;

    if (assets.length === 0) return;

    console.log(chalk.green("creating release"));
    const uploadUrl = await createRelease(latestVersion, kind, currentDateTime);
console.log(`[@Debug]latestVersion: ${latestVersion}, kind: ${kind}, currentDateTime: ${currentDateTime}`);
console.log(`[@Debug]uploadUrl: "${uploadUrl}"`);
console.log(`[@Debug]uploading: ${assets}`);
    for (const asset of assets) {
        console.log(chalk.green(`uploading ${chalk.underline(asset.filename)}`));
console.log(`[@Debug]uploading: ${asset} buildName:${asset.buildName}, filename:${asset.filename}, buildPath:${asset.buildPath}, assetId:${asset.assetId}`);
        const assetId = await uploadAsset(uploadUrl, asset);
        buildDefs[asset.buildName].assetId = assetId;
console.log(`[@Debug]assetId: ${assetId}`);
    }
    for (const buildDef of Object.values(buildDefs)) {
console.log(`[@Debug]deleting: ${buildDef}`);
        //@ts-ignore
        delete buildDef.build;
        //@ts-ignore
        delete buildDef.action;
    }
console.log(`[@Debug]writing: ./last_${kind}.json`);
    await writeFile(`./last_${kind}.json`, JSON.stringify(buildDefs, null, 4));
}
