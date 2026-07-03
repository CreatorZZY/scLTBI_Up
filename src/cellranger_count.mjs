#!/bin/env zx
import "./utils/jsPool.mjs";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

process.env.FORCE_COLOR = '3'
chalk.level = 3
$.shell = "/usr/bin/bash"
$.stdio = "inherit"
$.nothrow = true

// # ============================================================================
// # Configuration
// # ============================================================================

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CELLRANGER = `${PROJECT_ROOT}/tools/cellranger-10.0.0/bin/cellranger`;
const REFERENCE = `${PROJECT_ROOT}/data/RefDB/GENCODE.v46/GRCh38/cellranger/GRCh38`;
const SRA_DIR = `${PROJECT_ROOT}/data/geo/PRJNA605083`;
const FASTQ_DIR = `${PROJECT_ROOT}/out/PRJNA605083/fastq`;
const RESULTS_DIR = `${PROJECT_ROOT}/out/PRJNA605083/cellranger`;

const THREADS = argv.t || 16;
const MEM_GB = argv.m || 64;
const PARALLEL_FASTQ = argv.parallelFastq || 1; // max parallel SRA→FASTQ conversions

// # ============================================================================
// # Read sample metadata from JSON (source of truth)
// # ============================================================================

const METADATA_FILE = `${PROJECT_ROOT}/data/metadata/PRJNA605083.json`;
const rawMetadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));

/**
 * Derive experimental group from sample name.
 * Pattern: PBMC_{GROUP}_{N}  e.g. "PBMC_HC_1" → "HC"
 */
function deriveGroup(sampleName) {
    const match = sampleName.match(/^PBMC_(HC|LTBI|TB)_\d+$/);
    if (!match) {
        console.warn(chalk.yellowBright(`  WARNING: Cannot derive group from sample name: "${sampleName}"`));
        return "UNKNOWN";
    }
    return match[1];
}

// Build SAMPLES array from metadata JSON
const SAMPLES = rawMetadata.map(record => ({
    sra: record.Run,                        // e.g. "SRR11038989"
    name: record["Sample Name"],             // e.g. "PBMC_TB_3"
    group: deriveGroup(record["Sample Name"]), // e.g. "TB"
}));

// Verify all groups recognized
const unrecognized = SAMPLES.filter(s => s.group === "UNKNOWN");
if (unrecognized.length > 0) {
    console.error(chalk.redBright(`ERROR: ${unrecognized.length} sample(s) have unrecognized group:`));
    unrecognized.forEach(s => console.error(chalk.redBright(`  - ${s.name} (${s.sra})`)));
    process.exit(1);
}

// # ============================================================================
// # Init
// # ============================================================================

fs.mkdirSync(FASTQ_DIR, { recursive: true });
fs.mkdirSync(RESULTS_DIR, { recursive: true });

console.log(chalk.blueBright(`Project root : ${PROJECT_ROOT}`));
console.log(chalk.blueBright(`Reference    : ${REFERENCE}`));
console.log(chalk.blueBright(`Threads      : ${THREADS}`));
console.log(chalk.blueBright(`Memory (GB)  : ${MEM_GB}`));
console.log(chalk.blueBright(`Parallel SRA→FASTQ: ${PARALLEL_FASTQ}`));
console.log(chalk.blueBright(`Samples      : ${SAMPLES.length} (${SAMPLES.map(s => s.name).join(', ')})`));

// Disable telemetry
console.log(chalk.blueBright('[Init] Disabling Cell Ranger telemetry...'));
await $`${CELLRANGER} telemetry disable`.quiet();
console.log(chalk.greenBright('[Init] Telemetry disabled.'));

// # ============================================================================
// # Step 1: SRA → FASTQ (parallel per sample)
// # ============================================================================

console.log(chalk.blueBright('\n=== Phase 1: SRA → FASTQ conversion ==='));

