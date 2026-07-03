#!/bin/env zx
import "./utils/jsPool.mjs";
import fs from 'fs';
import path from 'path';

process.env.FORCE_COLOR = '3'
chalk.level = 3
$.shell = "/usr/bin/bash"
$.stdio = "inherit"
$.nothrow = true

let previousProc = undefined;
let logStream = undefined;
const ges = argv.ges;
const downloadDir = `data/geo/${ges}`;
const filesMetaData = JSON.parse(fs.readFileSync(`data/metadata/${ges}.json`, 'utf8'));

const threadsNum = argv.p || 16;

// # #########################################################################################

console.log(chalk.blueBright(`GES: ${ges}`));
console.log(chalk.blueBright(`Threads: ${threadsNum}`));
console.log(chalk.blueBright(`Download directory: ${downloadDir}`));

console.log(chalk.blueBright(`Downloading ${filesMetaData.length} files from GEO...`));

let successArray = await Promise.runWithConcurrency({
    taskFunc: async (itemMetaData, currentIndex) => {
        const start = Date.now();
        fs.mkdirSync(`${downloadDir}/.log`, { recursive: true });
        let subProc = undefined;
        let sublogStream = undefined;

        const completeMarker = `${downloadDir}/${itemMetaData.Run}/.complete`
        if (fs.existsSync(completeMarker)) {
            const message = `[subProc] Skip(${currentIndex}, ${itemMetaData.Run}): File already exists and md5 matches.`;
            console.log(chalk.greenBright(message));
            return message;
        }
        console.log(chalk.blueBright(`[subProc] InFo(${currentIndex}, ${itemMetaData.Run}): Downloading...`))
        subProc = $({ stdio: ["inherit", "pipe", "pipe"], quiet: true })`micromamba run -n seqds \
            prefetch \
                -p \
                -c \
                -r yes\
                -C yes\
                --max-size 100GB \
                -O ${downloadDir}/${itemMetaData.Run} \
                ${itemMetaData.Run}`;
        sublogStream = fs.createWriteStream(`${downloadDir}/.log/subProc_${currentIndex}.log`);
        subProc.pipe.stdout(sublogStream);
        subProc.pipe.stderr(sublogStream);
        subProc = await subProc;
        sublogStream.end();
        await new Promise(resolve => sublogStream.on("close", resolve));
        if (subProc.exitCode !== 0) {
            let errMessage = `[subProc] Fail(${currentIndex}, ${itemMetaData.Run}): Failed to download file. Exit code: ${subProc.exitCode}`
            console.log(chalk.redBright(errMessage));
            throw new Error(errMessage);
        }
        fs.writeFileSync(completeMarker, "", { flags: 'w' });
        const duration = (Date.now() - start) / 1000;
        console.log(chalk.greenBright(`[subProc] Success(${currentIndex}, ${itemMetaData.Run}): Downloaded. (Cumsum ${duration.toFixed(2)}s)`));
        return subProc;
    },
    params: filesMetaData,
    maxThreads: threadsNum
})
    .then(results => {
        return results.map((res, i) => {
            console.log(
                `[Summary] (Task ${i}):`,
                res.type == "Fail" ? chalk.redBright(`[Error] Message: ${res.message}`) : chalk.greenBright(`[Success]`)
            );
            if (res.type == "Fail") {
                return undefined;
            }
            return res.data;
        });
    });

successArray = successArray.filter(e => e !== undefined);

if (successArray.length !== filesMetaData.length) {
    console.error(chalk.redBright(`Not all files were downloaded successfully. Expected: ${filesMetaData.length}, Actual: ${successArray.length}`));
    process.exit(1);
}
else {
    console.log(chalk.greenBright(`All files downloaded successfully to ${downloadDir}`));
    process.exit(0);
}