async function sraToFastq(sample, currentIndex) {
    const sraFile = `${SRA_DIR}/${sample.sra}/${sample.sra}/${sample.sra}.sra`;
    const sampleFastqDir = `${FASTQ_DIR}/${sample.name}`;
    const markerFile = `${sampleFastqDir}/.fastq_done`;

    if (fs.existsSync(markerFile)) {
        console.log(chalk.greenBright(`  [${currentIndex + 1}/${SAMPLES.length}] SKIP ${sample.name}: FASTQ already extracted.`));
        return sample;
    }

    console.log(chalk.blueBright(`  [${currentIndex + 1}/${SAMPLES.length}] Extracting ${sample.name} (${sample.sra})...`));

    fs.rmSync(sampleFastqDir, { recursive: true, force: true });
    fs.mkdirSync(sampleFastqDir, { recursive: true });

    // parallel-fastq-dump with direct gzip output
    const fastqProc = $({ stdio: ["inherit", "pipe", "pipe"], quiet: true })`micromamba run -n seqds \
        parallel-fastq-dump \
            --sra-id ${sraFile} \
            -t ${THREADS} \
            -O ${sampleFastqDir} \
            --split-files \
            --gzip`;

    // Pipe logs
    const logDir = `${FASTQ_DIR}/.log`;
    fs.mkdirSync(logDir, { recursive: true });
    const logStream = fs.createWriteStream(`${logDir}/${sample.name}_fastq_dump.log`);
    fastqProc.pipe.stdout(logStream);
    fastqProc.pipe.stderr(logStream);

    fastqProc = await fastqProc;
    logStream.end();
    await new Promise(resolve => logStream.on("close", resolve));

    if (fastqProc.exitCode !== 0) {
        const errMsg = `[FAIL] parallel-fastq-dump failed for ${sample.name} (exit: ${fastqProc.exitCode})`;
        console.log(chalk.redBright(errMsg));
        throw new Error(errMsg);
    }

    // Rename to Cell Ranger convention
    // parallel-fastq-dump outputs: {sra}_1.fastq.gz, {sra}_2.fastq.gz, {sra}_3.fastq.gz
    // Cell Ranger expects: {Sample}_S1_L001_{R1,R2,I1}_001.fastq.gz

    const renames = [
        { from: `${sample.sra}_1.fastq.gz`, to: `${sample.name}_S1_L001_R1_001.fastq.gz` },
        { from: `${sample.sra}_2.fastq.gz`, to: `${sample.name}_S1_L001_R2_001.fastq.gz` },
        { from: `${sample.sra}_3.fastq.gz`, to: `${sample.name}_S1_L001_I1_001.fastq.gz` },
    ];

    for (const { from, to } of renames) {
        const fromPath = `${sampleFastqDir}/${from}`;
        const toPath = `${sampleFastqDir}/${to}`;
        if (fs.existsSync(fromPath)) {
            fs.renameSync(fromPath, toPath);
        } else if (!to.endsWith('I1')) {
            console.log(chalk.yellowBright(`  WARNING: Expected file not found: ${from}`));
        }
    }

    fs.writeFileSync(markerFile, '');
    console.log(chalk.greenBright(`  [${currentIndex + 1}/${SAMPLES.length}] DONE ${sample.name}: FASTQ ready.`));
    return sample;
}

// Run SRA→FASTQ conversions with controlled concurrency
const fastqResults = await Promise.runWithConcurrency({
    taskFunc: sraToFastq,
    params: SAMPLES,
    maxThreads: PARALLEL_FASTQ,
});

console.log(chalk.greenBright('\n=== Phase 1 complete: all FASTQ files extracted. ==='));

// # ============================================================================
// # Step 2: Cell Ranger count (sequential, each sample is resource-heavy)
// # ============================================================================

console.log(chalk.blueBright('\n=== Phase 2: Cell Ranger quantification ==='));

let completedCount = 0;
for (const sample of SAMPLES) {
    completedCount++;
    const resultDir = `${RESULTS_DIR}/${sample.name}`;
    const markerFile = `${resultDir}/_complete`;
    const fastqDir = `${FASTQ_DIR}/${sample.name}`;

    if (fs.existsSync(markerFile)) {
        console.log(chalk.greenBright(`  [${completedCount}/${SAMPLES.length}] SKIP ${sample.name}: Cell Ranger already completed.`));
        continue;
    }

    console.log(chalk.blueBright(`  [${completedCount}/${SAMPLES.length}] Cell Ranger count for ${sample.name} (${sample.group})...`));

    const crProc = $({ stdio: ["inherit", "pipe", "pipe"], quiet: true })`${CELLRANGER} count \
        --id=${sample.name} \
        --transcriptome=${REFERENCE} \
        --fastqs=${fastqDir} \
        --sample=${sample.name} \
        --create-bam=true \
        --localcores=${THREADS} \
        --localmem=${MEM_GB} \
        --output-dir=${RESULTS_DIR} \
        --disable-ui \
        --nopreflight`;

    const logDir = `${RESULTS_DIR}/.log`;
    fs.mkdirSync(logDir, { recursive: true });
    const logStream = fs.createWriteStream(`${logDir}/${sample.name}_cellranger.log`);
    crProc.pipe.stdout(logStream);
    crProc.pipe.stderr(logStream);

    crProc = await crProc;
    logStream.end();
    await new Promise(resolve => logStream.on("close", resolve));

    if (crProc.exitCode !== 0) {
        const errMsg = `[FAIL] Cell Ranger count failed for ${sample.name} (exit: ${crProc.exitCode})`;
        console.log(chalk.redBright(errMsg));
        throw new Error(errMsg);
    }

    fs.writeFileSync(markerFile, '');
    console.log(chalk.greenBright(`  [${completedCount}/${SAMPLES.length}] DONE ${sample.name}: Cell Ranger complete.`));
}

// # ============================================================================
// # Summary
// # ============================================================================

console.log(chalk.blueBright('\n========================================'));
console.log(chalk.blueBright(' Pipeline complete!'));
console.log(chalk.blueBright('========================================\n'));

for (const sample of SAMPLES) {
    const outDir = `${RESULTS_DIR}/${sample.name}/outs`;
    const webSummary = `${outDir}/web_summary.html`;
    const matrixDir = `${outDir}/filtered_feature_bc_matrix`;

    if (fs.existsSync(webSummary)) {
        const cells = fs.existsSync(matrixDir) ? chalk.green('✓ matrix') : chalk.red('✗ matrix');
        console.log(`  ${chalk.green('✓')} ${sample.name.padEnd(14)} ${chalk.gray(sample.group.padEnd(5))} -> ${outDir}`);
    } else {
        console.log(`  ${chalk.red('✗')} ${sample.name.padEnd(14)} ${chalk.gray(sample.group.padEnd(5))} -> NOT COMPLETE`);
    }
}

console.log(chalk.blueBright('\nRun info:'));
console.log(chalk.gray(`  cellranger count --transcriptome=${REFERENCE} ...`));
console.log(chalk.gray(`  Results: ${RESULTS_DIR}/`));
